import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { context } from "@contremaitre/execution/context";
import { closeServer, listen, tcpProxy } from "@contremaitre/routing/proxy";

test("TCP forwarding delivers the first request and upstream response", async () => {
  const upstream = createServer((_req, res) => res.end("forwarded"));
  const upstreamPort = await listen(upstream, 0);
  const controller = new AbortController();
  let ready!: (port: number) => void;
  const listening = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const proxy = tcpProxy(
    context(controller.signal),
    0,
    upstreamPort,
    async () => "127.0.0.1",
    ready,
  );
  try {
    const port = await listening;
    const response = await fetch(`http://127.0.0.1:${port}`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("forwarded");
  } finally {
    controller.abort();
    await proxy;
    await closeServer(upstream);
  }
});
test("TCP source filtering refuses a client before resolving or connecting its upstream", async () => {
  const controller = new AbortController();
  const listening = Promise.withResolvers<number>();
  let resolved = false;
  const proxy = tcpProxy(
    context(controller.signal),
    0,
    80,
    async () => {
      resolved = true;
      return "127.0.0.1";
    },
    listening.resolve,
    { host: "0.0.0.0", allow: () => false },
  );
  try {
    const port = await listening.promise;
    await new Promise<void>((done) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.on("error", () => {});
      socket.once("close", () => done());
    });
    expect(resolved).toBe(false);
  } finally {
    controller.abort();
    await proxy;
  }
});
