import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { connect as connectHTTP2 } from "node:http2";
import { request } from "node:https";
import { createConnection, createServer as createTCPServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type PeerCertificate } from "node:tls";
import { context, HubError } from "@contremaitre/execution/context";
import { attempt } from "@contremaitre/execution/effect";
import { run } from "@contremaitre/execution/process";
import { sleep } from "@contremaitre/execution/sleep";
import { startServer } from "@contremaitre/hub/server";
import { parseManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { localCertificates } from "@contremaitre/routing/certificates";
import { clientHello as parseHello, serveHttps } from "@contremaitre/routing/https";
import { closeServer, listen } from "@contremaitre/routing/proxy";
import { Cause, Effect, Exit, Option } from "effect";
import { commandFailure } from "../apps/cli/src/errors.js";
import { FakeRuntime } from "./fake-runtime.js";
import { httpsPortConflictFixture } from "./https-startup-fixture.js";

async function clientHello(servername?: string) {
  const capture = createTCPServer();
  const port = await new Promise<number>((resolve) =>
    capture.listen(0, "127.0.0.1", () => resolve((capture.address() as { port: number }).port)),
  );
  try {
    const first = new Promise<Buffer>((resolve) =>
      capture.once("connection", (socket) => socket.once("data", resolve)),
    );
    const client = connect({ host: "127.0.0.1", port, servername });
    client.on("error", () => {});
    const hello = await first;
    client.destroy();
    return hello;
  } finally {
    capture.close();
  }
}

/** Re-frames the first TLS record's payload as two records, split after `at` bytes. */
function splitRecord(data: Buffer, at: number) {
  const length = data.readUInt16BE(3),
    payload = data.subarray(5, 5 + length);
  const record = (part: Buffer) =>
    Buffer.concat([data.subarray(0, 3), Buffer.from([part.length >> 8, part.length & 255]), part]);
  return Buffer.concat([
    record(payload.subarray(0, at)),
    record(payload.subarray(at)),
    data.subarray(5 + length),
  ]);
}

/** Forwards connections to `port`, delivering the client's first chunk as separate writes. */
async function relay(port: number, pieces: (first: Buffer) => Buffer[]) {
  const server = createTCPServer((client) => {
    const upstream = createConnection({ host: "127.0.0.1", port });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.once("data", async (first: Buffer) => {
      client.pause();
      for (const piece of pieces(first)) {
        upstream.write(piece);
        await sleep(50, new AbortController().signal);
      }
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

test("ClientHello parsing finds the requested host across records and partial input", async () => {
  const hello = await clientHello("App.Example.localhost");
  expect(parseHello(hello)).toEqual({ complete: true, servername: "app.example.localhost" });
  expect(parseHello(await clientHello())).toEqual({ complete: true, servername: undefined });
  for (let size = 0; size < hello.length; size += 7)
    expect(parseHello(hello.subarray(0, size)).complete).toBe(false);
  for (const at of [1, 3, 40, 100])
    expect(parseHello(splitRecord(hello, at)).servername).toBe("app.example.localhost");
  expect(parseHello(splitRecord(hello, 40).subarray(0, 60)).complete).toBe(false);
  expect(parseHello(Buffer.from("GET / HTTP/1.1\r\n\r\n"))).toEqual({ complete: true });
});

test("HTTPS port conflicts remain typed failures with an actionable CLI message", async () => {
  const occupied = createTCPServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const address = occupied.address();
  if (!address || typeof address === "string") throw Error("Expected a TCP port");
  try {
    const result = await Effect.runPromiseExit(
      attempt(() =>
        serveHttps(
          address.port,
          () => {
            throw Error("A rejected listener cannot accept TLS connections");
          },
          { request: () => {}, upgrade: () => {} },
        ),
      ),
    );
    if (!Exit.isFailure(result)) throw Error("Expected an occupied-port failure");
    expect(commandFailure(result.cause)).toEqual({
      code: 1,
      text: `Local HTTPS port ${address.port} is already in use`,
    });
    const failure = Option.getOrThrow(Cause.failureOption(result.cause));
    expect(failure).toBeInstanceOf(HubError);
    expect(failure.classification).toBe("conflict");
    expect(failure.cause).toBeInstanceOf(Error);
    expect(failure.cause).toHaveProperty("code", "EADDRINUSE");
    expect(Cause.isDie(result.cause)).toBe(false);
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

test.skipIf(!Bun.which("mkcert"))(
  "HTTPS startup releases its socket and lock after a conflict and recovers on retry",
  async () => {
    const receipt = await httpsPortConflictFixture();
    expect(receipt.scenario).toBe("hub/https-port-conflict");
    expect(receipt.verified).toContain("failed startup releases the control socket and home lock");
  },
  30000,
);

test.skipIf(!Bun.which("mkcert"))(
  "The hub serves trusted HTTP/2 and HTTP/1.1 HTTPS, WebSockets and new hosts without restarting",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "cm-https-hub-"));
    const previousRoot = process.env.CAROOT;
    const caRoot = join(home, "ca");
    mkdirSync(caRoot);
    // Creating a disposable CA does not install it in any machine/browser trust store.
    await run(
      context(),
      [
        "mkcert",
        "-cert-file",
        join(home, "bootstrap.pem"),
        "-key-file",
        join(home, "bootstrap-key.pem"),
        "localhost",
      ],
      { env: { ...process.env, CAROOT: caRoot } },
    );
    process.env.CAROOT = caRoot;
    const ca = readFileSync(join(caRoot, "rootCA.pem"));
    const upstream = createServer((req, res) => {
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("first\n");
        setTimeout(() => res.end("second\n"), 300);
        return;
      }
      // Connection-specific headers that an HTTP/2 response must not carry.
      res.setHeader("connection", "keep-alive");
      res.setHeader("keep-alive", "timeout=5");
      res.setHeader("proxy-connection", "keep-alive");
      res.end(JSON.stringify(req.headers));
    });
    upstream.on("upgrade", (req, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      socket.on("data", (data) => socket.write(`${req.headers["x-forwarded-proto"]}:${data}`));
    });
    const up = await listen(upstream, 0);
    const reserve = createServer();
    const port = await listen(reserve, 0);
    await closeServer(reserve);
    let hub: Awaited<ReturnType<typeof startServer>> | undefined;
    const get = (host: string, path = "/", servername = host) =>
      new Promise<{ status: number; body: string; cert: PeerCertificate }>((resolve, reject) => {
        const req = request(
          { hostname: "127.0.0.1", port, servername, path, ca, agent: false, headers: { host } },
          (res) => {
            const cert = (res.socket as import("node:tls").TLSSocket).getPeerCertificate();
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body, cert }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    const get2 = (host: string, path = "/") =>
      new Promise<{ status: number; body: string; chunks: number[]; alpn?: string }>(
        (resolve, reject) => {
          const session = connectHTTP2(`https://127.0.0.1:${port}`, { ca, servername: host });
          session.on("error", reject);
          const stream = session.request({ ":path": path, ":authority": host });
          const started = Date.now(),
            chunks: number[] = [];
          let status = 0,
            body = "";
          stream.on("response", (headers) => {
            status = Number(headers[":status"]);
          });
          stream.on("data", (chunk) => {
            chunks.push(Date.now() - started);
            body += chunk;
          });
          stream.on("end", () => {
            const alpn = session.alpnProtocol;
            session.close();
            resolve({ status, body, chunks, alpn });
          });
          stream.on("error", reject);
          stream.end();
        },
      );
    async function eventually<T>(attempt: () => Promise<T>, accept: (value: T) => boolean) {
      let last: unknown;
      // A new route can require several sequential mkcert processes on the hosted runner.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const value = await attempt();
          if (accept(value)) return value;
          last = value;
        } catch (error) {
          last = error;
        }
        await sleep(100, new AbortController().signal);
      }
      throw Error(
        `Condition not reached: ${last instanceof Error ? String(last) : JSON.stringify(last)}`,
      );
    }
    try {
      const certificates = await localCertificates(context(), join(home, "issue"));
      const files = await certificates.certificate("app.example.localhost");
      const modified = statSync(files.certFile).mtimeMs;
      await certificates.certificate("app.example.localhost");
      expect(statSync(files.certFile).mtimeMs).toBe(modified);
      expect(statSync(files.keyFile).mode & 0o777).toBe(0o600);
      await expect(certificates.certificate("external.example.com")).rejects.toThrow(
        "Invalid local certificate hostname",
      );

      const hubHome = join(home, "hub");
      let idleTime = Date.now();
      hub = await startServer({
        home: hubHome,
        now: () => idleTime,
        port: 8080,
        httpsPort: port,
        runtime: new FakeRuntime(),
        skipSystemStart: true,
      });
      expect(hub.proxyPort).toBe(port);
      const status = await get("contremaitre.localhost");
      expect(status.status).toBe(200);
      expect(status.body).toContain("Contremaitre hub is running");
      expect(status.body).toContain("No local services are routed.");
      expect(status.cert.subjectaltname).toBe("DNS:contremaitre.localhost");
      expect((await get("unknown.localhost", "/", "localhost")).status).toBe(404);

      const identity = newIdentity("hub-test", home, "main");
      const manifest = parseManifest(
        `version: 1\nproject: hub-test\nservices:\n  web: {image: app, http: true, port: ${up}, ready: ["true"]}\n`,
      );
      await hub.manager.deploy(context(), {
        root: home,
        identity,
        request: { main: true },
        manifest,
      });
      const environment = hub.manager.resolve(identity.ID);
      environment.idle_timeout_seconds = 10;
      idleTime += 9000;
      const http1 = await eventually(
        () => get(identity.Host),
        (reply) => reply.status === 200,
      );
      expect(http1.cert.subjectaltname).toBe(`DNS:${identity.Host}`);
      expect(JSON.parse(http1.body)["x-forwarded-proto"]).toBe("https");
      expect(JSON.parse(http1.body).host).toBe(identity.Host);
      expect(environment.last_activity_at).toBe(new Date(idleTime).toISOString());

      idleTime += 1000;
      const http2 = await get2(identity.Host);
      expect(http2.alpn).toBe("h2");
      expect(http2.status).toBe(200);
      const forwarded = JSON.parse(http2.body);
      expect(forwarded.host).toBe(identity.Host);
      expect(forwarded["x-forwarded-proto"]).toBe("https");
      expect(Object.keys(forwarded).filter((key) => key.startsWith(":"))).toEqual([]);
      expect(environment.last_activity_at).toBe(new Date(idleTime).toISOString());
      const active = environment.last_activity_at;
      idleTime += 500;
      expect((await get("contremaitre.localhost")).status).toBe(200);
      expect((await get2("contremaitre.localhost")).status).toBe(200);
      // The status page lists environments without keeping them awake.
      expect(environment.last_activity_at).toBe(active);
      const streamed = await get2(identity.Host, "/stream");
      expect(streamed.body).toBe("first\nsecond\n");
      expect(streamed.chunks.length).toBeGreaterThan(1);
      expect(streamed.chunks[0]).toBeLessThan(250);

      const echoed = await new Promise<string>((resolve, reject) => {
        // Browsers offer only HTTP/1.1 for WebSocket connections.
        const options = { host: "127.0.0.1", port, servername: identity.Host, ca };
        const socket = connect({ ...options, ALPNProtocols: ["http/1.1"] }, () => {
          expect(socket.alpnProtocol).toBe("http/1.1");
          socket.write(
            `GET / HTTP/1.1\r\nHost: ${identity.Host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
          );
        });
        let upgraded = false,
          data = "";
        socket.setTimeout(2000, () => socket.destroy(Error(`TLS upgrade timed out: ${data}`)));
        socket.on("error", reject);
        socket.on("data", (chunk) => {
          data += chunk;
          if (!upgraded && data.includes("\r\n\r\n")) {
            expect(data).toContain("101 Switching Protocols");
            data = data.slice(data.indexOf("\r\n\r\n") + 4);
            upgraded = true;
            socket.write("ping");
          }
          if (upgraded && data) {
            socket.destroy();
            resolve(data);
          }
        });
      });
      expect(echoed).toBe("https:ping");

      const alias = await eventually(
        () => get("main.hub-test.localhost"),
        (reply) => reply.status === 200,
      );
      expect(alias.cert.subjectaltname).toBe("DNS:main.hub-test.localhost");
      // Clients may split the ClientHello across TCP writes and across TLS records.
      for (const pieces of [
        (first: Buffer) => [first.subarray(0, 3), first.subarray(3, 50), first.subarray(50)],
        (first: Buffer) => [splitRecord(first, 40)],
        (first: Buffer) => {
          const split = splitRecord(first, 40);
          return [split.subarray(0, 30), split.subarray(30)];
        },
      ]) {
        const fragmenting = await relay(port, pieces);
        try {
          const cert = await new Promise<PeerCertificate>((resolve, reject) => {
            const socket = connect(
              { host: "127.0.0.1", port: fragmenting.port, servername: identity.Host, ca },
              () => {
                resolve(socket.getPeerCertificate());
                socket.destroy();
              },
            );
            socket.on("error", reject);
          });
          expect(cert.subjectaltname).toBe(`DNS:${identity.Host}`);
        } finally {
          await new Promise<void>((resolve) => fragmenting.server.close(() => resolve()));
        }
      }
      const listing = await get("contremaitre.localhost");
      expect(listing.body).toContain(`https://${identity.Host}</a> online`);

      // A host deployed after startup gets its own certificate without a restart.
      const later = newIdentity("hub-test", home, "feature");
      await hub.manager.deploy(context(), { root: home, identity: later, request: {}, manifest });
      const added = await eventually(
        () => get(later.Host),
        (reply) => reply.status === 200,
      );
      expect(added.cert.subjectaltname).toBe(`DNS:${later.Host}`);

      idleTime += 10_000;
      await hub.idle.sweep();
      expect(environment.Status).toBe("stopped");
      expect((await get(identity.Host)).status).toBe(503);
      expect((await get("contremaitre.localhost")).body).toContain(
        `https://${identity.Host}</a> offline`,
      );
      await hub.close();
      hub = undefined;
      // Closing the hub releases the HTTPS port.
      const again = createServer();
      expect(await listen(again, port)).toBe(port);
      await closeServer(again);
    } finally {
      await hub?.close();
      await closeServer(upstream);
      if (previousRoot === undefined) delete process.env.CAROOT;
      else process.env.CAROOT = previousRoot;
      rmSync(home, { recursive: true, force: true });
    }
  },
  30000,
);
