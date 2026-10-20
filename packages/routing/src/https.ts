import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHTTP2Server, type ServerHttp2Session } from "node:http2";
import { createServer as createTCPServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createSecureContext, type SecureContext, TLSSocket } from "node:tls";
import { type Context, fail, HubError, isCode, message } from "@contremaitre/execution/context";
import { localCertificates } from "./certificates.js";
import { type ProxyRequest, type ProxyResponse, trackedServer } from "./proxy.js";

export const statusHost = "contremaitre.localhost";
// Bytes inspected for a ClientHello; a client sending more gets the default certificate.
const helloLimit = 32_768;

/**
 * Reassembles a TLS ClientHello from the handshake records at the start of a connection.
 * `complete` is false while more bytes are needed; non-TLS or malformed input is complete.
 */
export function clientHello(data: Buffer): { complete: boolean; servername?: string } {
  const parts: Buffer[] = [];
  let size = 0,
    at = 0;
  while (at + 5 <= data.length) {
    if (data[at] !== 22) return { complete: true };
    const length = data.readUInt16BE(at + 3);
    if (at + 5 + length > data.length) break;
    parts.push(data.subarray(at + 5, at + 5 + length));
    size += length;
    at += 5 + length;
    const handshake = Buffer.concat(parts, size);
    if (handshake.length < 4) continue;
    if (handshake[0] !== 1) return { complete: true };
    const total = 4 + handshake.readUIntBE(1, 3);
    if (handshake.length >= total)
      return { complete: true, servername: serverName(handshake.subarray(0, total)) };
  }
  return { complete: data.length > 0 && data[0] !== 22 };
}

/** Reads the SNI host name from a complete ClientHello handshake message. */
export function serverName(hello: Buffer): string | undefined {
  try {
    // Handshake header, client version and random.
    let at = 4 + 2 + 32;
    at += 1 + hello.readUInt8(at);
    at += 2 + hello.readUInt16BE(at);
    at += 1 + hello.readUInt8(at);
    const extensions = Math.min(hello.length, at + 2 + hello.readUInt16BE(at));
    at += 2;
    while (at + 4 <= extensions) {
      const type = hello.readUInt16BE(at),
        length = hello.readUInt16BE(at + 2);
      at += 4;
      if (type === 0) {
        // server_name: list length, name type 0 (host_name), name length, name.
        const size = hello.readUInt16BE(at + 3);
        if (hello.readUInt8(at + 2) !== 0 || 5 + size > length || at + 5 + size > extensions)
          return;
        return hello.toString("latin1", at + 5, at + 5 + size).toLowerCase();
      }
      at += length;
    }
  } catch {
    // Truncated or malformed messages select the default certificate.
  }
}

const html = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The hub's page at `https://contremaitre.localhost`: hub status and routed local URLs. */
export function statusPage(res: ProxyResponse, routes: { url: string; online: boolean }[]) {
  const items = routes.map(
    ({ url, online }) =>
      `<li><a href="${html(url)}">${html(url)}</a> ${online ? "online" : "offline"}</li>`,
  );
  const body = `<!doctype html><meta charset="utf-8"><title>Contremaitre</title>
<h1>Contremaitre hub is running</h1>
<p>Local HTTPS is served by the hub. Run <code>contremaitre list</code> for details.</p>
${items.length ? `<ul>\n${items.join("\n")}\n</ul>` : "<p>No local services are routed.</p>"}
`;
  // The HTTP/2 compatibility response implements this subset of ServerResponse.
  const out = res as ServerResponse;
  out.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  out.end(body);
}

