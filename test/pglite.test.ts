import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { context } from "@contremaitre/execution/context";
import { parseManifest } from "@contremaitre/projects/config";
import { SQL } from "bun";
import { removePgliteData } from "../packages/environments/src/pglite-data.js";
import { forkPgliteData } from "../packages/environments/src/pglite-fork.js";
import { waitPgliteReady } from "../packages/environments/src/pglite-ready.js";
import { startPglite } from "../packages/environments/src/pglite-server.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";
import { freePort } from "./ports.js";

checkPgliteCleanup();

test("pool_mode is explicit and limited to managed WASM Postgres", () => {
  for (const mode of ["session", "transaction"] as const) {
    const manifest = parseManifest(
      `version: 1\nproject: pool\nservices:\n  db: {kind: postgres, runtime: wasm, pool_mode: ${mode}}\n`,
    );
    expect(manifest.services.db.pool_mode).toBe(mode);
  }
  for (const fields of ["kind: postgres", "kind: app, runtime: wasm", "kind: redis"]) {
    expect(() =>
      parseManifest(
        `version: 1\nproject: pool\nservices:\n  db: {${fields}, pool_mode: transaction}\n`,
      ),
    ).toThrow("pool_mode requires kind: postgres and runtime: wasm");
  }
  expect(() =>
    parseManifest(
      "version: 1\nproject: pool\nservices:\n  db: {kind: postgres, runtime: wasm, pool_mode: statement}\n",
    ),
  ).toThrow();
});

const client = (port: number, password = "secret") =>
  new SQL(`postgresql://app:${password}@127.0.0.1:${port}/app?sslmode=disable`, {
    max: 1,
    connectionTimeout: 5,
  });

test("wire queries, app identity, exclusive data ownership, connection limit and persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-"));
  const dataDir = join(root, "db");
  const port = await freePort();
  const otherPort = await freePort();
  let server = await startPglite({ dataDir, port });
  let sql = client(port);
  try {
    await expect(startPglite({ dataDir, port: otherPort })).rejects.toThrow("locked");
    await sql`CREATE TABLE items (id integer PRIMARY KEY)`;
    await sql`INSERT INTO items VALUES (1)`;
    expect((await sql`SELECT current_user AS username, current_database() AS database`)[0]).toEqual(
      { username: "app", database: "app" },
    );
    const second = client(port);
    try {
      try {
        await second`SELECT 1`;
        throw new Error("second connection unexpectedly succeeded");
      } catch (error) {
        expect(error).toMatchObject({
          errno: "53300",
          message: "PGlite allows one connection; use pool size 1",
        });
      }
    } finally {
      await second.close({ timeout: 0 });
    }
    expect((await sql`SELECT * FROM items`)[0].id).toBe(1);
    await expect(removePgliteData(dataDir)).rejects.toThrow("locked");
    await sql.close();
    await server.stop();
    expect(existsSync(dataDir)).toBe(true);
    server = await startPglite({ dataDir, port });
    sql = client(port, "wrong-password");
    expect((await sql`SELECT * FROM items`)[0].id).toBe(1);
    await sql.close();
    await server.stop();
    await removePgliteData(dataDir);
    expect(existsSync(dataDir)).toBe(false);
  } finally {
    await sql.close({ timeout: 0 });
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("quiesced active writer forks consistently and both databases stay isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-fork-"));
  const source = join(root, "source"),
    target = join(root, "target");
  const port = await freePort();
  const forkPort = await freePort();
  const copyPort = await freePort();
  let server = await startPglite({ dataDir: source, port });
  let sql = client(port);
  let fork: Awaited<ReturnType<typeof startPglite>> | undefined;
  let forkSql: SQL | undefined;
  let running = true,
    committed = 0,
    atQuiesce = 0;
  await sql`CREATE TABLE items (id integer PRIMARY KEY)`;
  const writer = (async () => {
    while (running) {
      await sql`INSERT INTO items VALUES (${committed + 1})`;
      committed++;
      await Bun.sleep(5);
    }
  })();
  try {
    while (committed < 3) await Bun.sleep(10);
    const result = await forkPgliteData({
      source,
      target,
      ctx: context(),
      quiesce: async () => {
        running = false;
        await writer;
        atQuiesce = committed;
        await sql.close();
        await server.stop();
        return async () => {
          server = await startPglite({ dataDir: source, port });
          sql = client(port);
        };
      },
    });
    expect(result.method).toBe(process.platform === "darwin" ? "clonefile" : "copy");
    fork = await startPglite({ dataDir: target, port: forkPort });
    forkSql = client(forkPort);
    expect(Number((await forkSql`SELECT count(*) AS n FROM items`)[0].n)).toBe(atQuiesce);
    await forkSql`INSERT INTO items VALUES (10001)`;
    await sql`INSERT INTO items VALUES (10002)`;
    expect((await sql`SELECT * FROM items WHERE id=10001`).length).toBe(0);
    expect((await forkSql`SELECT * FROM items WHERE id=10002`).length).toBe(0);
    await forkSql.close();
    await fork.stop();
    expect(
      (
        await forkPgliteData({
          source: target,
          target: join(root, "copy"),
          ctx: context(),
          forceCopy: true,
        })
      ).method,
    ).toBe("copy");
    const copy = await startPglite({ dataDir: join(root, "copy"), port: copyPort });
    const copySql = client(copyPort);
    try {
      expect(Number((await copySql`SELECT count(*) AS n FROM items`)[0].n)).toBe(atQuiesce + 1);
    } finally {
      await copySql.close();
      await copy.stop();
    }
  } finally {
    running = false;
    await writer;
    await sql.close({ timeout: 0 });
    await server.stop();
    await forkSql?.close({ timeout: 0 });
    await fork?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);

