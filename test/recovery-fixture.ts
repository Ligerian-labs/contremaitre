import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@contremaitre/cli/client";
import { context, HubError } from "@contremaitre/execution/context";
import {
  application,
  CommandBus,
  Deploy,
  Down,
  List,
  QueryBus,
} from "@contremaitre/hub/application";
import { startServer } from "@contremaitre/hub/server";
import { defineFixture, defineScenario, makeCatalog, plan, run } from "@structure-ai/fixtures";
import { Effect, Schema } from "effect";
import { FakeRuntime } from "./fake-runtime.js";

// This target owns only temporary files and an in-memory container runtime.
export async function recoveryFixture() {
  const home = mkdtempSync(join(tmpdir(), "cm-recovery-fixture-"));
  const runtime = new FakeRuntime();
  let hub = await startServer({ home, port: 0, runtime, skipSystemStart: true });
  const app = application({
    ...hub,
    share: async () => {
      throw Error("Sharing disabled in this fixture");
    },
  });
  let failingContainer = "";
  const start = runtime.run.bind(runtime);
  runtime.run = async (ctx, spec) => {
    if (spec.name === failingContainer) throw Error("server refuses readiness");
    await start(ctx, spec);
  };
  const project = defineFixture({
    key: "recovery/main",
    create: ({ dispatch, id }) =>
      Effect.gen(function* () {
        const root = join(home, id("workspace"));
        mkdirSync(root);
        writeFileSync(
          join(root, ".contremaitre.yaml"),
          'version: 1\nproject: recovery\nservices:\n  web: {image: app, ready: ["true"], volumes: {uploads: /uploads}}\n',
        );
        const operation = yield* dispatch(Deploy, { root, branch: "main" });
        const result = yield* Effect.tryPromise(() => hub.operations.wait(operation.id));
        assert.equal(result.status, "succeeded");
        const environment = hub.manager.resolve(operation.environmentId);
        writeFileSync(
          join(home, "data", environment.Identity.ID, "uploads", "sentinel"),
          "preserved",
        );
        return { root, environment };
      }),
  });
  const interrupted = defineFixture({
    key: "recovery/interrupted-clone",
    dependencies: { project },
    create: ({ dispatch, dependencies }) =>
      Effect.gen(function* () {
        failingContainer = dependencies.project.environment.Services.web.Container;
        const operation = yield* dispatch(Deploy, {
          root: dependencies.project.root,
          branch: "clone",
        });
        const result = yield* Effect.tryPromise(() => hub.operations.wait(operation.id));
        assert.equal(result.status, "failed");
        assert.match(result.error ?? "", /server refuses readiness/);
        return operation.environmentId;
      }),
  });
  const catalog = makeCatalog({
    base: { project },
    scenarios: [
      defineScenario({
        name: "hub/interrupted-clone",
        description: "An interrupted clone whose source cannot restart",
        input: Schema.Struct({}),
        fixtures: () => ({ interrupted }),
      }),
    ],
  });
  try {
    const fixtures = await Effect.runPromise(catalog.prepare("hub/interrupted-clone", {}));
    const steps = await Effect.runPromise(plan(fixtures));
    assert.deepEqual(steps, ["recovery/main", "recovery/interrupted-clone"]);
    const report = await app.runPromise(
      run({
        fixtures,
        enabled: true,
        ready: () =>
          Effect.gen(function* () {
            const bus = yield* QueryBus;
            const environments = yield* bus.dispatch(List, {});
            assert.equal((environments as unknown[]).length, 2);
          }),
      }),
    );
    const rejected = await app.runPromise(
      Effect.flatMap(CommandBus, (bus) =>
        bus
          .dispatch(Down, { env: "missing-fixture-environment" })
          .pipe(Effect.catchTag("HubError", (error) => Effect.succeed(error))),
      ),
    );
    assert(rejected instanceof HubError);
    assert.match(rejected.message, /not found/);
    const target = String(report.values.interrupted);
    const journal = join(home, "recovery", `${target}.json`);
    assert(existsSync(journal));
    await hub.close();
    hub = await startServer({ home, port: 0, runtime, skipSystemStart: true });
    assert(await call(context(), home, "health"));
    assert(existsSync(journal));
    assert(hub.manager.list().every((env) => env.Error.includes("server refuses readiness")));
    await call(context(), home, "stop");
    // stop flushes its response before closing the socket.
    await hub.close();
    assert.equal(runtime.containers.size, 0);
    for (const env of hub.manager.list())
      assert.equal(
        readFileSync(join(home, "data", env.Identity.ID, "uploads", "sentinel"), "utf8"),
        "preserved",
      );
    const before = runtime.calls.length;
    hub = await startServer({ home, port: 0, runtime, skipSystemStart: true });
    assert(await call(context(), home, "health"));
    assert(!existsSync(journal));
    assert(hub.manager.list().every((env) => env.Status === "stopped"));
    assert(!runtime.calls.slice(before).some((c) => c.startsWith("run ")));
    return {
      scenario: "hub/interrupted-clone",
      input: {},
      runId: report.runId,
      home,
      environmentIds: hub.manager.list().map((env) => env.Identity.ID),
      verified: [
        "typed command errors recover through catchTag",
        "hub admits requests after failed recovery",
        "stop preserves data",
        "restart does not resume stopped writers",
      ],
    };
  } finally {
    await app.dispose();
    await hub.close();
  }
}

if (import.meta.main) console.log(JSON.stringify(await recoveryFixture(), null, 2));
