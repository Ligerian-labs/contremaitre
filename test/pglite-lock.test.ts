import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import { startPglite } from "../packages/environments/src/pglite-server.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";

checkPgliteCleanup();

test("live owner blocks another process; SIGKILL releases ownership without losing committed data", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-owner-"));
  const dataDir = join(root, "db");
  // Keep the AF_UNIX path below the macOS path-length limit.
  const scratch = await mkdtemp("/tmp/cm-pglite-owner-");
  const child = Bun.spawn(
    [process.execPath, resolve("test/fixtures/pglite-compiled/lock-owner.ts"), dataDir],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: scratch } },
  );
  let server: Awaited<ReturnType<typeof startPglite>> | undefined;
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("lock owner ready");
    reader.releaseLock();
    let liveError: unknown;
    try {
      server = await startPglite({ dataDir, port: 48531 });
    } catch (error) {
      liveError = error;
    }
    expect(String(liveError)).toContain("data directory is locked");
    child.kill("SIGKILL");
    await child.exited;
    server = await startPglite({ dataDir, port: 48531 });
    const sql = new SQL(server.url(), { max: 1 });
    try {
      expect((await sql`SELECT id FROM durable_records`)[0].id).toBe(42);
    } finally {
      await sql.close();
    }
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await server?.stop();
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}, 30_000);
