import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context } from "@contremaitre/execution/context";
import { parseManifest } from "@contremaitre/projects/config";
import { SQL } from "bun";
import type { ServiceState } from "../packages/environments/src/model.js";
import { PGliteRuntime } from "../packages/environments/src/pglite-runtime.js";
import type { RunSpec } from "../packages/environments/src/runtimes.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";
import { freePort } from "./ports.js";

checkPgliteCleanup();

const service = parseManifest("version: 1\nproject: pglite\nservices:\n  db: {kind: postgres}\n")
  .services.db;
const state = (name: string): ServiceState => ({
  Name: name,
  Container: name,
  Image: "",
  Host: "",
  Volume: "",
  Port: 5432,
  HTTP: false,
  Spec: service,
  Initialized: true,
});
const client = (port: number) =>
  new SQL(`postgresql://app:wrong@127.0.0.1:${port}/app?sslmode=disable`, { max: 1 });
async function spec(root: string, name: string, port: number): Promise<RunSpec> {
  const envFile = join(root, `${name}.env`);
  await writeFile(envFile, "POSTGRES_USER=app\nPOSTGRES_DB=app\nPOSTGRES_PASSWORD=secret\n", {
    mode: 0o600,
  });
  return {
    name,
    image: "",
    network: "",
    service,
    volumes: {},
    envFile,
    data: join(root, name),
    ports: { "5432": port },
  };
}

