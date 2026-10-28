import { expect, test } from "bun:test";
import { WadisServer } from "wadis";

// These reproduce the compatibility gaps without the worker or TCP bridge.
test("engine actively expires keys without GET", async () => {
  const engine = await WadisServer.new();
  try {
    await engine.call("SET", "expires", "value", "PX", "20");
    await Bun.sleep(500);
    expect(Buffer.from(await engine.call("DBSIZE")).toString()).toBe(":0\r\n");
  } finally {
    await engine.terminate();
  }
});

test("engine completes FLUSHDB and accepts a subsequent PING", async () => {
  const engine = await WadisServer.new();
  try {
    await engine.call("SET", "flush", "value");
    let output = Buffer.from(await engine.call("FLUSHDB"));
    output = Buffer.concat([output, Buffer.from(await engine.call("PING"))]);
    const deadline = performance.now() + 500;
    while (!output.includes("+PONG\r\n") && performance.now() < deadline) {
      await Bun.sleep(10);
      output = Buffer.concat([output, Buffer.from(await engine.call("PING"))]);
    }
    expect(output.toString()).toStartWith("+OK\r\n");
    expect(output.toString()).toContain("+PONG\r\n");
  } finally {
    await engine.terminate();
  }
});
