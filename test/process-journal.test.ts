import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context } from "../src/model.js";
import { reapProcesses, trackProcess } from "../src/process-journal.js";

test("reaps an interrupted owned group but leaves an unrelated process alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-process-journal-")),
    token = randomUUID();
  const owned = spawn("sleep", ["60"], {
      detached: true,
      env: { ...process.env, CONTREMAITRE_PROCESS_TOKEN: token },
      stdio: "ignore",
    }),
    other = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  try {
    if (!owned.pid || !other.pid) throw Error("missing pid");
    trackProcess(dir, owned.pid, token);
    await reapProcesses(context(), dir);
    expect(() => process.kill(owned.pid ?? 0, 0)).toThrow();
    expect(() => process.kill(other.pid ?? 0, 0)).not.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    owned.kill("SIGKILL");
    other.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
