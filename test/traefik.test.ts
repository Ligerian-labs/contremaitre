import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { context } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";
import { sleep } from "@contremaitre/execution/sleep";
import { startServer } from "@contremaitre/hub/server";
import { parseManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { localCertificates } from "@contremaitre/routing/certificates";
import { closeServer, listen } from "@contremaitre/routing/proxy";
import { type LocalRoute, startTraefik, traefikConfiguration } from "@contremaitre/routing/traefik";
import { FakeRuntime } from "./fake-runtime.js";

test("Traefik configuration preserves offline routes as unavailable services", () => {
  const config = traefikConfiguration([{ host: "app.example.localhost", upstream: "" }], []);
  expect(Object.values(config.http?.services ?? {})).toEqual([
    { loadBalancer: { passHostHeader: true, servers: [] } },
  ]);
  expect(Object.values(config.http.routers)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        rule: "Host(`app.example.localhost`)",
        tls: {},
        entryPoints: ["websecure"],
      }),
    ]),
  );
});

test.skipIf(!Bun.which("traefik") || !Bun.which("mkcert"))(
  "Traefik serves trusted HTTPS, reloads routes and proxies secure WebSockets",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "cm-traefik-"));
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
    const upstream = createServer((req, res) => res.end(JSON.stringify(req.headers)));
    upstream.on("upgrade", (req, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      socket.on("data", () => socket.write(String(req.headers["x-forwarded-proto"])));
    });
    const up = await listen(upstream, 0);
    const reserve = createServer();
    const port = await listen(reserve, 0);
    await closeServer(reserve);
    let routes: LocalRoute[] = [];
    let failure: Error | undefined;
    let traefikLog = "";
    let proxy: Awaited<ReturnType<typeof startTraefik>> | undefined;
    let hub: Awaited<ReturnType<typeof startServer>> | undefined;
    const get = (host: string, servername = host, path = "/") =>
      new Promise<{ status: number; body: string; location?: string }>((resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            servername,
            path,
            ca,
            agent: false,
            headers: { host, "x-forwarded-proto": "http" },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body, location: res.headers.location }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
    async function eventually(host: string, status: number, servername = host, path = "/") {
      let last: unknown;
      // A new route can require several sequential mkcert processes on the hosted runner.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const reply = await get(host, servername, path);
          if (reply.status === status) return reply;
          last = reply;
        } catch (error) {
          last = error;
        }
        await sleep(100, new AbortController().signal);
      }
      throw Error(
        `Route ${host}${path} did not reach ${status}: ${last instanceof Error ? String(last) : JSON.stringify(last)}\n${traefikLog}`,
      );
    }
    try {
      const certificates = await localCertificates(context(), home);
      const files = await certificates.certificate("app.example.localhost");
      const modified = statSync(files.certFile).mtimeMs;
      await certificates.certificate("app.example.localhost");
      expect(statSync(files.certFile).mtimeMs).toBe(modified);
      expect(statSync(files.keyFile).mode & 0o777).toBe(0o600);
      await expect(certificates.certificate("external.example.com")).rejects.toThrow(
        "Invalid local certificate hostname",
      );
      proxy = await startTraefik(
        context(undefined, (data) => {
          traefikLog += typeof data === "string" ? data : Buffer.from(data).toString();
        }),
        home,
        port,
        () => routes,
        (error) => {
          failure = error;
        },
      );
      const dashboardHost = "contremaitre.localhost";
      const redirect = await eventually(dashboardHost, 301);
      expect(redirect.location).toBe(`https://${dashboardHost}/dashboard/`);
      const dashboard = await get(dashboardHost, dashboardHost, "/dashboard/");
      expect(dashboard.status).toBe(200);
      expect(dashboard.body.toLowerCase()).toContain("<html");
      const api = await get(dashboardHost, dashboardHost, "/api/http/routers");
      expect(api.status).toBe(200);
      expect(JSON.parse(api.body)).toEqual(
        expect.arrayContaining([expect.objectContaining({ service: "api@internal" })]),
      );
      expect((await get("unknown.localhost", dashboardHost, "/api/http/routers")).status).toBe(404);
      const staticConfig = JSON.parse(readFileSync(join(home, "traefik/static.yml"), "utf8"));
      expect(staticConfig.api.insecure).not.toBe(true);
      expect(staticConfig.entryPoints).toEqual({
        websecure: { address: `127.0.0.1:${port}` },
      });
      routes = [{ host: "app.example.localhost", upstream: `http://127.0.0.1:${up}` }];
      proxy.update();
      const result = await eventually("app.example.localhost", 200);
      expect(JSON.parse(result.body)["x-forwarded-proto"]).toBe("https");
      expect(JSON.parse(result.body).host).toBe("app.example.localhost");
      const scheme = await new Promise<string>((resolve, reject) => {
        const socket = connect(
          { host: "127.0.0.1", port, servername: "app.example.localhost", ca },
          () => {
            socket.write(
              "GET / HTTP/1.1\r\nHost: app.example.localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
            );
          },
        );
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
      expect(scheme).toBe("wss");
      routes = [
        { host: "app.example.localhost", upstream: "" },
        { host: "worker.app.example.localhost", upstream: `http://127.0.0.1:${up}` },
      ];
      proxy.update();
      await eventually("app.example.localhost", 503);
      await eventually("worker.app.example.localhost", 200);
      routes = [routes[1]];
      proxy.update();
      await eventually("app.example.localhost", 404, "worker.app.example.localhost");
      routes = [];
      proxy.update();
      await eventually("worker.app.example.localhost", 404, dashboardHost);
      expect((await get(dashboardHost, dashboardHost, "/dashboard/")).status).toBe(200);
      expect(failure).toBeUndefined();
      await proxy.close();
      proxy = undefined;
      const hubHome = join(home, "hub");
      hub = await startServer({
        home: hubHome,
        port: 8080,
        httpsPort: port,
        runtime: new FakeRuntime(),
        skipSystemStart: true,
      });
      const identity = newIdentity("hub-test", home, "main");
      await hub.manager.deploy(context(), {
        root: home,
        identity,
        request: { main: true },
        manifest: parseManifest(
          `version: 1\nproject: hub-test\nservices:\n  web: {image: app, http: true, port: ${up}, ready: ["true"]}\n`,
        ),
      });
      await eventually(identity.Host, 200);
      await eventually("main.hub-test.localhost", 200);
      await hub.manager.down(context(), hub.manager.resolve(identity.ID));
      await eventually(identity.Host, 503);
      const records = readdirSync(join(hubHome, "processes")).filter((name) =>
        name.endsWith(".json"),
      );
      expect(records.length).toBe(1);
      const record = JSON.parse(readFileSync(join(hubHome, "processes", records[0]), "utf8"));
      process.kill(record.pid, "SIGKILL");
      for (let i = 0; i < 50 && !hub.closed; i++) await sleep(100, new AbortController().signal);
      expect(hub.closed).toBe(true);
    } finally {
      await hub?.close();
      await proxy?.close();
      await closeServer(upstream);
      if (previousRoot === undefined) delete process.env.CAROOT;
      else process.env.CAROOT = previousRoot;
      rmSync(home, { recursive: true, force: true });
    }
  },
  30000,
);
