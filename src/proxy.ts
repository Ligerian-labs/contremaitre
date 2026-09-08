import { createServer, type IncomingMessage, request, type Server } from "node:http";
import { createConnection, createServer as createTCPServer, type Socket } from "node:net";
import { type Context, fail } from "./model.js";

const sockets = new WeakMap<Server, Set<Socket>>();
export interface Route {
  upstream: string;
  publicHost?: string;
}
export type Lookup = (host: string) => Route | undefined;
const hopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
export function forwardedHeaders(req: IncomingMessage, route: Route, upgrade = false) {
  const headers = { ...req.headers };
  for (const key of Object.keys(headers))
    if (key === "forwarded" || key.startsWith("x-forwarded-")) delete headers[key];
  for (const token of String(req.headers.connection ?? "").split(","))
    delete headers[token.trim().toLowerCase()];
  for (const key of hopHeaders) delete headers[key];
  headers.host = route.publicHost || req.headers.host;
  headers["x-forwarded-host"] = headers.host;
  headers["x-forwarded-proto"] = route.publicHost ? "https" : "http";
  headers["x-forwarded-for"] = req.socket.remoteAddress ?? "127.0.0.1";
  if (upgrade) {
    headers.connection = "Upgrade";
    headers.upgrade = req.headers.upgrade;
  }
  return headers;
}
export function proxyServer(lookup: Lookup, fixed?: () => Route | undefined): Server {
  const select = (req: IncomingMessage) =>
    fixed
      ? fixed()
      : lookup((req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, ""));
  const server = createServer((req, res) => {
    const route = select(req);
    if (!route) {
      res.writeHead(404);
      res.end("Unknown environment\n");
      return;
    }
    if (!route.upstream) {
      res.writeHead(503);
      res.end("Environment is offline\n");
      return;
    }
    const target = new URL(route.upstream),
      up = request(
        {
          hostname: target.hostname.replace(/^\[|\]$/g, ""),
          port: target.port || 80,
          path: req.url,
          method: req.method,
          headers: forwardedHeaders(req, route),
          agent: false,
        },
        (reply) => {
          clearTimeout(headersDeadline);
          const headers = { ...reply.headers };
          for (const token of String(reply.headers.connection ?? "").split(","))
            delete headers[token.trim().toLowerCase()];
          for (const key of hopHeaders) delete headers[key];
          res.writeHead(reply.statusCode ?? 502, headers);
          reply.pipe(res);
          reply.on("error", () => res.destroy());
        },
      );
    const headersDeadline = setTimeout(
      () => up.destroy(new Error("Upstream headers timeout")),
      60_000,
    );
    up.on("socket", (socket) => {
      const timer = setTimeout(() => socket.destroy(), 5000);
      socket.once("connect", () => clearTimeout(timer));
      socket.once("close", () => clearTimeout(timer));
    });
    up.on("error", () => {
      clearTimeout(headersDeadline);
      if (!res.headersSent) res.writeHead(502);
      res.end("Upstream unavailable\n");
    });
    res.on("close", () => {
      clearTimeout(headersDeadline);
      up.destroy();
    });
    req.pipe(up);
  });
  const clients = new Set<Socket>();
  sockets.set(server, clients);
  server.on("connection", (socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    const route = select(req);
    if (!route?.upstream) {
      socket.end(`HTTP/1.1 ${route ? 503 : 404} Unavailable\r\nConnection: close\r\n\r\n`);
      return;
    }
    const target = new URL(route.upstream),
      up = request({
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port || 80,
        path: req.url,
        method: req.method,
        headers: forwardedHeaders(req, route, true),
        agent: false,
      });
    const timer = setTimeout(() => up.destroy(), 10_000);
    up.on("upgrade", (reply, remote, upHead) => {
      clearTimeout(timer);
      socket.write(
        `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n${Object.entries(reply.headers)
          .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${x}\r\n`))
          .join("")}\r\n`,
      );
      if (upHead.length) socket.write(upHead);
      if (head.length) remote.write(head);
      remote.pipe(socket);
      socket.pipe(remote);
      socket.on("close", () => remote.destroy());
      remote.on("close", () => socket.destroy());
      socket.on("error", () => remote.destroy());
      remote.on("error", () => socket.destroy());
    });
    up.on("response", (reply) => {
      reply.resume();
      socket.destroy();
    });
    up.on("error", () => {
      clearTimeout(timer);
      socket.destroy();
    });
    socket.on("close", () => {
      clearTimeout(timer);
      up.destroy();
    });
    up.end();
  });
  return server;
}
export async function listen(server: Server, port: number, host = "127.0.0.1") {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") fail("Invalid listener address");
  return address.port;
}
export async function closeServer(server: Server) {
  for (const socket of sockets.get(server) ?? []) socket.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
export async function tcpProxy(
  ctx: Context,
  local: number,
  remote: number,
  target: () => Promise<string>,
  ready: (port: number) => void,
) {
  const connections = new Set<Socket>();
  const server = createTCPServer({ allowHalfOpen: true }, (socket) => {
    if (connections.size >= 256) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => socket.destroy());
    void target()
      .then((host) => {
        if (ctx.signal.aborted || socket.destroyed) {
          socket.destroy();
          return;
        }
        const up = createConnection({ host, port: remote, allowHalfOpen: true });
        connections.add(up);
        const timer = setTimeout(() => up.destroy(), 5000);
        up.once("connect", () => {
          clearTimeout(timer);
          socket.pipe(up);
          up.pipe(socket);
        });
        up.on("error", () => socket.destroy());
        up.on("close", () => {
          clearTimeout(timer);
          connections.delete(up);
          socket.destroy();
        });
        socket.on("close", () => up.destroy());
      })
      .catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(local, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address && typeof address !== "string") ready(address.port);
  await new Promise<void>((resolve) => {
    const abort = () => {
      for (const socket of connections) socket.destroy();
      server.close(() => resolve());
    };
    ctx.signal.addEventListener("abort", abort, { once: true });
    if (ctx.signal.aborted) abort();
  });
}
