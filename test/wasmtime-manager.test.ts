import { beforeAll, expect, test } from "bun:test";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Manager } from "@contremaitre/environments/manager";
import { addressURL, serviceAddress } from "@contremaitre/environments/model";
import { Store } from "@contremaitre/environments/store";
import { context } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";
import { application, Deploy } from "@contremaitre/hub/application";
import { routes, startServer } from "@contremaitre/hub/server";
import { parseManifest, prepareManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { proxyServer } from "@contremaitre/routing/proxy";
import {
  defineFixture,
  defineScenario,
  makeCatalog,
  run as runFixtures,
} from "@structure-ai/fixtures";
import { Effect, Schema } from "effect";
import { FakeRuntime } from "./fake-runtime.js";

const available = !!(
  Bun.which("wasmtime") &&
  Bun.which("cargo") &&
  Bun.spawnSync(["rustup", "target", "list", "--installed"])
    .stdout.toString()
    .includes("wasm32-wasip2")
);
const real = available ? test : test.skip;
const ctx = context();
beforeAll(() => {
  if (!available && process.env.CONTREMAITRE_REQUIRE_WASMTIME === "1")
    throw Error("Required wasmtime/cargo/wasm32-wasip2 toolchain missing");
});
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw Error("Condition timed out");
}
async function fixture(dev = false) {
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cm-wasm-manager-")));
  const root = join(home, "project");
  await fs.cp(resolve("test/fixtures/wasm-http"), root, {
    recursive: true,
    filter: (p) => !p.includes("/target"),
  });
  const text = `version: 1
project: wasm-test
services:
  web:
    runtime: wasm
    wasm:
      build: [cargo, build, --release, --target, wasm32-wasip2, --locked]
      component: target/wasm32-wasip2/release/wasm_http.wasm
    port: 8080
    http: true
${dev ? "    dev: {source: ., exclude: [target]}\n" : "    environment: {GREETING: manifest-env}\n"}`;
  const manager = () => new Manager(new Store(home), new FakeRuntime(), 48399);
  const prepared = {
    root,
    identity: newIdentity("wasm-test", root, "main"),
    manifest: prepareManifest(root, parseManifest(text)),
    request: {},
  };
  await fs.writeFile(join(root, ".contremaitre.yaml"), text);
  return { home, root, manager, prepared };
}
real(
  "Manager deploy, hub routing, CLI logs, stop/start, surviving and killed process recovery, down cleanup",
  async () => {
    const f = await fixture();
    let m = f.manager();
    const proxy = proxyServer((host) => routes(m, host));
    try {
      await m.deploy(ctx, f.prepared);
      let env = m.resolve(f.prepared.identity.ID);
      let service = env.Services.web;
      const recordPath = join(f.home, "wasmtime", `${service.Container}.json`);
      const record = async () => JSON.parse(await fs.readFile(recordPath, "utf8"));
      const get = async () =>
        (
          await fetch(
            addressURL(
              serviceAddress(service, service.Port) ??
                (() => {
                  throw Error("Missing service address");
                })(),
            ),
          )
        ).text();
      expect(service.Host).toBe("127.0.0.1");
      expect(service.Ports?.["8080"]).toBeGreaterThan(0);
      expect(service.Image).toBe(env.builds?.web.image ?? "");
      expect(await get()).toBe("manifest-env");
      const host = new URL(m.localURL(env, "web")).hostname;
      expect(routes(m, host)?.upstream).toBe(
        addressURL(
          serviceAddress(service, service.Port) ??
            (() => {
              throw Error("Missing service address");
            })(),
        ),
      );
      const [low, high] = (process.env.CONTREMAITRE_WASMTIME_TEST_PORTS ?? "48300-48399")
        .split("-")
        .map(Number);
      let bound = false;
      for (let port = low; port <= high; port++) {
        try {
          await new Promise<void>((done, reject) => {
            proxy.once("error", reject);
            proxy.listen(port, "127.0.0.1", () => {
              proxy.removeListener("error", reject);
              done();
            });
          });
          bound = true;
          break;
        } catch {}
      }
      if (!bound) throw Error("Test proxy port band exhausted");
      const address = proxy.address();
      if (!address || typeof address === "string") throw Error("Proxy not listening");
      expect(
        await (await fetch(`http://127.0.0.1:${address.port}`, { headers: { Host: host } })).text(),
      ).toBe("manifest-env");
      let output = "";
      // The CLI builds a separate registry and requests a finite log snapshot.
      await f
        .manager()
        .backend(service)
        .logs(
          context(undefined, (chunk) => {
            output += chunk.toString();
          }),
          service.Container,
          false,
        );
      expect(output).toContain("wasm request");
      const first = await record();
      m = f.manager();
      await m.recover(ctx);
      env = m.resolve(f.prepared.identity.ID);
      service = env.Services.web;
      expect((await record()).pid).toBe(first.pid);
      expect(await get()).toBe("manifest-env");
      process.kill(first.pid, "SIGKILL");
      await until(async () => !(await m.backend(service).inspect(ctx, service.Container))?.Running);
      m = f.manager();
      await m.recover(ctx);
      env = m.resolve(f.prepared.identity.ID);
      service = env.Services.web;
      expect((await record()).pid).not.toBe(first.pid);
      expect(await get()).toBe("manifest-env");
      const restarted = await record();
      // Environment shutdown removes runtime state; redeployment starts it again.
      await m.down(ctx, env);
      expect(() => process.kill(restarted.pid, 0)).toThrow();
      await m.deploy(ctx, f.prepared);
      env = m.resolve(f.prepared.identity.ID);
      service = env.Services.web;
      expect(await get()).toBe("manifest-env");
      const final = await record();
      await m.down(ctx, env, true);
      expect(() => process.kill(final.pid, 0)).toThrow();
      expect(existsSync(recordPath)).toBe(false);
      expect(existsSync(final.log)).toBe(false);
    } finally {
      proxy.closeAllConnections();
      if (proxy.listening) await new Promise<void>((done) => proxy.close(() => done()));
      for (const env of m.list()) await m.down(ctx, env, true);
      await fs.rm(f.home, { recursive: true, force: true });
    }
  },
  120000,
);
real(
  "Manager dev recovery reattaches in-place watcher after the deploying hub exits naturally",
  async () => {
    const f = await fixture(true);
    let m = f.manager();
    try {
      const script = join(f.home, "deploy.ts");
      const imports = [
        ["Manager", "packages/environments/src/manager.ts"],
        ["Store", "packages/environments/src/store.ts"],
        ["context", "packages/execution/src/context.ts"],
        ["parseManifest, prepareManifest", "packages/projects/src/config.ts"],
        ["newIdentity", "packages/projects/src/model.ts"],
        ["FakeRuntime", "test/fake-runtime.ts"],
      ]
        .map(([names, path]) => `import { ${names} } from ${JSON.stringify(resolve(path))};`)
        .join("\n");
      await fs.writeFile(
        script,
        `${imports}
const home = ${JSON.stringify(f.home)}, root = ${JSON.stringify(f.root)};
const text = await Bun.file(root + "/.contremaitre.yaml").text();
await new Manager(new Store(home), new FakeRuntime(), 48399).deploy(context(), {
root, identity: newIdentity("wasm-test", root, "main"), manifest: prepareManifest(root, parseManifest(text)), request: {}
});`,
      );
      // Natural exit proves Bun's FSWatcher.unref and timer.unref do not hold the hub open.
      await run(context(AbortSignal.timeout(60000)), [process.execPath, script]);
      m = f.manager();
      await m.recover(ctx);
      const env = m.resolve(f.prepared.identity.ID),
        service = env.Services.web;
      const path = join(f.home, "wasmtime", `${service.Container}.json`);
      const first = JSON.parse(await fs.readFile(path, "utf8"));
      await m.recover(ctx); // Repeated inspect must not add watchers.
      expect(JSON.parse(await fs.readFile(path, "utf8")).pid).toBe(first.pid);
      const source = join(f.root, "src/lib.rs");
      await fs.writeFile(
        source,
        (await fs.readFile(source, "utf8")).replace("hello wasm", "manager changed"),
      );
      await until(
        async () =>
          (await (
            await fetch(
              addressURL(
                serviceAddress(service, service.Port) ??
                  (() => {
                    throw Error("Missing service address");
                  })(),
              ),
            )
          ).text()) === "manager changed",
      );
      expect(existsSync(join(f.home, "sources"))).toBe(false);
      expect(JSON.parse(await fs.readFile(path, "utf8")).pid).not.toBe(first.pid);
    } finally {
      // Reload state if deployment failed before the first recover.
      const cleanup = m.list().length ? m : f.manager();
      for (const env of cleanup.list()) await cleanup.down(ctx, env, true);
      await fs.rm(f.home, { recursive: true, force: true });
    }
  },
  120000,
);
test("WASM example uses the merged manifest fields", async () => {
  const manifest = parseManifest(await fs.readFile("examples/wasm-app/.contremaitre.yaml", "utf8"));
  expect(manifest.services.web.runtime).toBe("wasm");
  expect(manifest.services.web.wasm?.component).toContain("wasm_http.wasm");
});

