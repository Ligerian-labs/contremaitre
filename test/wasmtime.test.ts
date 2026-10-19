import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunSpec } from "@contremaitre/environments/runtimes";
import { WasmtimeRuntime } from "@contremaitre/environments/wasmtime";
import { context, hash } from "@contremaitre/execution/context";
import { privateEnv } from "@contremaitre/execution/files";
import { run } from "@contremaitre/execution/process";
import type { Service } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";
import { freePort } from "./ports.js";

const fixture = resolve("test/fixtures/wasm-http");
const cache = join(tmpdir(), "contremaitre-wasm-fixture");
const component = join(cache, "wasm32-wasip2/release/wasm_http.wasm");
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
    env: { ...process.env, CARGO_TARGET_DIR: cache, CARGO_BUILD_JOBS: "1" },
  });
}, 120000);
afterEach(async () => {
  if (!directory) return;
  try {
    const failures: unknown[] = [];
    for (const r of runtimes) {
      for (const name of ["app", "crash", "broken"]) {
        try {
          await r.remove(ctx, name);
        } catch (error) {
          failures.push(error);
        }
      }
      expect(Reflect.get(r, "watchers").size).toBe(0);
    }
    if (failures.length) throw new AggregateError(failures, "WASM runtime cleanup failed");
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
async function within(check: () => Promise<boolean>, timeout: number) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(100);
  }
  return false;
}
async function until(check: () => Promise<boolean>) {
  if (!(await within(check, 60000))) throw new Error("Condition timed out");
}
// FSEvents can miss a write made just after a watcher starts. Repeat the change,
// beyond the rebuild debounce, until the watcher reacts; returns the writes made.
async function change(path: string, check: () => Promise<boolean>) {
  for (let writes = 1; writes <= 30; writes++) {
    await fs.writeFile(path, `changed ${writes}`);
    if (await within(check, 2000)) return writes;
  }
  throw new Error("Watcher did not react to source changes");
}
async function spec(
  options: Partial<RunSpec> = {},
  env: Record<string, string> = {},
): Promise<RunSpec> {
  const port = await freePort();
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
test("services sharing a build directory and component build one after another", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "cm-wasm-shared-"));
  try {
    // Like cargo, the first build writes its output and keeps working; a second
    // build replaces the output, removing it first.
    const script = `if mkdir first 2>/dev/null; then printf component > app.wasm; sleep 0.3
else sleep 0.1; rm -f app.wasm; sleep 0.5; printf component > app.wasm; fi`;
    const shared = new WasmtimeRuntime({ home: join(root, "home"), apple: new FakeRuntime() });
    const request = (name: string) => ({
      root,
      name,
      tag: name,
      service: { wasm: { build: ["/bin/sh", "-c", script], component: "app.wasm" } },
    });
    const [api, web] = await Promise.all([
      shared.build(ctx, request("api")),
      shared.build(ctx, request("web")),
    ]);
    expect(api.digest).toBe(hash(Buffer.from("component")));
    expect(web).toEqual(api);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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
    const cwd = (
      await run(ctx, ["/usr/sbin/lsof", "-a", "-p", String(first.pid), "-d", "cwd", "-Fn"])
    ).toString();
    expect(cwd).toContain(`n${await fs.realpath(s.data ?? "")}`);
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
    expect(
      (await fs.readdir(join(directory, "wasmtime"))).filter((p) => p.endsWith(".wasm")),
    ).toEqual([]);
  },
  150000,
);
real("task and missing port mapping fail clearly", async () => {
  await setup();
  const s = await spec();
  await expect(runtime.run(ctx, { ...s, task: true })).rejects.toThrow(
    "tasks require command mode",
  );
  await expect(runtime.run(ctx, { ...s, ports: {} })).rejects.toThrow("Missing reserved");
});
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
      expect((await runtime.inspect(ctx, "crash"))?.Running).toBe(true);
      expect((await record("crash")).pid).toBe(first.pid);
      // Let macOS retire the killed hub's FSEvents stream before editing.
      await Bun.sleep(500);
      await fs.writeFile(join(root, "change"), "changed");
      await until(async () => (await record("crash")).pid !== first.pid);
      expect(await fs.readFile(join(root, "builds"), "utf8")).toContain("build");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((done) => child.once("exit", () => done()));
        child.kill("SIGKILL");
        await exited;
      }
    }
  },
  90000,
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
          "echo build >> builds; cargo build --release --target wasm32-wasip2 --locked --jobs 1",
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
  210000,
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

