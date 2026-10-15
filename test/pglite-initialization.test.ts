import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import {
  pgliteCompletionFile,
  pgliteInitializationDir,
} from "../packages/environments/src/pglite-initialize.js";
import { startPglite } from "../packages/environments/src/pglite-server.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";

checkPgliteCleanup();

async function fixture(name: string, path: string) {
  const child = Bun.spawn(
    [process.execPath, resolve(`test/fixtures/pglite-compiled/${name}.ts`), path],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  return stdout;
}

test("V1-F2: interrupted initdb and PG_VERSION-only staging recover; completed databases are never reset", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-init-"));
  let server: Awaited<ReturnType<typeof startPglite>> | undefined;
  try {
    for (const phase of ["initdb-without-app", "partial-pg-version"]) {
      const dataDir = join(root, phase);
      const staging = pgliteInitializationDir(dataDir);
      // Manager's pre-created empty 0700 published directory must be supported.
      await mkdir(dataDir, { mode: 0o700 });
      if (phase === "initdb-without-app") await fixture("initialization-state", staging);
      else {
        await mkdir(staging, { mode: 0o700 });
        await writeFile(join(staging, "PG_VERSION"), "17\n");
      }
      expect(existsSync(join(staging, "PG_VERSION"))).toBe(true);
      expect(existsSync(join(staging, pgliteCompletionFile))).toBe(false);
      server = await startPglite({ dataDir: `${dataDir}/`, port: 48542 });
      const sql = new SQL(server.url(), { max: 1 });
      try {
        expect((await sql`SELECT current_user AS u, current_database() AS d`)[0]).toEqual({
          u: "app",
          d: "app",
        });
        expect(
          Number(
            (await sql.unsafe("SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'"))[0]
              .n,
          ),
        ).toBe(0);
        await sql`CREATE TABLE preserved (id int)`;
        await sql`INSERT INTO preserved VALUES (42)`;
      } finally {
        await sql.close();
      }
      await server.stop();
      expect(existsSync(staging)).toBe(false);
      // Simulate interruption after the completion marker, before atomic publish.
      await rename(dataDir, staging);
      await mkdir(dataDir, { mode: 0o700 });
      server = await startPglite({ dataDir, port: 48542 });
      let check = new SQL(server.url(), { max: 1 });
      try {
        expect((await check`SELECT id FROM preserved`)[0].id).toBe(42);
      } finally {
        await check.close();
        await server.stop();
      }
      // A completed, published database must also survive a missing marker.
      await rm(join(dataDir, pgliteCompletionFile));
      server = await startPglite({ dataDir, port: 48542 });
      check = new SQL(server.url(), { max: 1 });
      try {
        expect((await check`SELECT id FROM preserved`)[0].id).toBe(42);
      } finally {
        await check.close();
        await server.stop();
      }
    }
  } finally {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);

test("V1-F3: corrupt published PG_VERSION fails identically three times and survives forced GC", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-start-fail-"));
  try {
    await writeFile(join(root, "PG_VERSION"), "17\n");
    const errors: string[] = JSON.parse(await fixture("failed-start", root));
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain("PGlite failed to initialize properly");
    expect(errors[0]).not.toContain("locked");
    expect(errors[0]).not.toBe("unexpected success");
    expect(errors[1]).toBe(errors[0]);
    expect(errors[2]).toBe(errors[0]);
    expect(existsSync(join(root, "PG_VERSION"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.pglite-lock`, { force: true });
  }
}, 30_000);
