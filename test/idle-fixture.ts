import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  application,
  CommandBus,
  Deploy,
  Down,
  List,
  QueryBus,
} from "@contremaitre/hub/application";
import { startServer } from "@contremaitre/hub/server";
import { defineFixture, defineScenario, makeCatalog, run } from "@structure-ai/fixtures";
import { Effect, Schema } from "effect";
import { FakeRuntime } from "./fake-runtime.js";

export async function idleFixture(retain = false) {
  const home = mkdtempSync(join(tmpdir(), "cm-idle-fixture-"));
  let time = Date.now();
  const hub = await startServer({
    home,
    port: 0,
    runtime: new FakeRuntime(),
    skipSystemStart: true,
    now: () => time,
  });
  const app = application({
    ...hub,
    share: async () => {
      throw Error("Sharing disabled in fixture");
    },
  });
  const environment = (key: string, timeout: number) =>
    defineFixture({
      key,
      create: ({ dispatch, id }) =>
        Effect.gen(function* () {
          const root = join(home, id("workspace"));
          mkdirSync(root);
          writeFileSync(
            join(root, ".contremaitre.yaml"),
            `version: 1
project: idle-fixture
idle_timeout_seconds: ${timeout}
services:
  worker: {image: app, ready: ["true"], volumes: {uploads: /uploads}}
`,
          );
          const op = yield* dispatch(Deploy, { root, branch: "fixture" });
          const result = yield* Effect.tryPromise(() => hub.operations.wait(op.id));
          assert.equal(result.status, "succeeded");
          const sentinel = join(home, "data", op.environmentId, "uploads", "sentinel");
          writeFileSync(sentinel, "preserved");
          return { environment_id: op.environmentId, sentinel };
        }),
    });
  const catalog = makeCatalog({
    base: {},
    scenarios: [
      defineScenario({
        name: "hub/idle-shutdown",
        description: "Idle worker stops with retained data while an opted-out worker keeps running",
        input: Schema.Struct({}),
        fixtures: () => ({
          idle: environment("idle/worker", 10),
          background: environment("idle/background", 0),
        }),
      }),
    ],
  });
  try {
    const fixtures = await Effect.runPromise(catalog.prepare("hub/idle-shutdown", {}));
    const report = await app.runPromise(
      run({
        fixtures,
        enabled: true,
        ready: () =>
          Effect.gen(function* () {
            const queries = yield* QueryBus;
            const environments = yield* queries.dispatch(List, {});
            assert.equal(
              (environments as { Status: string }[]).filter((e) => e.Status === "running").length,
              2,
            );
          }),
      }),
    );
    const proofSchema = Schema.Struct({ environment_id: Schema.String, sentinel: Schema.String });
    const idle = Schema.decodeUnknownSync(proofSchema)(report.values.idle);
    const background = Schema.decodeUnknownSync(proofSchema)(report.values.background);
    time += 10_000;
    await hub.idle.sweep();
    const values = await app.runPromise(Effect.flatMap(QueryBus, (bus) => bus.dispatch(List, {})));
    const statuses = Object.fromEntries(
      (values as { Identity: { ID: string }; Status: string }[]).map((e) => [
        e.Identity.ID,
        e.Status,
      ]),
    );
    assert.equal(statuses[idle.environment_id], "stopped");
    assert.equal(statuses[background.environment_id], "running");
    assert.equal(readFileSync(idle.sentinel, "utf8"), "preserved");
    return {
      scenario: "hub/idle-shutdown",
      input: {},
      target: "isolated FakeRuntime",
      run_id: report.runId,
      home,
      statuses,
      data_preserved: true,
      retained: retain,
    };
  } finally {
    if (!retain)
      for (const env of Object.values(hub.manager.state.Environments)) {
        const op = await app.runPromise(
          Effect.flatMap(CommandBus, (bus) =>
            bus.dispatch(Down, { env: env.Identity.ID, delete_data: true }),
          ),
        );
        assert.equal((await hub.operations.wait(op.id)).status, "succeeded");
      }
    await app.dispose();
    await hub.close();
    if (!retain) rmSync(home, { recursive: true, force: true });
  }
}
if (import.meta.main)
  console.log(JSON.stringify(await idleFixture(process.argv.includes("--retain")), null, 2));
