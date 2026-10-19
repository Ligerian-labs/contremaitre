import { beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WasmtimeRuntime } from "@contremaitre/environments/wasmtime";
import { context } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";
import { application, Deploy } from "@contremaitre/hub/application";
import { startServer } from "@contremaitre/hub/server";
import {
  defineFixture,
  defineScenario,
  makeCatalog,
  run as runFixtures,
} from "@structure-ai/fixtures";
import { Effect, Schema } from "effect";
import { FakeRuntime } from "./fake-runtime.js";
import { freePort } from "./ports.js";

const runtime = process.env.CONTREMAITRE_WASIX_RUNTIME;
const available = !!(Bun.which("wasmer") && runtime);
beforeAll(() => {
  if (!available && process.env.CONTREMAITRE_REQUIRE_WASMER === "1")
    throw Error(
      "Wasmer 7.5+ and CONTREMAITRE_WASIX_RUNTIME are required; run bun scripts/prepare-wasix-tests.ts",
    );
});
const real = available ? test : test.skip;
// biome-ignore lint/suspicious/noTemplateCurlyInString: Verify literal dotenv substitutions.
const greeting = 'private = "hello" \\ $HOME ${USER}';
const ctx = context();

real(
  "wasix/host-http deploys isolated WASM guests, retains private env, and restarts without source",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "cm-wasix-"));
    const root = join(home, "project");
    await mkdir(join(root, "app"), { recursive: true });
    await cp(resolve("test/fixtures/wasix-http/main.cjs"), join(root, "app/main.cjs"));
    await writeFile(
      join(root, "wasmer.toml"),
      `[package]
entrypoint = "serve"
[fs]
"/app" = "./app"
"/etc" = ${JSON.stringify(join(runtime ?? "", "etc"))}
"/usr/local/ssl" = ${JSON.stringify(join(runtime ?? "", "ssl-certs"))}
[[module]]
name = "edge"
source = ${JSON.stringify(join(runtime ?? "", "modules/edge"))}
[[command]]
name = "serve"
module = "edge"
runner = "https://webc.org/runner/wasi"
[command.annotations.wasi]
main-args = ["/app/main.cjs"]
`,
    );
    await run(ctx, ["wasmer", "package", "build", root, "--out", join(root, "app.webc")]);
    await writeFile(
      join(root, ".contremaitre.yaml"),
      `version: 1
project: wasix-fixture
services:
  web:
    runtime: wasm
    wasm: {engine: wasmer, component: app.webc}
    port: 8080
    http: true
    environment:
      GREETING: ${JSON.stringify(greeting)}
      PORT: "1"
      HOST: "0.0.0.0"
`,
    );
    const apple = new FakeRuntime();
    const hub = await startServer({
      home,
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
    const web = defineFixture({
      key: "wasix/http-app",
      create: ({ dispatch }) =>
        Effect.gen(function* () {
          const environments: string[] = [];
          for (const branch of ["main", "branch"]) {
            const op = yield* dispatch(Deploy, { root, branch });
            const result = yield* Effect.tryPromise(() => hub.operations.wait(op.id));
            if (result.status !== "succeeded") throw Error(result.error ?? result.status);
            environments.push(op.environmentId);
          }
          return environments;
        }),
    });
    const catalog = makeCatalog({
      base: { web },
      scenarios: [
        defineScenario({
          name: "wasix/host-http",
          description: "Node-compatible HTTP applications execute inside Wasm on reserved ports",
          input: Schema.Struct({}),
          fixtures: () => ({ web }),
        }),
      ],
    });
    const previous = process.env.WASIX_HOST_ONLY;
    const previousForward = process.env.FORWARD_HOST_ENV;
    process.env.WASIX_HOST_ONLY = "must-not-enter-guest";
    process.env.FORWARD_HOST_ENV = "true";
    try {
      const fixtures = await Effect.runPromise(catalog.prepare("wasix/host-http", {}));
      const report = await app.runPromise(
        runFixtures({
          fixtures,
          enabled: true,
          ready: ({ values }) =>
            Effect.tryPromise(async () => {
              const environments = values.web as string[];
              const ports: number[] = [];
              for (const id of environments) {
                const env = hub.manager.resolve(id);
                const service = env.Services.web;
                const port = service.Ports?.["8080"] ?? 0;
                ports.push(port);
                const check = async () => {
                  const result = await (await fetch(`http://127.0.0.1:${port}`)).json();
                  expect(result).toEqual({
                    platform: "wasi",
                    arch: "wasm32",
                    greeting,
                    host: "127.0.0.1",
                    port: String(port),
                  });
                };
                await check();
                const record = JSON.parse(
                  await readFile(join(home, "wasmtime", `${service.Container}.json`), "utf8"),
                );
                expect(record.service.wasm.engine).toBe("wasmer");
                expect(record.argv.join(" ")).not.toContain(greeting);
                expect(record.argv.join(" ")).not.toContain("--forward-host-env");
                expect(
                  (await stat(join(home, "wasmtime", `${service.Container}.env`))).mode & 0o777,
                ).toBe(0o600);
                const replacement = new WasmtimeRuntime({ home, apple });
                expect((await replacement.inspect(ctx, service.Container))?.Running).toBe(true);
                await replacement.stop(ctx, service.Container);
                await replacement.start(ctx, service.Container);
                await check();
              }
              expect(ports[0]).not.toBe(ports[1]);
              await rm(root, { recursive: true, force: true });
              const env = hub.manager.resolve(environments[0]);
              const service = env.Services.web;
              const backend = hub.manager.backend(service);
              await backend.stop(ctx, service.Container);
              await backend.start(ctx, service.Container);
              expect(
                (await (await fetch(`http://127.0.0.1:${service.Ports?.["8080"]}`)).json())
                  .greeting,
              ).toBe(greeting);
            }),
        }),
      );
      expect(report.values.web).toHaveLength(2);
      expect(apple.calls).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.WASIX_HOST_ONLY;
      else process.env.WASIX_HOST_ONLY = previous;
      if (previousForward === undefined) delete process.env.FORWARD_HOST_ENV;
      else process.env.FORWARD_HOST_ENV = previousForward;
      for (const env of hub.manager.list()) await hub.manager.down(ctx, env, true);
      await hub.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  120000,
);
