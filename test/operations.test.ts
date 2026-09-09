import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "@contremaitre/execution/sleep";
import { Operations } from "@contremaitre/operations/operations";

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

test("deployment logs preserve output beyond the old limit, including the final error", async () => {
  const f = fixture();
  try {
    const ops = new Operations(f.home);
    const payload = "x".repeat(4 * 1024 * 1024 + 100);
    const op = ops.submit("env", "deploy", ["env"], async (ctx) => {
      ctx.log(payload);
      ctx.log("\nFINAL ERROR\n");
      throw Error("failed at end");
    });
    await ops.wait(op.id);
    let offset = 0,
      output = "";
    while (true) {
      const chunk = ops.read(op.id, offset);
      if (!chunk.output) break;
      offset = chunk.offset;
      output += Buffer.from(chunk.output, "base64").toString();
    }
    expect(output.includes(payload)).toBe(true);
    expect(output).toContain("FINAL ERROR");
  } finally {
    f.clean();
  }
});

test("latest deployment ignores other operations and a later success does not expose old failures", async () => {
  const f = fixture();
  try {
    const ops = new Operations(f.home);
    const failed = ops.submit("env", "deploy", ["env"], async () => {
      throw Error("old failure");
    });
    await ops.wait(failed.id);
    const succeeded = ops.submit("env", "deploy", ["env"], async () => {});
    await ops.wait(succeeded.id);
    const down = ops.submit("env", "down", ["env"], async () => {});
    await ops.wait(down.id);
    const other = ops.submit("other", "deploy", ["other"], async () => {});
    await ops.wait(other.id);
    const restarted = new Operations(f.home);
    expect(restarted.latestDeployment("env").id).toBe(succeeded.id);
    expect(restarted.read(succeeded.id, 0, 65536, { failure: true }).output).toBe("");
  } finally {
    f.clean();
  }
});

test("retention deletes complete logs and their service copies together", async () => {
  const { existsSync } = await import("node:fs");
  const f = fixture();
  try {
    const ops = new Operations(f.home, 2, 64, 1);
    const first = ops.submit("env", "deploy", ["env"], async (ctx) => {
      ctx.log("data", "web");
    });
    await ops.wait(first.id);
    const second = ops.submit("env", "deploy", ["env"], async () => {});
    await ops.wait(second.id);
    expect(ops.list().map((op) => op.id)).toEqual([second.id]);
    expect(existsSync(join(f.home, "operations", `${first.id}.logs`))).toBe(false);
    expect(existsSync(join(f.home, "operations", `${first.id}.log`))).toBe(false);
  } finally {
    f.clean();
  }
});
