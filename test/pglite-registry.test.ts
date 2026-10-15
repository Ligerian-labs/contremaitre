import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Manager } from "@contremaitre/environments/manager";
import { PGliteRuntime } from "@contremaitre/environments/pglite-runtime";
import { runtimeRegistry } from "@contremaitre/environments/runtimes";
import { Store } from "@contremaitre/environments/store";
import { WasmtimeRuntime } from "@contremaitre/environments/wasmtime";
import { context } from "@contremaitre/execution/context";
import { parseManifest, prepareManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { SQL } from "bun";
import { FakeRuntime } from "./fake-runtime.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";

checkPgliteCleanup();

test("real registry retains Wasmtime app and PGlite postgres; WASM app consumes the loopback database URL", async () => {
  const home = await mkdtemp(join(tmpdir(), "cm-pglite-registry-")),
    root = join(home, "project");
  await mkdir(root);
  const apple = new FakeRuntime(),
    registry = runtimeRegistry({ home, apple });
  expect(registry.wasm.app).toBeInstanceOf(WasmtimeRuntime);
  expect(registry.wasm.postgres).toBeInstanceOf(PGliteRuntime);
  const manager = new Manager(new Store(home), apple, 48570, "http", registry);
  const ctx = context();
  const available = !!(
    Bun.which("wasmtime") &&
    Bun.which("cargo") &&
    Bun.which("rustup") &&
    Bun.spawnSync(["rustup", "target", "list", "--installed"])
      .stdout.toString()
      .includes("wasm32-wasip2")
  );
  try {
    if (available) {
      await cp(resolve("test/fixtures/wasm-http"), root, {
        recursive: true,
        filter: (path) => !path.includes("/target"),
      });
      const build = Bun.spawn(
        ["cargo", "build", "--release", "--target", "wasm32-wasip2", "--locked", "--jobs", "1"],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const [code, _out, err] = await Promise.all([
        build.exited,
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
      ]);
      expect(code, err).toBe(0);
    }
    const app = `  web:\n    runtime: wasm\n    wasm: {component: target/wasm32-wasip2/release/wasm_http.wasm}\n    port: 48571\n    http: true\n    depends_on: [db]\n    environment: {GREETING: '{{db.url}}', DATABASE_URL: '{{db.url}}'}\n`;
    const text = `version: 1\nproject: combined-wasm\nservices:\n  db: {kind: postgres, runtime: wasm}\n${app}`;
    const manifest = parseManifest(text);
    const identity = newIdentity("combined-wasm", root, "main");
    await manager.deploy(ctx, {
      root,
      identity,
      manifest: prepareManifest(root, available ? manifest : parseManifest(text.replace(app, ""))),
      request: {},
    });
    const env = manager.resolve(identity.ID),
      db = env.Services.db;
    const consumer = available
      ? env.Services.web
      : { ...db, Name: "web", Spec: manifest.services.web };
    const url = manager.serviceEnv(env, consumer).DATABASE_URL;
    expect(url).toBe(
      `postgresql://app:${env.credentials?.db}@127.0.0.1:${db.Ports?.["5432"]}/app?sslmode=disable`,
    );
    if (available) {
      const response = await fetch(`http://127.0.0.1:${env.Services.web.Ports?.["48571"]}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(url);
    } else
      console.log("WASI toolchain unavailable: registry + Manager.serviceEnv fallback exercised");
    const sql = new SQL(url, { max: 1 });
    try {
      expect((await sql`SELECT 42 AS n`)[0].n).toBe(42);
    } finally {
      await sql.close();
    }
    expect(apple.calls).toEqual([]);
  } finally {
    for (const env of manager.list()) await manager.down(ctx, env, true);
    await rm(home, { recursive: true, force: true });
  }
}, 120000);