real(
  "concurrent inspections attach one watcher and remove drains it before source deletion",
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
    const s = await spec({ root, source: root, image: join(root, "app.wasm"), service });
    await runtime.run(ctx, s);
    const recovered = fresh();
    await Promise.all(Array.from({ length: 8 }, () => recovered.inspect(ctx, "app")));
    // The original runtime represents a retired hub; stop its watcher without removing state.
    await runtime.stop(ctx, "app");
    await recovered.start(ctx, "app");
    const writes = await change(join(root, "change"), () =>
      Bun.file(join(root, "builds")).exists(),
    );
    await recovered.remove(ctx, "app");
    // Duplicate watchers would build more than once per change.
    const builds = (await fs.readFile(join(root, "builds"), "utf8")).trim().split("\n");
    expect(builds.every((line) => line === "build")).toBe(true);
    expect(builds.length).toBeLessThanOrEqual(writes);
    await fs.rm(root, { recursive: true });
    await Bun.sleep(700);
    expect(await recovered.inspect(ctx, "app")).toBeUndefined();
  },
  90000,
);

real(
  "vanished source or record stops a queued watcher before building",
  async () => {
    await setup();
    const root = join(directory, "source");
    await fs.mkdir(root);
    await fs.copyFile(component, join(root, "app.wasm"));
    const marker = join(directory, "builds");
    const service: Service = {
      port: 8080,
      wasm: { component: "app.wasm", build: ["/usr/bin/touch", marker] },
      dev: { source: "." },
    };
    const s = await spec({ root, source: root, image: join(root, "app.wasm"), service });
    await runtime.run(ctx, s);
    await fs.writeFile(join(root, "change"), "changed");
    await fs.rm(root, { recursive: true });
    await Bun.sleep(700);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(Reflect.get(runtime, "watchers").size).toBe(0);
    await runtime.stop(ctx, "app");
    await fs.mkdir(root);
    await fs.copyFile(component, join(root, "app.wasm"));
    await runtime.run(ctx, s);
    await fs.writeFile(join(root, "change"), "changed");
    const recordPath = join(directory, "wasmtime/app.json");
    const saved = await fs.readFile(recordPath);
    try {
      await fs.rm(recordPath);
      await Bun.sleep(700);
      expect(await Bun.file(marker).exists()).toBe(false);
      expect(Reflect.get(runtime, "watchers").size).toBe(0);
    } finally {
      await fs.writeFile(recordPath, saved);
    }
  },
  30000,
);

