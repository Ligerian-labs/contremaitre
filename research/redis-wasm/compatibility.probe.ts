import { afterAll, beforeAll, expect, test } from "bun:test";
import { once } from "node:events";
import { createConnection } from "node:net";
import { Queue, QueueEvents, Worker } from "bullmq";
import Redis from "ioredis";
import { startServer } from "./server.ts";

let server: Awaited<ReturnType<typeof startServer>>;
const clients = new Set<Redis>();

function client() {
  const redis = new Redis({
    host: "127.0.0.1",
    port: server.port,
    lazyConnect: true,
    retryStrategy: () => null,
    connectTimeout: 2000,
    commandTimeout: 4000,
  });
  clients.add(redis);
  return redis;
}

beforeAll(async () => {
  server = await startServer();
});
afterAll(() => {
  for (const redis of clients) redis.disconnect();
  server?.stop();
});

test("ordinary TCP clients share data and preserve binary payloads and pipeline order", async () => {
  const a = client();
  const b = client();
  expect(await a.ping()).toBe("PONG");
  const payload = Buffer.from([0, 255, 13, 10, 128, 42, 36]);
  expect(await a.set("binary", payload)).toBe("OK");
  expect(await b.getBuffer("binary")).toEqual(payload);
  expect(
    await a.pipeline().set("counter", 0).incr("counter").incr("counter").get("counter").exec(),
  ).toEqual([
    [null, "OK"],
    [null, 1],
    [null, 2],
    [null, "2"],
  ]);
});

test("MULTI state belongs to one TCP connection", async () => {
  const a = client();
  const b = client();
  await Promise.all([a.connect(), b.connect()]);
  expect(await a.call("MULTI")).toBe("OK");
  expect(await a.call("SET", "transaction", "committed")).toBe("QUEUED");
  expect(await b.get("transaction")).toBeNull();
  expect(await b.ping()).toBe("PONG");
  expect(await a.call("EXEC")).toEqual(["OK"]);
  expect(await b.get("transaction")).toBe("committed");
});

test("Lua runs through EVALSHA with Redis cjson and cmsgpack libraries", async () => {
  const redis = client();
  const sha = await redis.script(
    "LOAD",
    "return cjson.decode(cmsgpack.unpack(cmsgpack.pack(ARGV[1]))).value",
  );
  expect(await redis.evalsha(String(sha), 0, '{"value":42}')).toBe(42);
});

test("subscriptions push messages and disconnect removes the subscriber", async () => {
  const subscriber = client();
  const publisher = client();
  await subscriber.subscribe("channel");
  const message = once(subscriber, "message");
  expect(await publisher.publish("channel", "hello")).toBe(1);
  expect(await message).toEqual(["channel", "hello"]);
  await subscriber.quit();
  expect(await publisher.publish("channel", "after-disconnect")).toBe(0);
});

test("BLPOP wakes after another client pushes and times out while idle", async () => {
  const blocker = client();
  const producer = client();
  const waiting = blocker.blpop("blocking-list", 2);
  // This PING also proves that a blocked client does not monopolize the engine.
  expect(await producer.ping()).toBe("PONG");
  await producer.rpush("blocking-list", "item");
  expect(await waiting).toEqual(["blocking-list", "item"]);
  const started = performance.now();
  expect(await blocker.blpop("blocking-timeout", 0.1)).toBeNull();
  expect(performance.now() - started).toBeGreaterThanOrEqual(70);
});

test("expiration advances without incoming commands", async () => {
  const redis = client();
  await redis.set("expiring", "value", "PX", 50);
  await Bun.sleep(150);
  expect(await redis.get("expiring")).toBeNull();
});

test("active expiration reclaims expired keys without reading them", async () => {
  const redis = client();
  await redis.select(15);
  await redis.set("active-expiration", "value", "PX", 50);
  await Bun.sleep(1000);
  expect(await redis.dbsize()).toBe(0);
});

test("FLUSHDB replies and leaves the client usable", async () => {
  const redis = client();
  await redis.select(14);
  await redis.set("flush", "value");
  expect(await redis.flushdb()).toBe("OK");
  expect(await redis.ping()).toBe("PONG");
  expect(await redis.get("flush")).toBeNull();
});

test("TCP accepts fragmented input and returns a large binary reply intact", async () => {
  const socket = createConnection({ host: "127.0.0.1", port: server.port });
  socket.on("error", () => {});
  try {
    await once(socket, "connect");
    const response = once(socket, "data");
    socket.write("*1\r\n$4\r\nPI");
    await Bun.sleep(10);
    socket.write("NG\r\n");
    expect((await response)[0]).toEqual(Buffer.from("+PONG\r\n"));
    const redis = client();
    const payload = Buffer.alloc(2 * 1024 * 1024, 255);
    await redis.set("large", payload);
    expect(await redis.getBuffer("large")).toEqual(payload);
  } finally {
    socket.destroy();
  }
});

test("long Lua execution does not block the parent event loop", async () => {
  const redis = client();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const result = await redis.eval("local n=0 for i=1,50000000 do n=n+i end return n", 0);
    expect(result).toBeGreaterThan(0);
    expect(ticks).toBeGreaterThan(2);
  } finally {
    clearInterval(timer);
  }
});

test("independent workers have independent stores", async () => {
  const other = await startServer();
  const redis = new Redis({ host: "127.0.0.1", port: other.port, retryStrategy: () => null });
  try {
    await client().set("isolation", "original");
    expect(await redis.get("isolation")).toBeNull();
    await redis.set("isolation", "other");
    expect(await client().get("isolation")).toBe("original");
  } finally {
    redis.disconnect();
    other.stop();
  }
});

test("stopping a worker closes its clients and replacement starts empty", async () => {
  const original = await startServer();
  const redis = new Redis({ host: "127.0.0.1", port: original.port, retryStrategy: () => null });
  redis.on("error", () => {});
  try {
    await redis.set("restart", "old");
    const closed = once(redis, "close");
    original.stop();
    await closed;
    const replacement = await startServer();
    const fresh = new Redis({
      host: "127.0.0.1",
      port: replacement.port,
      retryStrategy: () => null,
    });
    try {
      expect(await fresh.get("restart")).toBeNull();
    } finally {
      fresh.disconnect();
      replacement.stop();
    }
  } finally {
    redis.disconnect();
    original.stop();
  }
});

test("BullMQ processes ordinary and delayed jobs through real TCP connections", async () => {
  const name = "wasm-spike";
  const connection = { host: "127.0.0.1", port: server.port, retryStrategy: () => null };
  const queue = new Queue(name, { connection });
  const events = new QueueEvents(name, { connection });
  const worker = new Worker(name, async (job) => job.data.value * 2, { connection });
  const errors: Error[] = [];
  const onError = (error: Error) => errors.push(error);
  queue.on("error", onError);
  events.on("error", onError);
  worker.on("error", onError);
  try {
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady(), worker.waitUntilReady()]);
    const job = await queue.add("ordinary", { value: 21 });
    expect(await job.waitUntilFinished(events, 4000)).toBe(42);
    const delayed = await queue.add("delayed", { value: 7 }, { delay: 150 });
    expect(await delayed.waitUntilFinished(events, 4000)).toBe(14);
    expect(errors).toEqual([]);
  } finally {
    await worker.close(true);
    await events.close();
    await queue.close();
  }
});
