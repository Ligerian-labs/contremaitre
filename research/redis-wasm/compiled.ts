import assert from "node:assert/strict";
import Redis from "ioredis";
import redisWasm from "./node_modules/wadis/dist/redis.wasm" with { type: "file" };
import { startServer } from "./server.ts";

// Wadis resolves redis.wasm next to import.meta.url. The probe build preserves
// that basename in Bun's embedded filesystem, including for the worker entrypoint.
assert(await Bun.file(redisWasm).exists(), "Embedded Redis Wasm asset is missing");
assert.match(redisWasm, /\$bunfs\//, "Redis asset must resolve in Bun's embedded filesystem");
const server = await startServer();
const client = new Redis({
  host: "127.0.0.1",
  port: server.port,
  retryStrategy: () => null,
  commandTimeout: 2000,
});
try {
  assert.equal(await client.ping(), "PONG");
  assert.equal(await client.eval("return cmsgpack.unpack(cmsgpack.pack(42))", 0), 42);
  assert.equal(await client.set("compiled", "value"), "OK");
  assert.equal(await client.get("compiled"), "value");
  console.log("Redis Wasm standalone probe passed");
} finally {
  client.disconnect();
  server.stop();
}
