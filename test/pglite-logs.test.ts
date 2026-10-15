import { expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context } from "@contremaitre/execution/context";
import { removePgliteData } from "../packages/environments/src/pglite-data.js";
import {
  appendPgliteLog,
  PgliteLogWriter,
  readPgliteLog,
  tailPgliteLog,
} from "../packages/environments/src/pglite-logs.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";

checkPgliteCleanup();

test("V4-F3/F4: log follow uses byte positions across rotation, skips history, and deletion removes logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-log-tail-"));
  const data = join(root, "db"),
    path = `${data}.pglite-log`;
  await mkdir(data);
  const cancel = new AbortController();
  let output = "";
  appendPgliteLog(path, "old deployment\n");
  const follower = tailPgliteLog(
    context(cancel.signal, (bytes) => {
      output += String(bytes);
    }),
    path,
    true,
  ).catch((error) => {
    if (!cancel.signal.aborted) throw error;
  });
  let expected = "";
  try {
    for (let batch = 0; batch < 10; batch++) {
      const lines = Array.from(
        { length: 30 },
        (_, n) => `line-${batch}-${n}: ${"é".repeat(250)}\n`,
      ).join("");
      expected += lines;
      appendPgliteLog(path, lines);
      const deadline = Date.now() + 3000;
      while (!output.endsWith(`line-${batch}-29: ${"é".repeat(250)}\n`) && Date.now() < deadline)
        await Bun.sleep(10);
      expect(output).toBe(expected);
    }
    expect(output).not.toContain("old deployment");
    const tail = readPgliteLog(path);
    expect(tail.start).toBeGreaterThan(0);
    expect(tail.text).toMatch(/^line-\d+-\d+: /);
    expect(tail.text.endsWith("\n")).toBe(true);
    expect((await stat(path)).size).toBeLessThanOrEqual(65536);
    let snapshot = "";
    await tailPgliteLog(
      context(undefined, (bytes) => {
        snapshot += String(bytes);
      }),
      path,
      false,
    );
    expect(snapshot).toBe(tail.text);
    // A replacement file has a new generation and no stale byte offset.
    await rm(path);
    appendPgliteLog(path, "new generation\n");
    const deadline = Date.now() + 3000;
    while (!output.endsWith("new generation\n") && Date.now() < deadline) await Bun.sleep(10);
    expect(output).toBe(`${expected}new generation\n`);
  } finally {
    cancel.abort();
    await follower;
  }
  try {
    await Bun.write(`${path}.corrupt`, "old bad log");
    await removePgliteData(data);
    expect(await Bun.file(`${path}.corrupt`).exists()).toBe(false);
    expect(await Bun.file(path).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("V5-F4/F5: runtime log writer batches a burst and follows from the prelaunch cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-log-batch-"));
  const path = join(root, "db.pglite-log");
  appendPgliteLog(path, "old launch\n");
  const writer = new PgliteLogWriter(path),
    cursor = writer.cursor();
  const writes = spyOn(fs, "writeFile");
  const cancel = new AbortController();
  let follower: Promise<void> | undefined;
  try {
    for (let n = 0; n < 1000; n++) writer.append(`current launch ${n}\n`);
    expect(writes).toHaveBeenCalledTimes(0);
    await writer.flush();
    expect(writes).toHaveBeenCalledTimes(1);
    let output = "";
    follower = tailPgliteLog(
      context(cancel.signal, (bytes) => {
        output += String(bytes);
      }),
      path,
      true,
      cursor,
    ).catch((error) => {
      if (!cancel.signal.aborted) throw error;
    });
    expect(output).not.toContain("old launch");
    expect(output.match(/current launch/g)?.length).toBe(1000);
    writer.append("final stop line\n");
    await writer.close();
    expect(writes).toHaveBeenCalledTimes(2);
    expect(readPgliteLog(path).text).toContain("final stop line\n");
  } finally {
    cancel.abort();
    await follower;
    await writer.close();
    writes.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
