import { afterEach, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { context } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";
import { WasmtimeRuntime } from "../packages/environments/src/wasmtime.ts";

const fixture = resolve("test/fixtures/wasm-http");
const cache = join(tmpdir(), "contremaitre-wasm-fixture");
const component = join(cache, "wasm32-wasip2/release/wasm_http.wasm");
const range = (process.env.CONTREMAITRE_WASMTIME_TEST_PORTS ?? "48300-48399")
  .split("-")
  .map(Number);
const ports = { from: range[0], to: range[1] };
const ctx = context();
const rust =
  Bun.which("rustup") &&
  Bun.spawnSync(["rustup", "target", "list", "--installed"])
    .stdout.toString()
    .includes("wasm32-wasip2");
const available = !!(Bun.which("wasmtime") && Bun.which("cargo") && rust);
if (!available)
  console.warn("Skipping real wasmtime tests: wasmtime, cargo or wasm32-wasip2 target unavailable");
const real = available ? test : test.skip;
let directory = "";
let runtime: WasmtimeRuntime;
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
    for (const name of ["app", "crash"]) await runtime.remove(ctx, name);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    directory = "";
  }
});
async function setup() {
  directory = await fs.mkdtemp(join(tmpdir(), "contremaitre-wasmtime-"));
  runtime = new WasmtimeRuntime(join(directory, "state"), ports);
}
async function record(name = "app") {
  return JSON.parse(await fs.readFile(join(directory, "state", `${name}.json`), "utf8"));
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
test("preflight explains how to install missing wasmtime", async () => {
  const path = process.env.PATH;
  try {
    process.env.PATH = "/nonexistent";
    await expect(new WasmtimeRuntime("/unused").preflight(ctx)).rejects.toThrow(
      "brew install wasmtime",
    );
  } finally {
    process.env.PATH = path;
  }
});
real("host build rejects escaping component paths", async () => {
  await setup();
  await expect(
    runtime.build(ctx, { root: fixture, command: ["true"], component: "../escape.wasm" }),
  ).rejects.toThrow("escapes");
});
real(
  "build, serve, logs, stop, same-port start and remove",
  async () => {
    await setup();
    const root = join(directory, "build");
    await fs.cp(fixture, root, { recursive: true, filter: (p) => !p.includes("/target") });
    const built = await runtime.build(ctx, {
      root,
      command: "cargo build --release --target wasm32-wasip2 --locked",
      component: "target/wasm32-wasip2/release/wasm_http.wasm",
      env: { CARGO_TARGET_DIR: join(root, "target") },
    });
    expect(built.digest).toHaveLength(64);
    const running = await runtime.start(ctx, {
      name: "app",
      component: built.component,
      env: {},
    });
    expect(await body(running.port)).toBe("hello wasm");
    const controller = new AbortController();
    let output = "";
    const logs = runtime.logs(
      context(controller.signal, (s) => {
        output += s.toString();
      }),
      "app",
    );
    try {
      await until(async () => output.includes("wasm request"));
    } finally {
      controller.abort();
      await logs;
    }
    const first = await record();
    await runtime.stop(ctx, "app");
    expect((await runtime.inspect("app"))?.Running).toBe(false);
    expect(() => process.kill(first.pid, 0)).toThrow();
    await expect(body(running.port)).rejects.toThrow();
    expect((await runtime.start(ctx, "app"))?.port).toBe(running.port);
    expect(await body(running.port)).toBe("hello wasm");
    const restarted = await record();
    await runtime.remove(ctx, "app");
    expect(() => process.kill(restarted.pid, 0)).toThrow();
    expect(await runtime.inspect("app")).toBeUndefined();
    expect(await fs.readdir(join(directory, "state"))).toEqual([]);
  },
  120000,
);
real(
  "recovery reattaches, restarts killed services, and preserves stopped intent",
  async () => {
    await setup();
    const serving = await runtime.start(ctx, { name: "app", component, env: {} });
    const first = await record();
    runtime = new WasmtimeRuntime(join(directory, "state"), ports);
    expect((await runtime.recover(ctx)).app).toBe("reattached");
    expect((await record()).pid).toBe(first.pid);
    process.kill(first.pid, "SIGKILL");
    await until(async () => !(await runtime.inspect("app"))?.Running);
    expect((await runtime.recover(ctx)).app).toBe("restarted");
    expect((await record()).pid).not.toBe(first.pid);
    expect(await body(serving.port)).toBe("hello wasm");
    await runtime.stop(ctx, "app");
    expect((await runtime.recover(ctx)).app).toBe("stopped");
    expect((await runtime.inspect("app"))?.Running).toBe(false);
  },
  30000,
);
real(
  "detached wasmtime survives a separate hub process crash",
  async () => {
    await setup();
    const script = join(directory, "hub.ts");
    await fs.writeFile(
      script,
      `import { WasmtimeRuntime } from ${JSON.stringify(resolve("packages/environments/src/wasmtime.ts"))};\nconst r = new WasmtimeRuntime(${JSON.stringify(join(directory, "state"))}, ${JSON.stringify(ports)});\nawait r.start({ signal: new AbortController().signal, log() {} }, { name: "crash", component: ${JSON.stringify(component)}, env: {} });\nconsole.log("ready"); setInterval(() => {}, 1000);`,
    );
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((done, reject) => {
        child.stdout?.once("data", () => done());
        child.once("exit", () => reject(new Error("child exited before readiness")));
      });
      const before = await record("crash");
      child.kill("SIGKILL");
      await new Promise<void>((done) => child.once("exit", () => done()));
      expect((await runtime.recover(ctx)).crash).toBe("reattached");
      expect((await record("crash")).pid).toBe(before.pid);
      expect(await body(before.port)).toBe("hello wasm");
    } finally {
      child.kill("SIGKILL");
    }
  },
  30000,
);
real(
  "watch builds source in place and keeps serving after compile failure",
  async () => {
    await setup();
    const root = join(directory, "source");
    await fs.cp(fixture, root, { recursive: true, filter: (p) => !p.includes("/target") });
    const command = ["cargo", "build", "--release", "--target", "wasm32-wasip2", "--locked"];
    const output = "target/wasm32-wasip2/release/wasm_http.wasm";
    const built = await runtime.build(ctx, { root, command, component: output });
    const serving = await runtime.start(ctx, {
      name: "app",
      component: built.component,
      env: {},
    });
    let error: unknown;
    const watcher = runtime.watch(
      ctx,
      { name: "app", root, build: command, component: output, env: {} },
      {
        error: (e) => {
          error = e;
        },
      },
    );
    try {
      const source = join(root, "src/lib.rs"),
        original = await fs.readFile(source, "utf8");
      await fs.writeFile(source, original.replace("hello wasm", "changed wasm"));
      await until(async () => {
        try {
          return (await body(serving.port)) === "changed wasm";
        } catch {
          return false;
        }
      });
      await fs.writeFile(source, "compile error");
      await until(async () => !!error);
      expect(await body(serving.port)).toBe("changed wasm");
      expect((await fs.readdir(directory)).sort()).toEqual(["source", "state"]);
    } finally {
      await watcher.stop();
    }
  },
  120000,
);
real("corrupt recovery records fail clearly", async () => {
  await setup();
  await fs.mkdir(join(directory, "state"));
  await fs.writeFile(join(directory, "state/broken.json"), "{}");
  await expect(runtime.recover(ctx)).rejects.toThrow("wasmtime record broken");
});
real(
  "stopped services retain reserved ports and oversized logs rotate",
  async () => {
    await setup();
    const first = await runtime.start(ctx, { name: "app", component, env: {} });
    await runtime.stop(ctx, "app");
    const second = await runtime.start(ctx, { name: "crash", component, env: {} });
    expect(second.port).not.toBe(first.port);
    const log = join(directory, "state/app.log");
    await fs.writeFile(log, "x".repeat(5 * 1024 ** 2 + 1));
    expect((await runtime.start(ctx, "app")).port).toBe(first.port);
    expect((await fs.stat(`${log}.1`)).size).toBe(5 * 1024 ** 2 + 1);
    expect(await body(first.port)).toBe("hello wasm");
  },
  30000,
);