test("readiness retries queries, times out and aborts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-ready-"));
  const port = await freePort();
  const url = `postgresql://app:pw@127.0.0.1:${port}/app?sslmode=disable`;
  const ready = waitPgliteReady(url, { timeout: 15_000 });
  await Bun.sleep(100);
  const server = await startPglite({ dataDir: root, port });
  try {
    await ready;
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
  await expect(waitPgliteReady(url, { timeout: 100 })).rejects.toThrow();
  const controller = new AbortController();
  const aborted = waitPgliteReady(url, { signal: controller.signal });
  controller.abort(new Error("cancel readiness"));
  await expect(aborted).rejects.toThrow("cancel readiness");
});

test("managed postgres rejects migration commands", () => {
  expect(() =>
    parseManifest(
      "version: 1\nproject: test\nservices:\n  db: {kind: postgres, migrate: [echo, migrate]}\n",
    ),
  ).toThrow(
    "db: managed databases cannot override storage, credentials, command or initialization",
  );
});

test("compiled Worker embeds PGlite assets and runs without node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-compiled-"));
  try {
    const binary = join(root, "fixture");
    const port = await freePort();
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        resolve("test/fixtures/pglite-compiled/main.ts"),
        resolve("packages/environments/src/pglite-worker.ts"),
        "--outfile",
        binary,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(build.stderr).text();
    expect(await build.exited, output).toBe(0);
    const run = Bun.spawn([binary, join(root, "data"), String(port)], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("compiled PGlite query passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("Bun 1.4.2 does not automatically embed URL or string Worker entrypoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-workers-"));
  try {
    for (const name of ["worker-url", "worker-string"]) {
      const binary = join(root, name);
      const build = Bun.spawn(
        [
          process.execPath,
          "build",
          "--compile",
          resolve(`test/fixtures/pglite-compiled/${name}.ts`),
          "--outfile",
          binary,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const errors = await new Response(build.stderr).text();
      expect(await build.exited, errors).toBe(0);
      const run = Bun.spawn([binary, join(root, "data"), String(await freePort())], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await new Response(run.stderr).text();
      expect(await run.exited, stderr).toBe(7);
      expect(stderr).toContain("ModuleNotFound");
      expect(stderr).toContain("pglite-worker.ts");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(!Bun.which("psql"))(
  "psql connects with the ordinary managed Postgres URL",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cm-pglite-psql-"));
    const server = await startPglite({ dataDir: join(root, "db"), port: await freePort() });
    try {
      const command = Bun.spawn(
        [
          "psql",
          server.url("different-password"),
          "-X",
          "-v",
          "ON_ERROR_STOP=1",
          "-At",
          "-c",
          "SELECT current_user, current_database(), 42",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [output, errors, status] = await Promise.all([
        new Response(command.stdout).text(),
        new Response(command.stderr).text(),
        command.exited,
      ]);
      expect(status, errors).toBe(0);
      expect(output.trim()).toBe("app|app|42");
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("fork failure restarts the quiesced source and preserves the existing target", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-fork-failure-"));
  const source = join(root, "source"),
    target = join(root, "target");
  const port = await freePort();
  let server = await startPglite({ dataDir: source, port });
  try {
    await forkPgliteData({
      source,
      target,
      ctx: context(),
      quiesce: async () => {
        await server.stop();
        return async () => {
          server = await startPglite({ dataDir: source, port });
        };
      },
    });
    let resumed = false;
    let failure: unknown;
    try {
      await forkPgliteData({
        source,
        target,
        ctx: context(),
        quiesce: async () => {
          await server.stop();
          return async () => {
            server = await startPglite({ dataDir: source, port });
            resumed = true;
          };
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("target already exists");
    expect(resumed).toBe(true);
    await waitPgliteReady(server.url());
    const fork = await startPglite({ dataDir: target, port: await freePort() });
    try {
      await waitPgliteReady(fork.url());
    } finally {
      await fork.stop();
    }
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
