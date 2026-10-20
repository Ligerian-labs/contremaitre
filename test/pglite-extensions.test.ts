import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context } from "@contremaitre/execution/context";
import { application, Deploy } from "@contremaitre/hub/application";
import { startServer } from "@contremaitre/hub/server";
import {
  defineFixture,
  defineScenario,
  makeCatalog,
  run as runFixtures,
} from "@structure-ai/fixtures";
import { SQL } from "bun";
import { Effect, Schema } from "effect";
import { FakeRuntime } from "./fake-runtime.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";
import { freePort } from "./ports.js";

checkPgliteCleanup();

test("postgres/pgcrypto fixture migrates over the wire and keeps the extension after restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "cm-pglite-extensions-"));
  const root = join(home, "project");
  await mkdir(root);
  await writeFile(
    join(root, ".contremaitre.yaml"),
    "version: 1\nproject: pgcrypto-fixture\nservices:\n  db: {kind: postgres, runtime: wasm}\n",
  );
  const hub = await startServer({
    home,
    port: await freePort(),
    runtime: new FakeRuntime(),
    skipSystemStart: true,
  });
  const app = application({
    ...hub,
    share: async () => {
      throw Error("Sharing disabled in pgcrypto fixture");
    },
  });
  const db = defineFixture({
    key: "postgres/pgcrypto-db",
    create: ({ dispatch }) =>
      Effect.gen(function* () {
        const operation = yield* dispatch(Deploy, { root, branch: "main" });
        const result = yield* Effect.tryPromise(() => hub.operations.wait(operation.id));
        if (result.status !== "succeeded") throw Error(result.error ?? result.status);
        return operation.environmentId;
      }),
  });
  const catalog = makeCatalog({
    base: { db },
    scenarios: [
      defineScenario({
        name: "postgres/pgcrypto",
        description: "Application migration installs pgcrypto on a managed WASM database",
        input: Schema.Struct({}),
        fixtures: () => ({ db }),
      }),
    ],
  });
  try {
    const fixtures = await Effect.runPromise(catalog.prepare("postgres/pgcrypto", {}));
    const report = await app.runPromise(
      runFixtures({
        fixtures,
        enabled: true,
        ready: ({ values }) =>
          Effect.tryPromise(async () => {
            const env = hub.manager.resolve(String(values.db));
            const service = env.Services.db;
            const url = `postgresql://app:${env.credentials?.db}@127.0.0.1:${service.Ports?.["5432"]}/app?sslmode=disable`;
            for (let launch = 0; launch < 2; launch++) {
              const sql = new SQL(url, { max: 1 });
              try {
                if (launch === 0) await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
                expect(
                  (await sql`SELECT encode(digest('bigatelier', 'sha256'), 'hex') AS digest`)[0]
                    .digest,
                ).toBe(createHash("sha256").update("bigatelier").digest("hex"));
              } finally {
                await sql.close();
              }
              if (launch === 0) {
                await hub.manager.backend(service).stop(context(), service.Container);
                await hub.manager.backend(service).start(context(), service.Container);
              }
            }
          }),
      }),
    );
    expect(report.values.db).toBeTruthy();
  } finally {
    for (const env of hub.manager.list()) await hub.manager.down(context(), env, true);
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
}, 60000);