export interface HttpsHandlers {
  request: (req: ProxyRequest, res: ProxyResponse) => void;
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

/**
 * Terminates TLS on a loopback port and serves HTTP/2 and HTTP/1.1 (with upgrades).
 * Bun drops ALPN for certificates chosen through SNICallback and ignores
 * setSecureContext, so each connection's certificate is chosen from its
 * ClientHello before the socket is wrapped.
 */
export async function serveHttps(
  port: number,
  certificate: (servername: string | undefined) => SecureContext,
  handlers: HttpsHandlers,
) {
  const http1 = trackedServer(handlers.request, handlers.upgrade);
  const http2 = createHTTP2Server(handlers.request);
  const sessions = new Set<ServerHttp2Session>();
  http2.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  const connections = new Set<Socket>();
  const track = (socket: Socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  const listener = createTCPServer((socket) => {
    track(socket);
    const timer = setTimeout(() => socket.destroy(), 10_000);
    socket.once("close", () => clearTimeout(timer));
    let hello = Buffer.alloc(0);
    const read = (chunk: Buffer) => {
      hello = Buffer.concat([hello, chunk]);
      const parsed = clientHello(hello);
      if (!parsed.complete && hello.length < helloLimit) return;
      socket.off("data", read);
      socket.pause();
      socket.unshift(hello);
      const secure = new TLSSocket(socket, {
        isServer: true,
        secureContext: certificate(parsed.servername),
        ALPNProtocols: ["h2", "http/1.1"],
      });
      track(secure);
      secure.once("close", () => socket.destroy());
      secure.once("secure", () => {
        clearTimeout(timer);
        (secure.alpnProtocol === "h2" ? http2 : http1).emit("connection", secure);
      });
    };
    socket.on("data", read);
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", (error) =>
      reject(
        isCode(error, "EADDRINUSE")
          ? new HubError({
              message: `Local HTTPS port ${port} is already in use`,
              classification: "conflict",
              cause: error,
            })
          : error,
      ),
    );
    listener.listen(port, "127.0.0.1", () => resolve());
  });
  const address = listener.address();
  if (!address || typeof address === "string") fail("Invalid listener address");
  return {
    port: address.port,
    close: async () => {
      const closed = new Promise<void>((resolve) => listener.close(() => resolve()));
      for (const session of sessions) session.destroy();
      for (const socket of connections) socket.destroy();
      await closed;
    },
  };
}

/** Serves local HTTPS with a mkcert certificate per routed host, issued as hosts appear. */
export async function startLocalHttps(
  parent: Context,
  home: string,
  port: number,
  hosts: () => string[],
  handlers: HttpsHandlers,
  failed: (error: Error) => void,
) {
  const cancelled = new AbortController();
  const ctx = { ...parent, signal: AbortSignal.any([parent.signal, cancelled.signal]) };
  const certificates = await localCertificates(ctx, home);
  const load = (files: { certFile: string; keyFile: string }) =>
    createSecureContext({
      cert: readFileSync(files.certFile),
      key: readFileSync(files.keyFile),
      minVersion: "TLSv1.2",
    });
  let fallback = load(certificates);
  let contexts = new Map<string, SecureContext>();
  let previous = "",
    dirty = false,
    stopped = false;
  let publishing: Promise<void> | undefined;
  async function publish() {
    do {
      dirty = false;
      const names = [...new Set([statusHost, ...hosts()])].sort();
      const signature = JSON.stringify(names);
      if (signature === previous) continue;
      const next = new Map<string, SecureContext>();
      const localhost = load(await certificates.certificate("localhost"));
      // Sequential issuance bounds mkcert processes even for a large recorded stack.
      for (const name of names) next.set(name, load(await certificates.certificate(name)));
      ctx.signal.throwIfAborted();
      fallback = localhost;
      contexts = next;
      previous = signature;
    } while (dirty && !stopped);
  }
  await publish();
  const listener = await serveHttps(port, (name) => contexts.get(name ?? "") ?? fallback, handlers);
  const update = () => {
    if (stopped) return;
    dirty = true;
    publishing ??= publish()
      .catch((error) => {
        if (!stopped) failed(Error(`Local HTTPS certificates failed: ${message(error)}`));
      })
      .finally(() => {
        publishing = undefined;
        if (dirty && !stopped) update();
      });
  };
  // Hourly checks renew certificates in their last 30 days of validity.
  const renewal = setInterval(() => {
    previous = "";
    update();
  }, 3600000);
  return {
    port: listener.port,
    update,
    close: async () => {
      stopped = true;
      clearInterval(renewal);
      cancelled.abort();
      await listener.close();
      await publishing?.catch(() => {});
    },
  };
}
