import { expect, test } from "bun:test";
import { createServer, request } from "node:http";
import { closeServer, listen, proxyServer } from "@contremaitre/routing/proxy";

function get(port: number, host: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/hello",
        headers: {
          host,
          "x-forwarded-for": "spoofed",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "evil",
          forwarded: "for=evil",
        },
        agent: false,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
test("proxy distinguishes offline routes and replaces spoofed forwarding headers", async () => {
  const upstream = createServer((req, res) => res.end(JSON.stringify(req.headers))),
    up = await listen(upstream, 0);
  const proxy = proxyServer((host) =>
      host === "app.localhost"
        ? { upstream: `http://127.0.0.1:${up}` }
        : host === "offline.localhost"
          ? { upstream: "" }
          : undefined,
    ),
    port = await listen(proxy, 0);
  try {
    expect((await get(port, "unknown.localhost")).status).toBe(404);
    expect((await get(port, "offline.localhost")).status).toBe(503);
    const res = await get(port, "app.localhost");
    expect(res.status).toBe(200);
    const headers = JSON.parse(res.body);
    expect(headers.host).toBe("app.localhost");
    expect(headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(headers["x-forwarded-proto"]).toBe("http");
    expect(headers.forwarded).toBeUndefined();
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }
});
test("WebSocket upgrades carry bytes in both directions and shutdown closes connections", async () => {
  const upstream = createServer();
  upstream.on("upgrade", (_req, socket, head) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    if (head.length) socket.write(head);
    socket.on("data", (data) => socket.write(data));
  });
  const up = await listen(upstream, 0),
    proxy = proxyServer(() => ({ upstream: `http://127.0.0.1:${up}` })),
    port = await listen(proxy, 0);
  try {
    await new Promise<void>((resolve, reject) => {
      const req = request({
        hostname: "127.0.0.1",
        port,
        headers: { host: "app.localhost", connection: "Upgrade", upgrade: "websocket" },
        agent: false,
      });
      const timeout = setTimeout(() => reject(Error("upgrade timed out")), 1000);
      req.on("upgrade", (_res, socket) => {
        socket.once("data", (data) => {
          expect(data.toString()).toBe("ping");
          clearTimeout(timeout);
          socket.destroy();
          resolve();
        });
        socket.write("ping");
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }
});