real(
  "stop drains an active build and its children and cancels queued rebuilds",
  async () => {
    await setup();
    const root = join(directory, "source");
    await fs.mkdir(root);
    await fs.copyFile(component, join(root, "app.wasm"));
    const service: Service = {
      port: 8080,
      wasm: {
        component: "app.wasm",
        build: ["/bin/sh", "-c", "sleep 60 & echo $! > child; wait"],
      },
      dev: { source: ".", exclude: ["child"] },
    };
    const s = await spec({ root, source: root, image: join(root, "app.wasm"), service });
    await runtime.run(ctx, s);
    await change(join(root, "change"), () => Bun.file(join(root, "child")).exists());
    const pid = Number(await fs.readFile(join(root, "child"), "utf8"));
    await fs.writeFile(join(root, "change"), "queued");
    const stopping = runtime.stop(ctx, "app");
    await runtime.inspect(ctx, "app");
    await stopping;
    await until(async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(Reflect.get(runtime, "watchers").size).toBe(0);
    await fs.rm(join(root, "child"));
    await Bun.sleep(700);
    expect(await Bun.file(join(root, "child")).exists()).toBe(false);
    expect((await runtime.inspect(ctx, "app"))?.Running).toBe(false);
  },
  150000,
);

// Opt-in evidence from inside the shared test process, before the next file runs.
afterAll(() => {
  if (process.env.CONTREMAITRE_WASMTIME_DIAGNOSTICS !== "1") return;
  console.error("WASM cleanup diagnostics", import.meta.path, {
    resources: process.getActiveResourcesInfo(),
    processes: Bun.spawnSync(["ps", "-axo", "pid,ppid,etime,command"])
      .stdout.toString()
      .split("\n")
      .filter(
        (line) =>
          /(?:wasmtime serve|cargo build|rustc|bun test)/.test(line) &&
          !line.includes("/bin/zsh -c"),
      ),
  });
});

real(
  "unrelated live pid is never running or terminated",
  async () => {
    await setup();
    await runtime.run(ctx, await spec());
    const saved = await record();
    await runtime.stop(ctx, "app");
    const sleeper = spawn("/bin/sleep", ["60"]);
    try {
      await fs.writeFile(
        join(directory, "wasmtime/app.json"),
        JSON.stringify({
          ...saved,
          pid: sleeper.pid,
          identity: "different process identity",
        }),
      );
      expect((await runtime.inspect(ctx, "app"))?.Running).toBe(false);
      await runtime.stop(ctx, "app");
      await runtime.remove(ctx, "app");
      expect(() => process.kill(sleeper.pid ?? 0, 0)).not.toThrow();
    } finally {
      sleeper.kill();
      await new Promise<void>((done) => sleeper.once("exit", () => done()));
    }
  },
  30000,
);

real(
  "stop prevents later builds and redeploy uses new settings without component loops",
  async () => {
    await setup();
    const root = join(directory, "source");
    await fs.mkdir(root);
    await fs.copyFile(component, join(root, "app.wasm"));
    const marker = join(directory, "builds");
    const service: Service = {
      port: 8080,
      wasm: {
        component: "app.wasm",
        build: ["/bin/sh", "-c", 'echo old >> "$1"', "build", marker],
      },
      dev: { source: ".", exclude: ["ignored"] },
    };
    const s = await spec({ root, source: root, image: join(root, "app.wasm"), service });
    await runtime.run(ctx, s);
    await runtime.stop(ctx, "app");
    const stopped = await record();
    const log = await fs.readFile(stopped.log, "utf8");
    await fs.writeFile(join(root, "change"), "stopped");
    await Bun.sleep(1000);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect((await record()).pid).toBe(stopped.pid);
    expect(await fs.readFile(stopped.log, "utf8")).toBe(log);
    await runtime.run(ctx, {
      ...s,
      service: {
        ...service,
        wasm: {
          component: "app.wasm",
          build: [
            "/bin/sh",
            "-c",
            'echo new >> "$1"; cp "$2" app.wasm',
            "build",
            marker,
            component,
          ],
        },
        dev: { source: ".", exclude: ["change"] },
      },
    });
    const before = await record();
    await fs.writeFile(join(root, "change"), "excluded by new settings");
    await Bun.sleep(800);
    expect(await Bun.file(marker).exists()).toBe(false);
    await fs.writeFile(join(root, "ignored"), "included by new settings");
    await until(async () => (await record()).pid !== before.pid);
    await Bun.sleep(1500);
    expect(await fs.readFile(marker, "utf8")).toBe("new\n");
  },
  90000,
);

real(
  "failed dev start restores previous snapshot on the same port",
  async () => {
    await setup();
    const root = join(directory, "source");
    await fs.mkdir(root);
    await fs.copyFile(component, join(root, "app.wasm"));
    const s = await spec({
      root,
      source: root,
      image: join(root, "app.wasm"),
      service: {
        port: 8080,
        wasm: { component: "app.wasm", build: ["/bin/sh", "-c", "printf invalid > app.wasm"] },
        dev: { source: "." },
      },
    });
    await runtime.run(ctx, s);
    const first = await record();
    await fs.writeFile(join(root, "change"), "bad build");
    await until(async () =>
      (await fs.readFile(first.log, "utf8")).includes("previous version restored"),
    );
    expect(await body(portOf(s))).toBe("hello wasm");
    expect((await record()).component).toBe(first.component);
    expect((await runtime.inspect(ctx, "app"))?.Running).toBe(true);
  },
  90000,
);

real("build directory escape is reported before invoking the build", async () => {
  await setup();
  const root = join(directory, "source");
  await fs.mkdir(root);
  await fs.symlink(cache, join(root, "outside"));
  await expect(
    runtime.build(ctx, {
      root,
      name: "app",
      tag: "app",
      service: { wasm: { component: "app.wasm", directory: "outside", build: ["/usr/bin/false"] } },
    }),
  ).rejects.toThrow(/^WASM component path escapes build root$/);
});

real(
  "invalid record salvages ownership without sidecar and unidentifiable JSON is discarded",
  async () => {
    await setup();
    await runtime.run(ctx, await spec());
    const saved = await record();
    await fs.rm(join(directory, "wasmtime/app.owner"));
    await fs.writeFile(
      join(directory, "wasmtime/app.json"),
      JSON.stringify({ pid: saved.pid, identity: saved.identity }),
    );
    expect((await runtime.inspect(ctx, "app"))?.Running).toBe(false);
    await runtime.remove(ctx, "app");
    await until(async () => {
      try {
        process.kill(saved.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(() => process.kill(saved.pid, 0)).toThrow();
    await fs.writeFile(join(directory, "wasmtime/app.json"), "{");
    let output = "";
    await runtime.remove(
      context(undefined, (data) => {
        output += data.toString();
      }),
      "app",
    );
    expect(output).toContain("corrupt");
    expect(await runtime.inspect(ctx, "app")).toBeUndefined();
  },
  90000,
);

real(
  "redeploy replaces watcher build and excludes without an intervening source edit",
  async () => {
    await setup();
    const root = join(directory, "source");
    await fs.mkdir(root);
    await fs.copyFile(component, join(root, "app.wasm"));
    const marker = join(directory, "builds");
    const s = await spec({
      root,
      source: root,
      image: join(root, "app.wasm"),
      service: {
        port: 8080,
        wasm: {
          component: "app.wasm",
          build: ["/bin/sh", "-c", 'echo old >> "$1"', "build", marker],
        },
        dev: { source: ".", exclude: ["new-trigger"] },
      },
    });
    await runtime.run(ctx, s);
    await runtime.run(ctx, {
      ...s,
      service: {
        port: 8080,
        wasm: {
          component: "app.wasm",
          build: ["/bin/sh", "-c", 'echo new >> "$1"', "build", marker],
        },
        dev: { source: ".", exclude: ["old-trigger"] },
      },
    });
    await fs.writeFile(join(root, "old-trigger"), "excluded");
    await Bun.sleep(800);
    expect(await Bun.file(marker).exists()).toBe(false);
    await fs.writeFile(join(root, "new-trigger"), "included");
    await until(async () => Bun.file(marker).exists());
    expect(await fs.readFile(marker, "utf8")).toBe("new\n");
  },
  90000,
);

real("failed initial start still rejects deployment", async () => {
  await setup();
  const image = join(directory, "invalid.wasm");
  await fs.writeFile(image, "invalid");
  await expect(runtime.run(ctx, await spec({ image }))).rejects.toThrow("Wasmtime exited");
  expect((await runtime.inspect(ctx, "app"))?.Running).toBe(false);
  const owner = join(directory, "wasmtime/app.owner");
  if (await Bun.file(owner).exists()) expect((await fs.stat(owner)).mode & 0o777).toBe(0o600);
});

real("terminate waits until the owned port is closed", async () => {
  await setup();
  const s = await spec();
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((done) => server.listen(portOf(s), "127.0.0.1", done));
  const child = spawn("/bin/sleep", ["60"], { detached: true });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  const pid = child.pid ?? 0;
  const identity = (await run(ctx, ["/bin/ps", "-p", String(pid), "-o", "lstart=,comm="]))
    .toString()
    .trim();
  let closing: Promise<void> | undefined;
  child.once("exit", () => {
    closing = new Promise<void>((done) => setTimeout(() => server.close(() => done()), 400));
  });
  try {
    await Reflect.get(runtime, "terminate").call(runtime, { pid, identity, port: portOf(s) });
    expect(server.listening).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await closing;
    if (server.listening) server.close();
  }
});

real("truncated snapshot is repaired before start", async () => {
  await setup();
  const s = await spec();
  const bytes = await fs.readFile(s.image);
  const snapshot = join(directory, "wasmtime", `app.${hash(bytes)}.wasm`);
  await fs.mkdir(join(directory, "wasmtime"));
  await fs.writeFile(snapshot, bytes.subarray(0, 8));
  await runtime.run(ctx, s);
  expect(hash(await fs.readFile(snapshot))).toBe(hash(bytes));
  expect((await fs.stat(snapshot)).mode & 0o777).toBe(0o600);
  expect(await body(portOf(s))).toBe("hello wasm");
  expect((await fs.readdir(join(directory, "wasmtime"))).some((p) => p.startsWith(".write-"))).toBe(
    false,
  );
});

real(
  "distinct rebuilds retain two snapshots and failed restart still rolls back",
  async () => {
    await setup();
    const root = join(directory, "source");
    await fs.mkdir(root);
    const image = join(root, "app.wasm");
    const candidate = join(directory, "candidate.wasm");
    const bytes = await fs.readFile(component);
    await fs.writeFile(image, bytes);
    const s = await spec({
      root,
      source: root,
      image,
      service: {
        port: 8080,
        wasm: { component: "app.wasm", build: ["/bin/cp", candidate, image] },
        dev: { source: "." },
      },
    });
    await runtime.run(ctx, s);
    for (let i = 1; i <= 4; i++) {
      const previous = await record();
      // A valid custom section changes the digest without changing the HTTP handler.
      const next = Buffer.concat([bytes, Buffer.from([0, 2, 0, i])]);
      await fs.writeFile(candidate, next);
      await fs.writeFile(join(root, "change"), String(i));
      await until(async () => (await record()).digest === hash(next));
      await until(async () => (await body(portOf(s)).catch(() => "")) === "hello wasm");
      await until(
        async () =>
          (await fs.readdir(join(directory, "wasmtime"))).filter((p) => p.endsWith(".wasm"))
            .length <= 2,
      );
      expect(await Bun.file(previous.component).exists()).toBe(true);
      expect(await body(portOf(s))).toBe("hello wasm");
    }
    const current = await record();
    await runtime.stop(ctx, "app");
    await runtime.start(ctx, "app");
    expect(await Bun.file(current.previous).exists()).toBe(true);
    await fs.writeFile(candidate, "invalid");
    await fs.writeFile(join(root, "change"), "bad");
    await until(async () =>
      (await fs.readFile(current.log, "utf8")).includes("previous version restored"),
    );
    expect((await record()).component).toBe(current.component);
    expect(await Bun.file(current.previous).exists()).toBe(true);
    expect(await body(portOf(s))).toBe("hello wasm");
    expect(
      (await fs.readdir(join(directory, "wasmtime"))).filter((p) => p.endsWith(".wasm")).length,
    ).toBeLessThanOrEqual(2);
  },
  900000,
);

real(
  "unidentifiable ownership warns in operation and service logs without failing removal",
  async () => {
    await setup();
    await fs.mkdir(join(directory, "wasmtime"));
    await fs.writeFile(join(directory, "wasmtime/app.json"), "{");
    await fs.writeFile(join(directory, "wasmtime/app.owner"), "{");
    let operation = "",
      service = "";
    await runtime.remove(
      context(undefined, (data, name) => {
        operation += data.toString();
        if (name === "app") service += data.toString();
      }),
      "app",
    );
    expect(operation).toContain("may still be running");
    expect(service).toContain("may still be running");
    expect(await runtime.inspect(ctx, "app")).toBeUndefined();
  },
);
