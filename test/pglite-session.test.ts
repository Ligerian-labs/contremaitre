import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { startPglite } from "../packages/environments/src/pglite-server.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";
import { freePort } from "./ports.js";

checkPgliteCleanup();

const client = (url: string) => new SQL(url, { max: 1, connectionTimeout: 5 });

test("V1-F1: sequential clients reuse extended-protocol statements without session leakage", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-session-"));
  const server = await startPglite({ dataDir: join(root, "db"), port: await freePort() });
  let sql = client(server.url());
  try {
    const originalPath = (await sql.unsafe("SHOW search_path"))[0].search_path;
    expect((await sql`SELECT ${7}::int AS value`)[0].value).toBe(7);
    await sql.unsafe(
      "SET search_path TO pg_catalog; CREATE TEMP TABLE leak(i int); PREPARE mine AS SELECT 7; LISTEN leaked_channel",
    );
    await sql.unsafe("SELECT set_config('app.user_id','alice',false), pg_advisory_lock(123456)");
    await sql.close();
    sql = client(server.url());
    expect((await sql`SELECT ${7}::int AS value`)[0].value).toBe(7);
    expect((await sql.unsafe("SHOW search_path"))[0].search_path).toBe(originalPath);
    expect(
      (await sql.unsafe("SELECT to_regclass('pg_temp.leak')::text AS temp"))[0].temp,
    ).toBeNull();
    expect(
      (await sql.unsafe("SELECT current_setting('app.user_id',true) AS setting"))[0].setting ||
        null,
    ).toBeNull();
    expect(
      (await sql.unsafe("SELECT name FROM pg_prepared_statements WHERE name='mine'")).length,
    ).toBe(0);
    expect((await sql.unsafe("SELECT pg_listening_channels() AS channel")).length).toBe(0);
    expect(
      Number(
        (await sql.unsafe("SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory'"))[0].n,
      ),
    ).toBe(0);
    // Rollback must precede DISCARD ALL after an abrupt disconnect in a transaction.
    await sql.unsafe("BEGIN; SET search_path TO pg_catalog; CREATE TEMP TABLE uncommitted(i int)");
    await sql.close({ timeout: 0 });
    sql = client(server.url());
    expect((await sql.unsafe("SHOW search_path"))[0].search_path).toBe(originalPath);
    expect(
      (await sql.unsafe("SELECT to_regclass('pg_temp.uncommitted')::text AS temp"))[0].temp,
    ).toBeNull();
    await sql.close();
    sql = client(
      server
        .url("anything")
        .replace("://app:", "://other_user:")
        .replace("/app?", "/other_database?"),
    );
    expect((await sql`SELECT current_user AS u, current_database() AS d`)[0]).toEqual({
      u: "app",
      d: "app",
    });
  } finally {
    await sql.close({ timeout: 0 });
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("V1-F4: thirty immediate reconnects succeed; an occupied slot waits two seconds then rejects", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-reconnect-"));
  const server = await startPglite({ dataDir: join(root, "db"), port: await freePort() });
  let sql: SQL | undefined;
  try {
    for (let i = 0; i < 30; i++) {
      sql = client(server.url());
      expect((await sql`SELECT ${i}::int AS value`)[0].value).toBe(i);
      await sql.close();
    }
    sql = client(server.url());
    await sql`SELECT 1`;
    const second = client(server.url());
    const start = performance.now();
    let failure: unknown;
    try {
      await second`SELECT 1`;
    } catch (error) {
      failure = error;
    } finally {
      await second.close({ timeout: 0 });
    }
    expect(failure).toMatchObject({
      errno: "53300",
      message: "PGlite allows one connection; use pool size 1",
    });
    expect(performance.now() - start).toBeGreaterThanOrEqual(1900);
    expect(performance.now() - start).toBeLessThan(4000);
    expect((await sql`SELECT 2 AS value`)[0].value).toBe(2);
  } finally {
    await sql?.close({ timeout: 0 });
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

const holdThenProbe = async (connectionWaitMs: number, releaseAfterMs: number) => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-wait-"));
  const server = await startPglite({
    dataDir: join(root, "db"),
    port: await freePort(),
    connectionWaitMs,
  });
  const holder = new SQL(server.url(), { max: 1, connectionTimeout: 60 });
  const waiter = new SQL(server.url(), { max: 1, connectionTimeout: 60 });
  try {
    await holder`SELECT 1`;
    const release = Bun.sleep(releaseAfterMs).then(() => holder.close({ timeout: 0 }));
    const start = performance.now();
    const outcome = await waiter`SELECT 7 AS value`.then(
      (rows) => ({ value: rows[0].value as number }),
      (error: unknown) => ({ error }),
    );
    const elapsed = performance.now() - start;
    await release;
    return { outcome, elapsed };
  } finally {
    await waiter.close({ timeout: 0 });
    await holder.close({ timeout: 0 });
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
};

test("a configured connection wait refuses at its own deadline", async () => {
  const { outcome, elapsed } = await holdThenProbe(800, 5000);
  expect(outcome).toMatchObject({
    error: { errno: "53300", message: "PGlite allows one connection; use pool size 1" },
  });
  expect(elapsed).toBeGreaterThanOrEqual(700);
  expect(elapsed).toBeLessThan(1900);
}, 30_000);

test("a longer connection wait admits a client released after the two-second default", async () => {
  const { outcome, elapsed } = await holdThenProbe(8000, 3000);
  expect(outcome).toEqual({ value: 7 });
  expect(elapsed).toBeGreaterThanOrEqual(2900);
  expect(elapsed).toBeLessThan(8000);
}, 30_000);

test("waiters are admitted first come, first served within the configured wait", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-fifo-"));
  const server = await startPglite({
    dataDir: join(root, "db"),
    port: await freePort(),
    connectionWaitMs: 10_000,
  });
  const holder = new SQL(server.url(), { max: 1, connectionTimeout: 60 });
  const clients: SQL[] = [];
  try {
    await holder`SELECT 1`;
    const order: string[] = [];
    const queued = ["first", "second", "third"].map(async (name, index) => {
      // Arrive in order, while the slot is still held.
      await Bun.sleep(100 * index);
      const sql = new SQL(server.url(), { max: 1, connectionTimeout: 60 });
      clients.push(sql);
      await sql`SELECT 1`;
      order.push(name);
      await sql.close({ timeout: 0 });
    });
    await Bun.sleep(600);
    await holder.close({ timeout: 0 });
    await Promise.all(queued);
    expect(order).toEqual(["first", "second", "third"]);
  } finally {
    for (const sql of clients) await sql.close({ timeout: 0 });
    await holder.close({ timeout: 0 });
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