real(
  "real hub routes the runnable WASM example through its localhost hostname",
  async () => {
    const f = await fixture();
    const port = Number(
      (process.env.CONTREMAITRE_WASMTIME_TEST_PORTS ?? "48300-48399").split("-")[1],
    );
    const hub = await startServer({
      home: f.home,
      port,
      runtime: new FakeRuntime(),
      skipSystemStart: true,
    });
    try {
      await fs.rm(f.root, { recursive: true, force: true });
      await fs.cp(resolve("examples/wasm-app"), f.root, {
        recursive: true,
        filter: (p) => !p.includes("/target"),
      });
      const app = application({
        ...hub,
        share: async () => {
          throw Error("Sharing disabled in WASM fixture");
        },
      });
      const web = defineFixture({
        key: "wasm/http-app",
        create: ({ dispatch }) =>
          Effect.gen(function* () {
            const operation = yield* dispatch(Deploy, { root: f.root, branch: "main" });
            const result = yield* Effect.tryPromise(() => hub.operations.wait(operation.id));
            expect(result.status).toBe("succeeded");
            if (result.status !== "succeeded") throw Error(result.error);
            return operation.environmentId;
          }),
      });
      const catalog = makeCatalog({
        base: { web },
        scenarios: [
          defineScenario({
            name: "wasm/localhost-http",
            description: "Real WASI HTTP app behind an isolated hub",
            input: Schema.Struct({}),
            fixtures: () => ({ web }),
          }),
        ],
      });
      const fixtures = await Effect.runPromise(catalog.prepare("wasm/localhost-http", {}));
      const report = await app.runPromise(
        runFixtures({
          fixtures,
          enabled: true,
          ready: ({ values }) =>
            Effect.tryPromise(async () => {
              const env = hub.manager.resolve(String(values.web));
              const host = new URL(hub.manager.localURL(env, "web")).hostname;
              expect(host.endsWith(".localhost")).toBe(true);
              expect(
                await (
                  await fetch(`http://127.0.0.1:${hub.proxyPort}`, {
                    headers: { Host: host },
                  })
                ).text(),
              ).toBe("hello wasm");
            }),
        }),
      );
      expect(report.values.web).toBeTruthy();
    } finally {
      for (const env of hub.manager.list()) await hub.manager.down(ctx, env, true);
      await hub.close();
      await fs.rm(f.home, { recursive: true, force: true });
    }
  },
  120000,
);
