// CONTREMAITRE_FIXTURES=1 bun scripts/verify-docker.ts --cleanup
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Docker } from "@contremaitre/environments/docker";
import { context } from "@contremaitre/execution/context";
import { application, CommandBus, Deploy, DesignateMain } from "@contremaitre/hub/application";
import { startServer } from "@contremaitre/hub/server";
import {
  defineFixture,
  defineScenario,
  makeCatalog,
  run as runFixtures,
} from "@structure-ai/fixtures";
import { Effect, Schema } from "effect";

assert.equal(process.platform, "linux", "Run the Docker fixture on Linux");
assert.equal(process.env.CONTREMAITRE_FIXTURES, "1", "Enable isolated fixtures explicitly");
assert(
  process.argv.includes("--cleanup") || process.argv.includes("--keep"),
  "Choose --cleanup or --keep",
);
const directory = mkdtempSync(join(tmpdir(), "cm-docker-fixture-"));
const root = join(directory, "project");
cpSync(resolve("examples/linux-docker"), root, { recursive: true });
const home = join(directory, "state");
const ctx = context(AbortSignal.timeout(600_000), (chunk) => process.stderr.write(chunk));
const runtime = new Docker();
await runtime.startSystem(ctx);
const port = await new Promise<number>((done) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert(address && typeof address !== "string");
    server.close(() => done(address.port));
  });
});
let hub = await startServer({ home, port });
let app = application({
  ...hub,
  share: async () => {
    throw Error("Sharing disabled in fixtures");
  },
});
let keep = false;
try {
  const deployment = defineFixture({
    key: "docker/deployment",
    create: ({ dispatch, id }) =>
      Effect.gen(function* () {
        const op = yield* dispatch(Deploy, {
          root,
          branch: `fixture-${id("environment").slice(0, 8)}`,
        });
        const result = yield* Effect.tryPromise(() => hub.operations.wait(op.id));
        assert.equal(result.status, "succeeded", result.error ?? "deployment failed");
        return op.environmentId;
      }),
  });
  const catalog = makeCatalog({
    base: {},
    scenarios: [
      defineScenario({
        name: "docker/native-stack",
        description: "Linux Docker build, data, jobs, development and recovery",
        input: Schema.Struct({}),
        fixtures: () => ({ deployment }),
      }),
    ],
  });
  const fixtures = await Effect.runPromise(catalog.prepare("docker/native-stack", {}));
  const receipt = await app.runPromise(
    runFixtures({
      fixtures,
      enabled: true,
      timeoutMs: 540_000,
      ready: ({ values }) =>
        Effect.tryPromise(async () => {
          const env = hub.manager.resolve(String(values.deployment));
          assert.equal(env.Services.web.ready, true);
          assert.equal(env.Services.migrate.job?.status, "succeeded");
        }),
    }),
  );
  const id = String(receipt.values.deployment);
  const env = hub.manager.resolve(id);
  assert(Object.values(env.Services).every((s) => s.Runtime === "docker"));
  assert.equal(env.Services.migrate.job?.status, "succeeded");
  const response = async (environment = id) => {
    const e = hub.manager.resolve(environment);
    const res = await fetch(`http://127.0.0.1:${hub.proxyPort}/`, {
      headers: { host: new URL(hub.manager.localURL(e, "web")).hostname },
    });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as {
      runtime: string;
      messages: { id: number; body: string }[];
      visits: number;
    };
  };
  assert.equal((await response()).messages[0].body, "Hello from Linux Docker");
  assert((await response()).visits >= 2);
  const images = JSON.stringify(env.builds);
  const job = JSON.stringify(env.Services.migrate.job);
  const container = env.Services.web.Container;
  await hub.manager.deploy(
    ctx,
    await hub.manager.prepare(ctx, { root, branch: env.Identity.Branch }),
  );
  assert.equal(JSON.stringify(hub.manager.resolve(id).builds), images, "unchanged image reuse");
  assert.equal(
    JSON.stringify(hub.manager.resolve(id).Services.migrate.job),
    job,
    "completed job retained",
  );
  assert.equal(hub.manager.resolve(id).Services.web.Container, container);
  const query = (environment: string, sql: string) =>
    hub.manager.exec(ctx, hub.manager.resolve(environment).Services.db, [
      "psql",
      "-U",
      "app",
      "-d",
      "app",
      "-Atc",
      sql,
    ]);
  await query(id, "INSERT INTO messages VALUES (2, 'forked data')");
  const designation = await app.runPromise(
    Effect.flatMap(CommandBus, (bus) => bus.dispatch(DesignateMain, { env: id })),
  );
  assert.equal((await hub.operations.wait(designation.id)).status, "succeeded");
  const forkOp = await app.runPromise(
    Effect.flatMap(CommandBus, (bus) => bus.dispatch(Deploy, { root, branch: "docker-fork" })),
  );
  assert.equal((await hub.operations.wait(forkOp.id)).status, "succeeded");
  const fork = forkOp.environmentId;
  assert.equal((await response(fork)).messages.length, 2);
  await query(fork, "INSERT INTO messages VALUES (3, 'branch only')");
  // Docker must reject direct access from another environment's bridge.
  await hub.manager.exec(ctx, hub.manager.resolve(fork).Services.web, [
    "bun",
    "-e",
    "const s=require('node:net').connect({host:process.argv[1],port:5432});s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));setTimeout(()=>{s.destroy();process.exit(0)},1500)",
    hub.manager.resolve(id).Services.db.Host,
  ]);

  assert.equal((await response(id)).messages.length, 2);
  assert.equal((await response(fork)).messages.length, 3);
  // Source mirroring must reach an already-running Docker service.
  const source = join(root, "server.mjs");
  writeFileSync(
    source,
    readFileSync(source, "utf8").replace('runtime: "docker"', 'runtime: "docker-synced"'),
  );
  const waitRuntime = async (runtime: string) => {
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        if ((await response()).runtime === runtime) return;
      } catch (error) {
        // Bun --watch briefly closes its listener while reloading the source.
        lastError = error;
      }
      await Bun.sleep(250);
    }
    throw new Error(`Source sync did not produce ${runtime}`, { cause: lastError });
  };
  await waitRuntime("docker-synced");
  writeFileSync(
    source,
    readFileSync(source, "utf8").replace('runtime: "docker-synced"', 'runtime: "docker"'),
  );
  await waitRuntime("docker");
  // Ensure records current source evidence before smoke verification.
  const ensure = await hub.agents.ensure(ctx, { root, branch: env.Identity.Branch });
  assert.equal((await hub.operations.wait(ensure.id)).status, "succeeded");
  const check = await hub.agents.verify(ctx, { env: id }, "smoke");
  assert("id" in check);
  assert.equal((await hub.operations.wait(check.id)).status, "succeeded");
  const report = await hub.agents.report(ctx, { env: id });
  assert.equal(report.verification, "passed");
  let logs = "";
  await runtime.logs(
    {
      ...ctx,
      log: (b) => {
        logs += b.toString();
      },
    },
    container,
    false,
  );
  assert(logs.includes("Listening on port 3000"));
  await hub.manager.down(ctx, hub.manager.resolve(id), false);
  await hub.manager.deploy(
    ctx,
    await hub.manager.prepare(ctx, { root, branch: env.Identity.Branch }),
  );
  assert.equal((await response()).messages.length, 2, "down preserves PostgreSQL data");
  await app.dispose();
  await hub.close();
  hub = await startServer({ home, port });
  app = application({
    ...hub,
    share: async () => {
      throw Error("Sharing disabled in fixtures");
    },
  });
  assert.equal((await response()).messages.length, 2, "recovery retains original data");
  assert.equal((await response(fork)).messages.length, 3, "recovery retains fork data");
  assert.equal(hub.manager.resolve(id).Services.db.Runtime, "docker");
  console.log(
    JSON.stringify({
      scenario: "docker/native-stack",
      input: {},
      run_id: receipt.runId,
      environment_id: id,
      branch_environment_id: fork,
      home,
      root,
      urls: report.urls,
      review_url: report.review_url,
      verification: report.verification,
      docker: "local Linux Engine",
    }),
  );
  if (process.argv.includes("--keep")) {
    keep = true;
    await new Promise<void>((done) => {
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
  }
} finally {
  if (!keep) {
    for (const env of Object.values(hub.manager.state.Environments)) {
      await hub.manager.down(context(AbortSignal.timeout(60_000)), env, true);
      assert.equal(await runtime.inspect(context(), env.Services.web.Container), undefined);
    }
  }
  await app.dispose();
  await hub.close();
  if (!keep) rmSync(directory, { recursive: true, force: true });
}
