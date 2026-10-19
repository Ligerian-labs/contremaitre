// CONTREMAITRE_FIXTURES=1 bun scripts/verify-workloads.ts --cleanup
// Use --keep to retain the isolated environment and its running review page.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { context } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";
import { application, Deploy, DesignateMain } from "@contremaitre/hub/application";
import { startServer } from "@contremaitre/hub/server";
import {
  defineFixture,
  defineScenario,
  makeCatalog,
  run as runFixtures,
} from "@structure-ai/fixtures";
import { Effect, Schema } from "effect";

assert.equal(
  process.env.CONTREMAITRE_FIXTURES,
  "1",
  "Enable isolated development fixtures explicitly",
);
assert(
  process.argv.includes("--cleanup") || process.argv.includes("--keep"),
  "Choose --cleanup or --keep",
);
const home = mkdtempSync(join(tmpdir(), "cm-native-workloads-"));
const root = join(home, "project");
mkdirSync(root);
const ctx = context(AbortSignal.timeout(300000), (chunk) => process.stderr.write(chunk));
const port = await new Promise<number>((done) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert(address && typeof address !== "string");
    server.close(() => done(address.port));
  });
});
for (const name of ["wasm-http", "wasm-command"]) {
  const target = join(home, "target", name);
  await run(
    ctx,
    [
      "cargo",
      "build",
      "--release",
      "--locked",
      "--target",
      "wasm32-wasip2",
      "--target-dir",
      target,
    ],
    { cwd: resolve("test/fixtures", name), stderr: ctx.log },
  );
  copyFileSync(
    join(
      target,
      "wasm32-wasip2/release",
      name === "wasm-http" ? "wasm_http.wasm" : "wasm-command.wasm",
    ),
    join(root, `${name}.wasm`),
  );
}
const probe = `const result=await(await fetch(process.env.API_URL)).text(); if(result!=='hello wasm') throw Error(result); const sql=new Bun.SQL(process.env.DATABASE_URL,{max:1}); try { await sql.unsafe('CREATE TABLE IF NOT EXISTS workload_runs(id int)'); await sql.unsafe('INSERT INTO workload_runs VALUES (1)'); } finally { await sql.close(); } console.log('container reached Wasm HTTP and Postgres');`;
const web = `Bun.serve({hostname:'0.0.0.0',port:3000,async fetch(){const sql=new Bun.SQL(process.env.DATABASE_URL,{max:1});try{const rows=await sql.unsafe('SELECT count(*)::int AS count FROM workload_runs');return Response.json({greeting:await(await fetch(process.env.API_URL)).text(),jobs:rows[0].count});}finally{await sql.close();}}});`;
writeFileSync(
  join(root, ".contremaitre.yaml"),
  `version: 1
project: workload-fixture
services:
  db: {kind: postgres, runtime: wasm}
  api: {runtime: wasm, wasm: {component: wasm-http.wasm}, port: 8080, http: true}
  prepare:
    runtime: wasm
    workload: job
    wasm: {component: wasm-command.wasm}
    command: [write]
    volumes: {results: /data}
  probe:
    image: oven/bun:1.3.4
    workload: job
    command: [bun, -e, ${JSON.stringify(probe)}]
    depends_on: [db, api, prepare]
    environment: {DATABASE_URL: '{{db.url}}', API_URL: '{{api.url}}'}
  worker:
    runtime: wasm
    workload: worker
    wasm: {component: wasm-command.wasm}
    command: [worker]
    depends_on: [probe]
  web:
    image: oven/bun:1.3.4
    command: [bun, -e, ${JSON.stringify(web)}]
    port: 3000
    http: true
    depends_on: [probe, db, api]
    environment: {DATABASE_URL: '{{db.url}}', API_URL: '{{api.url}}'}
verification:
  profiles:
    smoke:
      - name: response
        service: web
        command: [bun, -e, "const r=await(await fetch('http://127.0.0.1:3000')).json();if(r.greeting!=='hello wasm'||r.jobs!==1)process.exit(1)"]
`,
);
let hub = await startServer({ home: join(home, "state"), port });
let app = application({
  ...hub,
  share: async () => {
    throw Error("Sharing is disabled in fixtures");
  },
});
let retain = false;
try {
  const deployment = defineFixture({
    key: "workloads/mixed-stack",
    create: ({ dispatch, id }) =>
      Effect.gen(function* () {
        const operation = yield* dispatch(Deploy, {
          root,
          branch: `fixture-${id("environment").slice(0, 8)}`,
        });
        const result = yield* Effect.tryPromise(() => hub.operations.wait(operation.id));
        assert.equal(result.status, "succeeded", result.error ?? "deployment failed");
        return operation.environmentId;
      }),
  });
  const catalog = makeCatalog({
    base: {},
    scenarios: [
      defineScenario({
        name: "workloads/mixed-stack",
        description: "Wasm jobs and workers with container clients of Wasm HTTP and Postgres",
        input: Schema.Struct({}),
        fixtures: () => ({
          deployment,
          branch: defineFixture({
            key: "workloads/data-fork",
            dependencies: { deployment },
            create: ({ dispatch, dependencies, id }) =>
              Effect.gen(function* () {
                const designation = yield* dispatch(DesignateMain, {
                  env: dependencies.deployment,
                });
                yield* Effect.tryPromise(() => hub.operations.wait(designation.id));
                const operation = yield* dispatch(Deploy, {
                  root,
                  branch: `fork-${id("environment").slice(0, 8)}`,
                });
                const result = yield* Effect.tryPromise(() => hub.operations.wait(operation.id));
                assert.equal(
                  result.status,
                  "succeeded",
                  result.error ?? "branch deployment failed",
                );
                return operation.environmentId;
              }),
          }),
        }),
      }),
    ],
  });
  const fixtures = await Effect.runPromise(catalog.prepare("workloads/mixed-stack", {}));
  const response = async (id: string) => {
    const env = hub.manager.resolve(id);
    return (
      await fetch(`http://127.0.0.1:${hub.proxyPort}`, {
        headers: { Host: new URL(hub.manager.localURL(env, "web")).hostname },
      })
    ).json();
  };
  const receipt = await app.runPromise(
    runFixtures({
      fixtures,
      enabled: true,
      timeoutMs: 240000,
      ready: ({ values }) =>
        Effect.tryPromise(async () => {
          assert.deepEqual(await response(String(values.deployment)), {
            greeting: "hello wasm",
            jobs: 1,
          });
          assert.deepEqual(await response(String(values.branch)), {
            greeting: "hello wasm",
            jobs: 2,
          });
        }),
    }),
  );
  const id = String(receipt.values.deployment);
  const env = hub.manager.resolve(id);
  const branch = hub.manager.resolve(String(receipt.values.branch));
  assert.equal(
    readFileSync(join(home, "state/data", branch.Identity.ID, "results/result.txt"), "utf8"),
    "done\ndone\n",
  );
  assert(env.host_network);
  await hub.manager.exec(ctx, branch.Services.web, [
    "bun",
    "-e",
    "try{await fetch(process.argv[1],{signal:AbortSignal.timeout(1500)});process.exit(1)}catch{}",
    `http://${env.host_network.gateway}:${env.Services.api.BridgePorts?.["8080"]}`,
  ]);
  assert.equal(env.Services.prepare.job?.status, "succeeded");
  assert.equal(env.Services.probe.job?.status, "succeeded");
  assert.equal(env.Services.worker.ready, true);
  assert.equal(readFileSync(join(home, "state/data", id, "results/result.txt"), "utf8"), "done\n");
  // An unchanged deploy must retain both completed jobs and active relay listeners.
  await hub.manager.deploy(
    ctx,
    await hub.manager.prepare(ctx, { root, branch: env.Identity.Branch }),
  );
  assert.deepEqual(await response(id), { greeting: "hello wasm", jobs: 1 });
  // In a real hub exit this in-process worker disappears with the process.
  for (const deployed of Object.values(hub.manager.state.Environments))
    await hub.manager.backend(deployed.Services.db).stop(ctx, deployed.Services.db.Container);
  await app.dispose();
  await hub.close();
  hub = await startServer({ home: join(home, "state"), port });
  app = application({
    ...hub,
    share: async () => {
      throw Error("Sharing is disabled in fixtures");
    },
  });
  assert.deepEqual(await response(id), { greeting: "hello wasm", jobs: 1 });
  assert.deepEqual(await response(branch.Identity.ID), { greeting: "hello wasm", jobs: 2 });
  // Direct deployment does not establish source evidence; ensure records it before verification.
  const ensure = await hub.agents.ensure(ctx, { root, branch: env.Identity.Branch });
  assert.equal((await hub.operations.wait(ensure.id)).status, "succeeded");
  const checked = await hub.agents.verify(ctx, { env: id }, "smoke");
  assert("id" in checked);
  assert.equal((await hub.operations.wait(checked.id)).status, "succeeded");
  const final = await hub.agents.report(ctx, { env: id });
  assert.equal(final.ready, true);
  assert.equal(final.verification, "passed");
  console.log(
    JSON.stringify({
      scenario: "workloads/mixed-stack",
      input: {},
      run_id: receipt.runId,
      environment_id: id,
      branch_environment_id: branch.Identity.ID,
      home,
      root,
      urls: final.urls,
      review_url: final.review_url,
      verification: final.verification,
    }),
  );
  if (process.argv.includes("--keep")) {
    retain = true;
    await new Promise<void>((done) => {
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
  }
} finally {
  if (!retain) {
    for (const env of Object.values(hub.manager.state.Environments))
      await hub.manager.down(context(AbortSignal.timeout(60000)), env, true);
  } else {
    for (const env of Object.values(hub.manager.state.Environments))
      for (const service of Object.values(env.Services))
        if (service.Runtime === "wasm" && service.Spec.kind === "postgres")
          await hub.manager.backend(service).stop(context(), service.Container);
  }
  await app.dispose();
  await hub.close();
  if (!retain) rmSync(home, { recursive: true, force: true });
}
