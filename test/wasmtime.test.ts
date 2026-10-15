import { afterEach, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunSpec } from "@contremaitre/environments/runtimes";
import { WasmtimeRuntime } from "@contremaitre/environments/wasmtime";
import { context } from "@contremaitre/execution/context";
import { privateEnv } from "@contremaitre/execution/files";
import { run } from "@contremaitre/execution/process";
import type { Service } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";

const fixture = resolve("test/fixtures/wasm-http");
const cache = join(tmpdir(), "contremaitre-wasm-fixture");
const component = join(cache, "wasm32-wasip2/release/wasm_http.wasm");
const range = (process.env.CONTREMAITRE_WASMTIME_TEST_PORTS ?? "48300-48399")
  .split("-")
  .map(Number);
let nextPort = range[0];
const ctx = context();
const available = !!(
  Bun.which("wasmtime") &&
  Bun.which("cargo") &&
  Bun.which("rustup") &&
  Bun.spawnSync(["rustup", "target", "list", "--installed"])
    .stdout.toString()
    .includes("wasm32-wasip2")
);
if (!available)
  console.warn("Skipping real wasmtime tests: wasmtime, cargo or wasm32-wasip2 target unavailable");
const real = available ? test : test.skip;
let directory = "";
let runtime: WasmtimeRuntime;
const runtimes: WasmtimeRuntime[] = [];
beforeAll(async () => {
  if (!available) {
    if (process.env.CONTREMAITRE_REQUIRE_WASMTIME === "1")
      throw new Error("Required wasmtime/cargo/wasm32-wasip2 toolchain missing");
    return;
  }
  await run(ctx, ["cargo", "build", "--release", "--target", "wasm32-wasip2", "--locked"], {
    cwd: fixture,
    env: { ...process.env, CARGO_TARGET_DIR: cache },
  });
}, 120000);
afterEach(async () => {
  if (!directory) return;
  try {
    for (const r of runtimes)
      for (const name of ["app", "crash", "broken"]) await r.remove(ctx, name);
  } finally {
    runtimes.length = 0;
    await fs.rm(directory, { recursive: true, force: true });
    directory = "";
  }
});
function fresh() {
  const r = new WasmtimeRuntime({ home: directory, apple: new FakeRuntime() });
  runtimes.push(r);
  return r;
}
async function setup() {
  directory = await fs.mkdtemp(join(tmpdir(), "contremaitre-wasmtime-"));
  runtime = fresh();
}
async function record(name = "app") {
  return JSON.parse(await fs.readFile(join(directory, "wasmtime", `${name}.json`), "utf8"));
}
async function body(port: number) {
  return (await fetch(`http://127.0.0.1:${port}`)).text();
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error("Condition timed out");
}
async function spec(
  options: Partial<RunSpec> = {},
  env: Record<string, string> = {},
): Promise<RunSpec> {
  const port = nextPort++;
  if (port > range[1]) throw new Error("Test port band exhausted");
  const data = join(directory, options.name ?? "app");
  await fs.mkdir(data, { recursive: true });
  return {
    name: "app",
    image: component,
    network: "",
    volumes: {},
    service: { port: 8080, wasm: { component }, dev: undefined },
    root: cache,
    data,
    ports: { "8080": port },
    envFile: privateEnv(directory, env),
    ...options,
  };
}
const portOf = (s: RunSpec) => s.ports?.["8080"] ?? 0;
test("constructing the runtime has no filesystem side effects", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "cm-wasm-constructor-"));
  try {
    const missing = join(home, "missing");
    new WasmtimeRuntime({ home: missing, apple: new FakeRuntime() });
    expect(await fs.readdir(home)).toEqual([]);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
test("preflight explains how to install missing wasmtime", async () => {
  const path = process.env.PATH;
  try {
    process.env.PATH = "/nonexistent";
    await expect(
      new WasmtimeRuntime({ home: "/unused", apple: new FakeRuntime() }).preflight(ctx),
    ).rejects.toThrow("brew install wasmtime");
  } finally {
    process.env.PATH = path;
  }
});
real("build checks root boundaries and retains an unchanged previous record", async () => {
  await setup();
  await expect(
    runtime.build(ctx, {
      root: fixture,
      name: "app",
      tag: "test",
      service: { wasm: { component: "../escape.wasm" } },
    }),
  ).rejects.toThrow("escapes");
  const request = {
    root: cache,
    name: "app",
    tag: "test",
    service: { wasm: { component: "wasm32-wasip2/release/wasm_http.wasm" } },
  };
  const built = await runtime.build(ctx, request);
  expect(built.digest).toHaveLength(64);
  expect(built.image).toBe(await fs.realpath(component));
  expect(await runtime.build(ctx, request, built)).toBe(built);
});
real("build directory is inside root and component remains relative to root", async () => {
  await setup();
  const root = join(directory, "build");
  await fs.mkdir(join(root, "nested"), { recursive: true });
  const request = {
    root,
    name: "app",
    tag: "test",
    service: {
      port: 8080,
      wasm: {
        directory: "nested",
        build: ["/bin/cp", component, "../app.wasm"],
        component: "app.wasm",
      },
    },
  };
  const built = await runtime.build(ctx, request);
  expect(built.image).toBe(join(await fs.realpath(root), "app.wasm"));
  await fs.symlink(component, join(root, "escape.wasm"));
  await expect(
    runtime.build(ctx, { ...request, service: { wasm: { component: "escape.wasm" } } }),
  ).rejects.toThrow("escapes");
});
real(
  "serve, private env inheritance, logs, replacement, stop, same-port start and remove",
  async () => {
    await setup();
    const s = await spec({}, { GREETING: 'secret = "hello"' });
    await runtime.run(ctx, {
      ...s,
      service: { ...s.service, ...{ kind: "app", environment: {} } },
    });
    await fs.rm(s.envFile);
    expect(await body(portOf(s))).toBe('secret = "hello"');
    const first = await record();
    const args = (await run(ctx, ["/bin/ps", "-o", "args=", "-p", String(first.pid)])).toString();
    expect(args).toContain("--env GREETING");
    expect(args).not.toContain("secret");
    expect((await fs.stat(join(directory, "wasmtime/app.json"))).mode & 0o777).toBe(0o600);
    expect(first.cwd).toBe(s.data);
    expect(first.argv).not.toContain("--dir");
    let output = "";
    await runtime.logs(
      context(undefined, (s) => {
        output += s.toString();
      }),
      "app",
    );
    expect(output).toContain("wasm request");
    const controller = new AbortController();
    const follow = runtime.logs(context(controller.signal), "app", true);
    controller.abort();
    await follow;
    await runtime.stop(ctx, "app");
    expect((await runtime.inspect(ctx, "app"))?.Running).toBe(false);
    await until(async () => {
      try {
        process.kill(first.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(() => process.kill(first.pid, 0)).toThrow();
    await runtime.start(ctx, "app");
    expect((await record()).port).toBe(portOf(s));
    expect(await body(portOf(s))).toBe('secret = "hello"');
    const old = await record();
    const replacement = await spec({ ports: s.ports });
    await runtime.run(ctx, replacement);
    await until(async () => {
      try {
        process.kill(old.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(() => process.kill(old.pid, 0)).toThrow();
    expect(await body(portOf(s))).toBe("hello wasm");
    await runtime.remove(ctx, "app");
    await runtime.remove(ctx, "app");
    await runtime.logs(ctx, "app");
    expect(await runtime.inspect(ctx, "app")).toBeUndefined();
  },
  30000,
);
real("task and missing port mapping fail clearly", async () => {
  await setup();
  const s = await spec();
  await expect(runtime.run(ctx, { ...s, task: true })).rejects.toThrow("no tasks");
  await expect(runtime.run(ctx, { ...s, ports: {} })).rejects.toThrow("Missing reserved");
});
real(
  "recovery isolates broken records, reattaches survivors, restarts killed services and preserves stops",
  async () => {
    await setup();
    const s = await spec();
    await runtime.run(ctx, s);
    const first = await record();
    const broken = await spec({ name: "broken", image: join(directory, "deleted.wasm") });
    await fs.copyFile(component, broken.image);
    await runtime.run(ctx, broken);
    process.kill((await record("broken")).pid, "SIGKILL");
    await fs.rm(broken.image);
    runtime = fresh();
    expect((await runtime.inspect(ctx, "app"))?.Running).toBe(true);
    const outcomes = await runtime.recover(ctx);
    expect(outcomes.app).toBe("reattached");
    expect(outcomes.broken).toStartWith("failed:");
    process.kill(first.pid, "SIGKILL");
    await until(async () => !(await runtime.inspect(ctx, "app"))?.Running);
    expect((await runtime.recover(ctx)).app).toBe("restarted");
    expect(await body(portOf(s))).toBe("hello wasm");
    await runtime.stop(ctx, "app");
    expect((await runtime.recover(ctx)).app).toBe("stopped");
    await fs.writeFile(join(directory, "wasmtime/broken.json"), "{}");
    expect((await runtime.recover(ctx)).broken).toContain("failed:");
    await fs.rm(join(directory, "wasmtime/broken.json"));
  },
  30000,
);
real(
  "detached wasmtime survives a hub crash and recovery restores its dev watcher",
  async () => {
    await setup();
    const root = join(directory, "source");
    await fs.mkdir(root);
    await fs.copyFile(component, join(root, "app.wasm"));
    const service: Service = {
      port: 8080,
      wasm: { component: "app.wasm", build: ["/bin/sh", "-c", "echo build >> builds"] },
      dev: { source: ".", exclude: ["builds"] },
    };
    const s = await spec({
      name: "crash",
      root,
      source: root,
      image: join(root, "app.wasm"),
      service,
    });
    const script = join(directory, "hub.ts");
    await fs.writeFile(
      script,
      `import { WasmtimeRuntime } from ${JSON.stringify(import.meta.resolve("@contremaitre/environments/wasmtime"))};\nimport { FakeRuntime } from ${JSON.stringify(import.meta.resolve("./fake-runtime.js"))};\nawait new WasmtimeRuntime({ home: ${JSON.stringify(directory)}, apple: new FakeRuntime() }).run({ signal: new AbortController().signal, log() {} }, ${JSON.stringify(s)});\nconsole.log("ready"); setInterval(() => {}, 1000);`,
    );
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((done, reject) => {
        child.stdout?.once("data", () => done());
        child.once("exit", () => reject(new Error("hub exited before readiness")));
      });
      const first = await record("crash");
      child.kill("SIGKILL");
      await new Promise<void>((done) => child.once("exit", () => done()));
      expect((await runtime.recover(ctx)).crash).toBe("reattached");
      expect((await record("crash")).pid).toBe(first.pid);
      await fs.writeFile(join(root, "change"), "changed");
      await until(async () => (await record("crash")).pid !== first.pid);
      expect(await fs.readFile(join(root, "builds"), "utf8")).toContain("build");
    } finally {
      child.kill("SIGKILL");
    }
  },
  30000,
);
real(
  "dev watches in place beyond deploy cancellation, honors excludes, retains old process on build failure",
  async () => {
    await setup();
    const root = join(directory, "source");
    await fs.cp(fixture, root, { recursive: true, filter: (p) => !p.includes("/target") });
    const service: Service = {
      port: 8080,
      wasm: {
        build: [
          "/bin/sh",
          "-c",
          "echo build >> builds; cargo build --release --target wasm32-wasip2 --locked",
        ],
        directory: ".",
        component: "target/wasm32-wasip2/release/wasm_http.wasm",
      },
      dev: { source: ".", exclude: ["target", "builds", "excluded"] },
    };
    const built = await runtime.build(ctx, { root, name: "app", service, tag: "test" });
    const s = await spec({ root, image: built.image, source: root, service });
    const controller = new AbortController();
    let output = "";
    await runtime.run(
      context(controller.signal, (s) => {
        output += s.toString();
      }),
      s,
    );
    controller.abort();
    const first = await record();
    await fs.mkdir(join(root, "excluded"));
    await fs.writeFile(join(root, "excluded/nope"), "ignored");
    await Bun.sleep(1000);
    expect((await record()).pid).toBe(first.pid);
    expect((await fs.readFile(join(root, "builds"), "utf8")).trim()).toBe("build");
    const source = join(root, "src/lib.rs");
    const original = await fs.readFile(source, "utf8");
    await fs.writeFile(source, original.replace("hello wasm", "changed wasm"));
    await until(async () => {
      try {
        return (await body(portOf(s))) === "changed wasm";
      } catch {
        return false;
      }
    });
    await fs.writeFile(source, "compile error");
    await until(async () =>
      (await fs.readFile(join(directory, "wasmtime/app.log"), "utf8")).includes(
        "WASM rebuild failed:",
      ),
    );
    expect(output).not.toContain("WASM rebuild failed:");
    expect(await body(portOf(s))).toBe("changed wasm");
    await runtime.stop(ctx, "app");
    await fs.writeFile(source, original);
    await runtime.start(ctx, "app");
    const restarted = await record();
    // Let macOS finish retiring the old FSEvents stream before editing again.
    await Bun.sleep(500);
    await fs.writeFile(source, original.replace("hello wasm", "again wasm"));
    await until(async () => (await record()).pid !== restarted.pid);
  },
  120000,
);
real(
  "oversized logs rotate on start",
  async () => {
    await setup();
    const s = await spec();
    await runtime.run(ctx, s);
    await runtime.stop(ctx, "app");
    const log = join(directory, "wasmtime/app.log");
    await fs.writeFile(log, "x".repeat(5 * 1024 ** 2 + 1));
    await runtime.start(ctx, "app");
    expect((await fs.stat(`${log}.1`)).size).toBe(5 * 1024 ** 2 + 1);
    expect((await record()).port).toBe(portOf(s));
  },
  30000,
);