test("PGliteRuntime lifecycle, redeploy replacement, logs and remove preserve data", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-runtime-"));
  const runtime = new PGliteRuntime({ home: root, apple: {} });
  const ctx = context();
  const port = await freePort();
  const idlePort = await freePort();
  let sql: SQL | undefined;
  try {
    expect(runtime.capabilities).toEqual({ network: "host", development: "mount", clone: "files" });
    await runtime.preflight(ctx);
    await expect(runtime.build(ctx, { root, name: "db", service, tag: "unused" })).rejects.toThrow(
      "does not support builds",
    );
    expect(await runtime.inspect(ctx, "db")).toBeUndefined();
    const run = await spec(root, "db", port);
    await expect(runtime.run(ctx, { ...run, task: true })).rejects.toThrow("does not support task");
    await runtime.run(ctx, run);
    await rm(run.envFile);
    expect(await runtime.inspect(ctx, "db")).toEqual({ Host: "127.0.0.1", Running: true });
    // V1-F1: readiness must work on three consecutive fresh connections.
    for (let i = 0; i < 3; i++) {
      expect(await runtime.ready(ctx, state("db"), { host: "127.0.0.1", port })).toBe(true);
    }
    expect(await runtime.ready(ctx, state("db"), { host: "127.0.0.1", port: idlePort })).toBe(
      false,
    );
    sql = client(port);
    await sql`CREATE TABLE records (id integer PRIMARY KEY)`;
    await sql`INSERT INTO records VALUES (1)`;
    await sql.close();
    await runtime.stop(ctx, "db");
    expect(await runtime.inspect(ctx, "db")).toEqual({ Host: "127.0.0.1", Running: false });
    expect(existsSync(run.data ?? "")).toBe(true);
    await runtime.start(ctx, "db");
    sql = client(port);
    expect((await sql`SELECT id FROM records`)[0].id).toBe(1);
    await sql.close();
    // Redeploy replaces the server cleanly; the old env file is already gone.
    const replacement = await spec(root, "db", port);
    await runtime.run(ctx, replacement);
    await rm(replacement.envFile);
    sql = client(port);
    expect((await sql`SELECT id FROM records`)[0].id).toBe(1);
    await sql.close();
    let logs = "";
    await runtime.logs(
      context(undefined, (line) => {
        logs += String(line);
      }),
      "db",
    );
    expect(logs).toContain(`PGlite listening on 127.0.0.1:${port}`);
    let freshLogs = "";
    await new PGliteRuntime({ home: root }).logs(
      context(undefined, (line) => {
        freshLogs += String(line);
      }),
      "db",
    );
    expect(freshLogs).toBe(logs);
    // The file is bounded even if the previous process left excessive output.
    await writeFile(
      join(root, "db.pglite-log"),
      JSON.stringify({ generation: "large", start: 0, text: "x\n".repeat(50000) }),
    );
    await runtime.stop(ctx, "db");
    expect((await Bun.file(join(root, "db.pglite-log")).text()).length).toBeLessThanOrEqual(65536);
    await runtime.remove(ctx, "db");
    expect(await runtime.inspect(ctx, "db")).toBeUndefined();
    expect(existsSync(run.data ?? "")).toBe(true);
    // A fresh runtime can reopen data after the previous runtime forgets it.
    await runtime.run(ctx, await spec(root, "db", port));
    sql = client(port);
    expect((await sql`SELECT id FROM records`)[0].id).toBe(1);
    await sql.close();
  } finally {
    await sql?.close({ timeout: 0 });
    await runtime.remove(ctx, "db");
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("PGliteRuntime applies the manifest's connection_wait_seconds to waiting clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-wait-runtime-"));
  const runtime = new PGliteRuntime({ home: root });
  const ctx = context();
  const port = await freePort();
  const waiting = parseManifest(
    "version: 1\nproject: pglite\nservices:\n  db: {kind: postgres, runtime: wasm, connection_wait_seconds: 1}\n",
  ).services.db;
  const holder = client(port);
  const waiter = new SQL(`postgresql://app:x@127.0.0.1:${port}/app?sslmode=disable`, {
    max: 1,
    connectionTimeout: 30,
  });
  try {
    await runtime.run(ctx, { ...(await spec(root, "db", port)), service: waiting });
    await holder`SELECT 1`;
    const start = performance.now();
    const refusal = await waiter`SELECT 1`.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({ errno: "53300" });
    // One second, not the two-second default.
    expect(performance.now() - start).toBeLessThan(1900);
  } finally {
    await waiter.close({ timeout: 0 });
    await holder.close({ timeout: 0 });
    await runtime.remove(ctx, "db");
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("PGliteRuntime clone replaces stopped target, quiesces a writer and isolates both sides", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-runtime-clone-"));
  const runtime = new PGliteRuntime({ home: root });
  const lines: string[] = [];
  const ctx = context(undefined, (line) => lines.push(String(line)));
  const sourcePort = await freePort();
  const targetPort = await freePort();
  const fromSpec = await spec(root, "source", sourcePort);
  const toSpec = await spec(root, "target", targetPort);
  const from = { name: "source", data: join(root, "source"), service: state("source") };
  const to = { name: "target", data: join(root, "target"), service: state("target") };
  let source: SQL | undefined;
  let target: SQL | undefined;
  let inserting = false,
    committed = 0;
  let writer: Promise<void> | undefined;
  try {
    await runtime.run(ctx, fromSpec);
    await runtime.run(ctx, toSpec);
    await rm(fromSpec.envFile);
    await rm(toSpec.envFile);
    source = client(sourcePort);
    target = client(targetPort);
    await source`CREATE TABLE records (id integer PRIMARY KEY)`;
    await target`CREATE TABLE obsolete (id integer)`;
    await expect(runtime.clone(ctx, from, to)).rejects.toThrow("both services stopped");
    const writingClient = source;
    inserting = true;
    writer = (async () => {
      while (inserting) {
        await writingClient`INSERT INTO records VALUES (${committed + 1})`;
        committed++;
        await Bun.sleep(5);
      }
    })();
    while (committed < 3) await Bun.sleep(10);
    // Simulate Manager pausing app writers before stopping both databases.
    inserting = false;
    await writer;
    const atQuiesce = committed;
    await source.close();
    await target.close();
    await runtime.stop(ctx, "source");
    await runtime.stop(ctx, "target");
    await runtime.clone(ctx, from, to);
    expect(lines.join("")).toContain(
      process.platform === "darwin"
        ? "cloned Postgres data with clonefile"
        : "copied Postgres data (clonefile unavailable)",
    );
    await runtime.start(ctx, "source");
    await runtime.start(ctx, "target");
    source = client(sourcePort);
    target = client(targetPort);
    expect(Number((await source`SELECT count(*) AS n FROM records`)[0].n)).toBe(atQuiesce);
    expect(Number((await target`SELECT count(*) AS n FROM records`)[0].n)).toBe(atQuiesce);
    expect((await target`SELECT to_regclass('obsolete') AS table_name`)[0].table_name).toBeNull();
    await source`INSERT INTO records VALUES (9001)`;
    await target`INSERT INTO records VALUES (9002)`;
    expect((await source`SELECT * FROM records WHERE id=9002`).length).toBe(0);
    expect((await target`SELECT * FROM records WHERE id=9001`).length).toBe(0);
  } finally {
    inserting = false;
    await writer;
    await source?.close({ timeout: 0 });
    await target?.close({ timeout: 0 });
    await runtime.remove(ctx, "source");
    await runtime.remove(ctx, "target");
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("V6-F2/F5: truncated or empty logs do not block start; readiness follower includes only this launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-corrupt-log-"));
  const runtime = new PGliteRuntime({ home: root }),
    ctx = context();
  const path = join(root, "db.pglite-log");
  const port = await freePort();
  try {
    for (const bad of ['{"generation":"truncated', ""]) {
      await writeFile(path, bad);
      await writeFile(`${path}.corrupt`, "older corrupt record");
      // Snapshot logs must recover even before the database has started.
      let recovered = "";
      await new PGliteRuntime({ home: root }).logs(
        context(undefined, (bytes) => {
          recovered += String(bytes);
        }),
        "db",
      );
      expect(recovered.match(/PGlite log was corrupt/g)?.length).toBe(1);
      expect(await Bun.file(`${path}.corrupt`).text()).toBe(bad);
      // Start must independently recover a bad file, rather than relying on logs().
      await writeFile(path, bad);
      await runtime.run(ctx, await spec(root, "db", port));
      expect(await runtime.ready(ctx, state("db"), { host: "127.0.0.1", port })).toBe(true);
      let snapshot = "";
      await new PGliteRuntime({ home: root }).logs(
        context(undefined, (bytes) => {
          snapshot += String(bytes);
        }),
        "db",
      );
      expect(snapshot.match(/PGlite log was corrupt/g)?.length).toBe(1);
      expect(snapshot).toContain("PGlite listening");
      await runtime.stop(ctx, "db");
    }
    // A new launch must be present even if the follower attaches after start finishes.
    await writeFile(
      path,
      JSON.stringify({
        generation: "earlier",
        start: 0,
        text: "PGlite listening on earlier-run-marker\n",
      }),
    );
    await runtime.run(ctx, await spec(root, "db", port));
    const cancel = new AbortController();
    let current = "";
    const follower = runtime
      .logs(
        context(cancel.signal, (bytes) => {
          current += String(bytes);
        }),
        "db",
        true,
      )
      .catch((error) => {
        if (!cancel.signal.aborted) throw error;
      });
    try {
      expect(current).toContain(`PGlite listening on 127.0.0.1:${port}`);
      expect(current).not.toContain("earlier-run-marker");
      expect(current.match(/PGlite listening/g)?.length).toBe(1);
    } finally {
      cancel.abort();
      await follower;
    }
  } finally {
    await runtime.stop(ctx, "db");
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
