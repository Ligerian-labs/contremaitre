import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { context } from "@contremaitre/execution/context";
import { SQL } from "bun";
import { forkPgliteData } from "../packages/environments/src/pglite-fork.js";
import { startPglite } from "../packages/environments/src/pglite-server.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";

checkPgliteCleanup();

async function failure(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "unexpected success";
  } catch (error) {
    return String(error);
  }
}

test("M1: primitive fork refuses a running locked source and a running locked target without quiesce", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-locked-fork-"));
  const source = join(root, "source"),
    target = join(root, "target");
  const from = await startPglite({ dataDir: source, port: 48544 });
  const to = await startPglite({ dataDir: target, port: 48545 });
  const sql = new SQL(to.url(), { max: 1 });
  try {
    await sql`CREATE TABLE preserved (id int)`;
    await sql`INSERT INTO preserved VALUES (42)`;
    expect(
      await failure(() => forkPgliteData({ source, target: join(root, "new"), ctx: context() })),
    ).toContain("locked");
    expect(existsSync(join(root, "new"))).toBe(false);
    await from.stop();
    expect(
      await failure(() => forkPgliteData({ source, target, ctx: context(), replace: true })),
    ).toContain("locked");
    expect((await sql`SELECT id FROM preserved`)[0].id).toBe(42);
  } finally {
    await sql.close({ timeout: 0 });
    await from.stop();
    await to.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("M10: concurrent process observes no missing target during repeated atomic replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-atomic-"));
  const source = join(root, "source"),
    target = join(root, "target"),
    stop = join(root, "stop");
  await mkdir(source);
  await mkdir(target);
  await writeFile(join(target, "old"), "old target");
  for (let i = 0; i < 40; i++) await writeFile(join(source, `data-${i}`), "new data");
  const observer = Bun.spawn(
    [process.execPath, resolve("test/fixtures/pglite-compiled/observe-target.ts"), target, stop],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = observer.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("observer ready");
    for (let i = 0; i < 20; i++)
      await forkPgliteData({ source, target, ctx: context(), replace: true, forceCopy: true });
    await writeFile(stop, "stop");
    const remaining = (async () => {
      let output = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
      return output;
    })();
    const [stdout, stderr, code] = await Promise.all([
      remaining,
      new Response(observer.stderr).text(),
      observer.exited,
    ]);
    expect(code, stderr).toBe(0);
    const result: { missing: number; observations: number } = JSON.parse(stdout.trim());
    expect(result.observations).toBeGreaterThan(0);
    expect(result.missing).toBe(0);
    expect(await readFile(join(target, "data-0"), "utf8")).toBe("new data");
  } finally {
    observer.kill("SIGKILL");
    await observer.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("V3-F1: crash between fallback renames restores the old database before start or fork", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-publish-"));
  const target = join(root, "target");
  let server = await startPglite({ dataDir: target, port: 48544 });
  try {
    const sql = new SQL(server.url(), { max: 1 });
    try {
      await sql`CREATE TABLE preserved AS SELECT 42 AS id`;
    } finally {
      await sql.close();
    }
    await server.stop();
    // This is the on-disk state after old->backup, before temporary->target.
    await rename(target, `${target}.pglite-previous`);
    // Manager can recreate an empty service directory before run.
    await mkdir(target);
    await writeFile(join(target, ".DS_Store"), "Finder metadata");
    await mkdir(`${target}.fork-interrupted`);
    await writeFile(`${target}.fork-interrupted/partial`, "unfinished copy");
    server = await startPglite({ dataDir: target, port: 48544 });
    const reopened = new SQL(server.url(), { max: 1 });
    try {
      expect((await reopened`SELECT id FROM preserved`)[0].id).toBe(42);
    } finally {
      await reopened.close();
    }
    await server.stop();
    expect(existsSync(`${target}.fork-interrupted`)).toBe(false);
    await rename(target, `${target}.pglite-previous`);
    await forkPgliteData({ source: target, target: join(root, "fork"), ctx: context() });
    expect(existsSync(join(target, "PG_VERSION"))).toBe(true);
    expect(existsSync(`${target}.pglite-previous`)).toBe(false);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Q11/V4-F2: publication failure restores the old target immediately and later forks remove orphan copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-rollback-"));
  const source = join(root, "source"),
    target = join(root, "target");
  try {
    await mkdir(source);
    await mkdir(target);
    await writeFile(join(source, "new"), "new");
    await writeFile(join(target, "old"), "old");
    await mkdir(`${target}.fork-killed`);
    await writeFile(`${target}.fork-killed/partial`, "partial");
    await expect(
      forkPgliteData({
        source,
        target,
        replace: true,
        forceCopy: true,
        ctx: context(),
        publication: {
          exchange: () => false,
          afterBackup: async () => {
            throw new Error("injected publication failure");
          },
        },
      }),
    ).rejects.toThrow("injected publication failure");
    // No start/recovery call between the failure and these assertions.
    expect(await readFile(join(target, "old"), "utf8")).toBe("old");
    expect(existsSync(`${target}.pglite-previous`)).toBe(false);
    expect(existsSync(`${target}.fork-killed`)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
