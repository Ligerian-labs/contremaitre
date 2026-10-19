import { beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context } from "@contremaitre/execution/context";
import { application, Deploy } from "@contremaitre/hub/application";
import { startServer } from "@contremaitre/hub/server";
import { parseManifest } from "@contremaitre/projects/config";
import {
  defineFixture,
  defineScenario,
  makeCatalog,
  run as runFixtures,
} from "@structure-ai/fixtures";
import { SQL } from "bun";
import { Effect, Schema } from "effect";
import { startPglite } from "../packages/environments/src/pglite-server.js";
import { FakeRuntime } from "./fake-runtime.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";
import { freePort } from "./ports.js";

checkPgliteCleanup();
const available = !!Bun.which("pgbouncer");
beforeAll(() => {
  if (!available && process.env.CONTREMAITRE_REQUIRE_PGBOUNCER === "1")
    throw Error("PgBouncer is required; install with brew install pgbouncer");
});
const real = available ? test : test.skip;

real(
  "late reset notifications cannot arm a watchdog after termination begins",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cm-pglite-pool-late-reset-"));
    const server = await startPglite({
      dataDir: join(root, "db"),
      port: await freePort(),
      pooling: "transaction",
      createWorker: (url) => {
        const worker = new Worker(url);
        const terminate = worker.terminate.bind(worker);
        worker.terminate = () => {
          // A pooler disconnect can queue resetting after teardown clears its timer.
          worker.dispatchEvent(new MessageEvent("message", { data: { type: "resetting" } }));
          return terminate();
        };
        return worker;
      },
    });
    try {
      await server.stop();
      expect(server.running).toBe(false);
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test("pooling is explicit and only valid for Wasm Postgres", () => {
  const text =
    "version: 1\nproject: pooled\nservices:\n  db:\n    kind: postgres\n    runtime: wasm\n    postgres: {pooling: transaction}\n";
  expect(parseManifest(text).services.db.postgres?.pooling).toBe("transaction");
  expect(() => parseManifest(text.replace("runtime: wasm", "runtime: apple"))).toThrow(
    "require kind: postgres",
  );
  expect(() => parseManifest(text.replace("kind: postgres", "kind: redis"))).toThrow(
    "require kind: postgres",
  );
  expect(() => parseManifest(text.replace("pooling: transaction", "pooling: statement"))).toThrow();
});

real(
  "transaction pooling accepts independent retained pools and parameterized queries",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cm-pglite-pooling-"));
    const server = await startPglite({
      dataDir: join(root, "db"),
      port: await freePort(),
      pooling: "transaction",
    });
    const a = new SQL(server.url(), { max: 10, connectionTimeout: 5 });
    const b = new SQL(server.url(), { max: 10, connectionTimeout: 5 });
    try {
      await a`SELECT 1`;
      expect((await b`SELECT 2 AS value`)[0].value).toBe(2);
      const values = await Promise.all(
        Array.from(
          { length: 20 },
          async (_, i) => (await (i % 2 ? a : b)`SELECT ${i}::int AS value`)[0].value,
        ),
      );
      expect(values).toEqual(Array.from({ length: 20 }, (_, i) => i));
    } finally {
      await Promise.all([a.close({ timeout: 0 }), b.close({ timeout: 0 })]);
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

real(
  "transactions remain pinned, disconnected work rolls back, pooler failure permits restart",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cm-pglite-pool-state-"));
    const dataDir = join(root, "db");
    const port = await freePort();
    let server = await startPglite({ dataDir, port, pooling: "transaction" });
    const a = new SQL(server.url(), { max: 1 });
    const b = new SQL(server.url(), { max: 1 });
    let release = () => {};
    let transaction: Promise<unknown> | undefined;
    let queued: Promise<unknown> | undefined;
    let replacement: SQL | undefined;
    try {
      await a`CREATE TABLE records(id int PRIMARY KEY)`;
      let entered = () => {};
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      transaction = a.begin(async (tx) => {
        await tx`INSERT INTO records VALUES (1)`;
        await tx.unsafe("SET LOCAL app.actor = 'alice'");
        entered();
        await gate;
        expect((await tx.unsafe("SELECT current_setting('app.actor') AS actor"))[0].actor).toBe(
          "alice",
        );
        await tx`INSERT INTO records VALUES (2)`;
      });
      await ready;
      let completed = false;
      queued = b`SELECT count(*)::int AS count FROM records`.then((rows) => {
        completed = true;
        expect(rows[0].count).toBe(2);
      });
      await Bun.sleep(100);
      expect(completed).toBe(false);
      release();
      await transaction;
      await queued;
      await a.unsafe(
        "SET app.actor = 'must-not-leak'; CREATE TEMP TABLE secret(i int); LISTEN secret; SELECT pg_advisory_lock(12345)",
      );
      expect(
        (
          await b.unsafe(
            "SELECT nullif(current_setting('app.actor',true),'') AS actor, to_regclass('pg_temp.secret')::text AS temp, current_user AS identity",
          )
        )[0],
      ).toEqual({ actor: null, temp: null, identity: "app" });
      expect((await b.unsafe("SELECT pg_listening_channels() AS channel")).length).toBe(0);
      expect(
        Number(
          (await b.unsafe("SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory'"))[0].n,
        ),
      ).toBe(0);
      await expect(
        a.begin(async (tx) => {
          await tx`INSERT INTO records VALUES (1)`;
        }),
      ).rejects.toThrow();
      const reserved = await a.reserve();
      await reserved.unsafe("BEGIN; INSERT INTO records VALUES (3)");
      reserved.release();
      await a.close({ timeout: 0 });
      expect((await b`SELECT count(*)::int AS count FROM records`)[0].count).toBe(2);
      const journal = `${dataDir}.pgbouncer`;
      const file = (await readdir(journal)).find((file) => file.endsWith(".json"));
      expect(file).toBeDefined();
      expect((await stat(join(journal, "pgbouncer.ini"))).mode & 0o777).toBe(0o600);
      const record = JSON.parse(await readFile(join(journal, file ?? ""), "utf8"));
      process.kill(record.pid, "SIGKILL");
      const deadline = Date.now() + 5000;
      while (server.running && Date.now() < deadline) await Bun.sleep(10);
      expect(server.running).toBe(false);
      await b.close({ timeout: 0 });
      await server.stop();
      server = await startPglite({ dataDir, port, pooling: "transaction" });
      replacement = new SQL(server.url(), { max: 10 });
      expect((await replacement`SELECT count(*)::int AS count FROM records`)[0].count).toBe(2);
    } finally {
      release();
      await Promise.allSettled([transaction, queued]);
      await Promise.all([
        a.close({ timeout: 0 }),
        b.close({ timeout: 0 }),
        replacement?.close({ timeout: 0 }),
      ]);
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

real(
  "postgres/transaction-pooling deploys through the application and permits readiness with retained clients",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cm-pglite-pool-fixture-"));
    await writeFile(
      join(root, ".contremaitre.yaml"),
      "version: 1\nproject: pooled\nservices:\n  db:\n    kind: postgres\n    runtime: wasm\n    postgres: {pooling: transaction}\n",
    );
    const apple = new FakeRuntime();
    const hub = await startServer({
      home: join(root, "hub"),
      port: await freePort(),
      runtime: apple,
      skipSystemStart: true,
    });
    const app = application({
      ...hub,
      share: async () => {
        throw Error("Sharing disabled");
      },
    });
    const db = defineFixture({
      key: "postgres/pooled",
      create: ({ dispatch }) =>
        Effect.gen(function* () {
          const op = yield* dispatch(Deploy, { root, branch: "main" });
          const result = yield* Effect.tryPromise(() => hub.operations.wait(op.id));
          if (result.status !== "succeeded") throw Error(result.error ?? result.status);
          return op.environmentId;
        }),
    });
    const catalog = makeCatalog({
      base: { db },
      scenarios: [
        defineScenario({
          name: "postgres/transaction-pooling",
          description: "Independent pools share one Wasm database at transaction boundaries",
          input: Schema.Struct({}),
          fixtures: () => ({ db }),
        }),
      ],
    });
    let sql: SQL | undefined;
    try {
      const fixtures = await Effect.runPromise(catalog.prepare("postgres/transaction-pooling", {}));
      await app.runPromise(
        runFixtures({
          fixtures,
          enabled: true,
          ready: ({ values }) =>
            Effect.tryPromise(async () => {
              const env = hub.manager.resolve(values.db as string);
              const service = env.Services.db;
              const port = service.Ports?.["5432"] ?? 0;
              sql = new SQL(`postgresql://app@127.0.0.1:${port}/app?sslmode=disable`, { max: 10 });
              expect((await sql`SELECT 1 AS n`)[0].n).toBe(1);
              const backend = hub.manager.backend(service);
              if (!backend.ready) throw Error("Postgres backend has no readiness check");
              expect(await backend.ready(context(), service, { host: "127.0.0.1", port })).toBe(
                true,
              );
            }),
        }),
      );
      expect(apple.calls).toEqual([]);
    } finally {
      await sql?.close({ timeout: 0 });
      for (const env of hub.manager.list()) await hub.manager.down(context(), env, true);
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

real(
  "pooler bind failure releases database ownership and private sockets",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cm-pglite-pool-bind-"));
    const blocker = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    if (!address || typeof address === "string") throw Error("No listener port");
    const dataDir = join(root, "db");
    try {
      await expect(
        startPglite({ dataDir, port: address.port, pooling: "transaction" }),
      ).rejects.toThrow("PgBouncer exited");
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      const replacement = await startPglite({
        dataDir,
        port: address.port,
        pooling: "transaction",
      });
      await replacement.stop();
    } finally {
      if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
