import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context } from "../src/model.js";
import { run } from "../src/process.js";

test("streams output, bounds capture, and preserves exit failures", async () => {
  const seen: string[] = [];
  await run(context(), ["/bin/sh", "-c", "printf first; printf second >&2"], {
    stdout: (b) => seen.push(b.toString()),
    stderr: (b) => seen.push(b.toString()),
  });
  expect(seen.join("")).toContain("first");
  expect(seen.join("")).toContain("second");
  const output = await run(context(), ["/bin/sh", "-c", "printf 123456789"], { maxOutput: 4 });
  expect(output.toString()).toBe("1234");
  await expect(run(context(), ["/bin/sh", "-c", "exit 7"])).rejects.toThrow("exit 7");
});
test("cancels a whole subprocess group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-process-")),
    pidfile = join(dir, "child");
  const abort = new AbortController();
  try {
    const result = run(context(abort.signal), [
      "/bin/sh",
      "-c",
      'sleep 100 & echo $! > "$1"; wait',
      "sh",
      pidfile,
    ]);
    for (let i = 0; i < 100 && !existsSync(pidfile); i++) await Bun.sleep(10);
    const pid = Number(readFileSync(pidfile, "utf8"));
    abort.abort();
    await expect(result).rejects.toThrow("cancelled");
    await Bun.sleep(50);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
