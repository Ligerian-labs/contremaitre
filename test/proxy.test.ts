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
test("tunnels reach host-restricted apps and preserve the public forwarding origin", async () => {
  const localHost = "app.localhost:8443";
  const upstream = createServer((req, res) => {
    if (req.headers.host !== localHost) {
      res.writeHead(403);
      res.end("Blocked request. This host is not allowed.");
      return;
    }
    res.end(JSON.stringify(req.headers));
  });
  const up = await listen(upstream, 0),
    publicHost = "app.preview.example.com",
    proxy = proxyServer(
      () => undefined,
      () => ({ upstream: `http://127.0.0.1:${up}`, publicHost, localHost }),
    ),
    port = await listen(proxy, 0);
  try {
    const res = await get(port, publicHost);
    expect(res.status).toBe(200);
    const headers = JSON.parse(res.body);
    expect(headers.host).toBe(localHost);
    expect(headers["x-forwarded-host"]).toBe(publicHost);
    expect(headers["x-forwarded-proto"]).toBe("https");
    expect(headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(headers.forwarded).toBeUndefined();
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }
});
test("tunnel WebSockets use the local Host and retain the browser Origin", async () => {
  const localHost = "app.localhost:8443";
  let received: import("node:http").IncomingHttpHeaders | undefined;
  const upstream = createServer();
  upstream.on("upgrade", (req, socket) => {
    received = req.headers;
    if (req.headers.host !== localHost) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.on("data", (data) => socket.write(data));
  });
  const up = await listen(upstream, 0),
    publicHost = "app.preview.example.com",
    proxy = proxyServer(
      () => undefined,
      () => ({ upstream: `http://127.0.0.1:${up}`, publicHost, localHost }),
    ),
    port = await listen(proxy, 0);
  try {
    await new Promise<void>((resolve, reject) => {
      const req = request({
        hostname: "127.0.0.1",
        port,
        headers: {
          host: publicHost,
          origin: `https://${publicHost}`,
          "x-forwarded-host": "evil.example",
          connection: "Upgrade",
          upgrade: "websocket",
        },
        agent: false,
      });
      req.setTimeout(1000, () => req.destroy(Error("upgrade timed out")));
      req.on("upgrade", (_res, socket) => {
        socket.setTimeout(1000, () => socket.destroy(Error("echo timed out")));
        socket.on("error", reject);
        socket.once("data", (data) => {
          socket.destroy();
          if (data.toString() === "ping") resolve();
          else reject(Error("WebSocket echo changed"));
        });
        socket.write("ping");
      });
      req.on("error", reject);
      req.end();
    });
    expect(received?.host).toBe(localHost);
    expect(received?.origin).toBe(`https://${publicHost}`);
    expect(received?.["x-forwarded-host"]).toBe(publicHost);
    expect(received?.["x-forwarded-proto"]).toBe("https");
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
