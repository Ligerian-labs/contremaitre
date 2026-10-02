import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { application, Deploy, List, QueryBus } from "@contremaitre/hub/application";
import { startServer } from "@contremaitre/hub/server";
import { defineFixture, defineScenario, makeCatalog, run } from "@structure-ai/fixtures";
import { Effect, Schema } from "effect";
import { FakeRuntime } from "./fake-runtime.js";

export async function dependencyRetryFixture() {
  const home = mkdtempSync(join(tmpdir(), "cm-install-fixture-"));
  const runtime = new FakeRuntime();
  const hub = await startServer({ home, port: 0, runtime, skipSystemStart: true });
  const app = application({
    ...hub,
    share: async () => {
      throw Error("Sharing disabled in fixture");
    },
  });
  const project = defineFixture({
    key: "development/project",
    create: ({ id }) =>
      Effect.sync(() => {
        const root = join(home, id("workspace"));
        mkdirSync(root);
        writeFileSync(join(root, "package.json"), "{}");
        writeFileSync(
          join(root, ".contremaitre.yaml"),
          `version: 1
project: install-fixture
services:
  api:
    image: node:24-bookworm-slim
    command: [node, main.js]
    working_dir: /app
    ready: ["true"]
    dev: {source: '.', target: /app, install: [corepack, pnpm, install]}
`,
        );
        return root;
      }),
  });
  const retry = defineFixture({
    key: "development/retry",
    dependencies: { project },
    create: ({ dispatch, dependencies }) =>
      Effect.gen(function* () {
        runtime.failTask = true;
        const failed = yield* dispatch(Deploy, { root: dependencies.project, branch: "fixture" });
        const failure = yield* Effect.tryPromise(() => hub.operations.wait(failed.id));
        assert.equal(failure.status, "failed");
        const env = hub.manager.resolve(failed.environmentId);
        const source = `${env.Services.api.Container}-source`;
        const resets = runtime.calls.filter((c) => c === `remove volume ${source}`).length;
        runtime.failTask = false;
        const retried = yield* dispatch(Deploy, { root: dependencies.project, branch: "fixture" });
        const result = yield* Effect.tryPromise(() => hub.operations.wait(retried.id));
        assert.equal(result.status, "succeeded");
        assert.equal(runtime.calls.filter((c) => c === `remove volume ${source}`).length, resets);
        return { root: dependencies.project, environment: result.environmentId };
      }),
  });
  const catalog = makeCatalog({
    base: { project },
    scenarios: [
      defineScenario({
        name: "development/install-retry",
        description:
          "A failed installer retains compatible source and retries through hub commands",
        input: Schema.Struct({}),
        fixtures: () => ({ retry }),
      }),
    ],
  });
  try {
    const fixtures = await Effect.runPromise(catalog.prepare("development/install-retry", {}));
    const report = await app.runPromise(
      run({
        fixtures,
        enabled: true,
        ready: () =>
          Effect.gen(function* () {
            const queries = yield* QueryBus;
            const status = yield* queries.dispatch(List, {});
            // Fixture readiness is also checked below against its command result.
            assert(status);
          }),
      }),
    );
    const proof = Schema.decodeUnknownSync(
      Schema.Struct({ root: Schema.String, environment: Schema.String }),
    )(report.values.retry);
    assert.equal(hub.manager.resolve(proof.environment).Status, "running");
    return {
      scenario: "development/install-retry",
      run_id: report.runId,
      environment: proof.environment,
    };
  } finally {
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
}
