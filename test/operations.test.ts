import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Operations } from "../src/operations.js";
import { sleep } from "../src/process.js";

const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "cm-ops-"));
  return { home, clean: () => rmSync(home, { recursive: true, force: true }) };
};
test("duplicate deploy has one durable operation and logs survive reconnect/restart", async () => {
  const f = fixture();
  try {
    const ops = new Operations(f.home);
    let calls = 0;
    const op = ops.submit("env", "deploy", ["env"], async (ctx) => {
      calls++;
      ctx.log("hello\n");
      await sleep(20, ctx.signal);
      ctx.log("done\n");
    });
    expect(
      ops.submit("env", "deploy", ["env"], async () => {
        throw Error("duplicate");
      }).id,
    ).toBe(op.id);
    expect((await ops.wait(op.id)).status).toBe("succeeded");
    expect(calls).toBe(1);
    const first = ops.read(op.id, 0, 10),
      next = ops.read(op.id, first.offset);
    expect(
      Buffer.from(first.output, "base64").toString() +
        Buffer.from(next.output, "base64").toString(),
    ).toContain("hello\ndone");
    const restarted = new Operations(f.home);
    expect(restarted.get(op.id).status).toBe("succeeded");
    expect(restarted.read(op.id).output).toBe(ops.read(op.id).output);
  } finally {
    f.clean();
  }
});
test("bounded concurrency, queued cancellation and source exclusion", async () => {
  const f = fixture();
  try {
    const ops = new Operations(f.home, 2);
    let active = 0,
      peak = 0;
    const work = async (ctx: Parameters<Parameters<Operations["submit"]>[3]>[0]) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await sleep(40, ctx.signal);
      } finally {
        active--;
      }
    };
    const a = ops.submit("a", "deploy", ["a", "main"], work);
    const b = ops.submit("b", "deploy", ["b", "main"], work);
    const c = ops.submit("c", "deploy", ["c"], work);
    const d = ops.submit("d", "deploy", ["d"], async () => {
      throw Error("cancelled job ran");
    });
    await ops.cancel(d.id);
    await Promise.all([a, b, c].map((x) => ops.wait(x.id)));
    expect(peak).toBe(2);
    expect(ops.get(d.id).status).toBe("cancelled");
    expect([a, b, c].every((x) => ops.get(x.id).status === "succeeded")).toBe(true);
  } finally {
    f.clean();
  }
});
