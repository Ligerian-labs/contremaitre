import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, promises as fs, openSync, watch } from "node:fs";
import { createConnection, createServer } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type Context,
  decode,
  fail,
  hash,
  isCode,
  message,
  phase,
  strings,
} from "@contremaitre/execution/context";
import { atomicWrite } from "@contremaitre/execution/files";
import { run } from "@contremaitre/execution/process";
import { Schema } from "effect";

const recordSchema = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  identity: Schema.String,
  port: Schema.Int,
  component: Schema.String,
  digest: Schema.String,
  argv: Schema.Array(Schema.String),
  env: strings,
  cwd: Schema.optional(Schema.String),
  desired: Schema.Literal("running", "stopped"),
  log: Schema.String,
});
type RecordState = Schema.Schema.Type<typeof recordSchema>;
export interface BuildSpec {
  root: string;
  command: string | readonly string[];
  component: string;
  env?: Record<string, string>;
}
export interface ServeSpec {
  name: string;
  component: string;
  env: Record<string, string>;
  cwd?: string;
  port?: number;
}
function identity(pid: number) {
  const r = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart=,comm="], { encoding: "utf8" });
  if (r.status === 1) return undefined;
  if (r.status !== 0) fail("Cannot inspect wasmtime process identity");
  return r.stdout.trim() || undefined;
}
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function answering(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (ok: boolean) => {
      socket.destroy();
      done(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(200, () => finish(false));
  });
}
export class WasmtimeRuntime {
  constructor(
    private directory: string,
    private ports?: { from: number; to: number },
  ) {
    this.directory = resolve(directory);
    if (
      ports &&
      (!Number.isInteger(ports.from) ||
        !Number.isInteger(ports.to) ||
        ports.from < 1 ||
        ports.to > 65535 ||
        ports.from > ports.to)
    )
      fail("Invalid wasmtime port range");
  }
  private path(name: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) fail("Invalid wasmtime service name");
    return join(this.directory, `${name}.json`);
  }
  private async read(name: string): Promise<RecordState | undefined> {
    const path = this.path(name);
    try {
      const r = decode(
        recordSchema,
        JSON.parse(await fs.readFile(path, "utf8")),
        `wasmtime record ${name}`,
      );
      if (
        r.pid < 2 ||
        r.port < 1 ||
        r.port > 65535 ||
        r.log !== join(this.directory, `${name}.log`)
      )
        fail(`Invalid wasmtime record ${name}`);
      return r;
    } catch (e) {
      if (isCode(e, "ENOENT")) return undefined;
      fail(`Cannot read wasmtime record ${name}: ${message(e)}`);
    }
  }
  private save(name: string, r: RecordState) {
    atomicWrite(this.path(name), JSON.stringify(r));
  }
  async preflight(ctx: Context) {
    const binary = Bun.which("wasmtime", { PATH: process.env.PATH ?? "" });
    if (!binary)
      fail(
        "wasmtime is missing. Install with brew install wasmtime or curl https://wasmtime.dev/install.sh -sSf | bash",
      );
    return (await run(ctx, [binary, "--version"])).toString().trim();
  }
  async build(ctx: Context, spec: BuildSpec) {
    const root = await fs.realpath(spec.root),
      component = resolve(root, spec.component);
    const inside = (path: string) => {
      const p = relative(root, path);
      if (p === ".." || p.startsWith("../") || isAbsolute(p))
        fail("WASM component path escapes build root");
    };
    inside(component);
    phase(ctx, "Building WASM component on host");
    try {
      await run(
        ctx,
        typeof spec.command === "string" ? ["/bin/sh", "-c", spec.command] : spec.command,
        { cwd: root, env: { ...process.env, ...spec.env }, stdout: ctx.log, stderr: ctx.log },
      );
    } catch (e) {
      ctx.signal.throwIfAborted();
      fail(`WASM build command failed; read the logs: ${message(e)}`);
    }
    if (!existsSync(component)) fail(`WASM build did not produce ${component}; read the logs`);
    inside(await fs.realpath(component));
    return { component, digest: hash(await fs.readFile(component)) };
  }
  private async allocate() {
    const reserved = new Set<number>();
    if (existsSync(this.directory))
      for (const file of await fs.readdir(this.directory)) {
        if (!file.endsWith(".json")) continue;
        const r = await this.read(file.slice(0, -5));
        if (r) reserved.add(r.port);
      }
    for (
      let attempt = 0;
      attempt < (this.ports ? this.ports.to - this.ports.from + 1 : 100);
      attempt++
    ) {
      const port = this.ports ? this.ports.from + attempt : 0;
      const allocated = await new Promise<number | undefined>((done) => {
        if (port && reserved.has(port)) return done(undefined);
        const server = createServer();
        server.once("error", () => done(undefined));
        server.listen(port, "127.0.0.1", () => {
          const addr = server.address();
          server.close(() =>
            done(
              typeof addr === "object" && addr && !reserved.has(addr.port) ? addr.port : undefined,
            ),
          );
        });
      });
      if (allocated) return allocated;
    }
    return fail("No free wasmtime loopback port", "conflict");
  }
  async inspect(name: string) {
    const r = await this.read(name);
    return r
      ? { Running: identity(r.pid) === r.identity, host: "127.0.0.1" as const, port: r.port }
      : undefined;
  }
  async start(ctx: Context, spec: ServeSpec | string) {
    ctx.signal.throwIfAborted();
    const name = typeof spec === "string" ? spec : spec.name;
    const old = await this.read(name);
    if (typeof spec === "string" && !old) return fail(`Unknown wasmtime service ${name}`);
    const s: ServeSpec =
      typeof spec === "string"
        ? old
          ? { name, component: old.component, env: { ...old.env }, cwd: old.cwd, port: old.port }
          : fail(`Unknown wasmtime service ${name}`)
        : spec;
    await this.preflight(ctx);
    phase(ctx, `Starting wasmtime ${name}`);
    const digest = hash(await fs.readFile(s.component));
    if (old) await this.stop(ctx, name);
    const port = s.port ?? old?.port ?? (await this.allocate());
    if (await answering(port)) fail(`Wasmtime port ${port} is already in use`, "conflict");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const log = join(this.directory, `${name}.log`);
    if (existsSync(log) && (await fs.stat(log)).size > 5 * 1024 ** 2)
      await fs.rename(log, `${log}.1`);
    const argv = [
      Bun.which("wasmtime", { PATH: process.env.PATH ?? "" }) ??
        fail("wasmtime is missing; brew install wasmtime"),
      "serve",
      "-S",
      "cli=y",
      "--addr",
      `127.0.0.1:${port}`,
      ...Object.entries(s.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
      s.component,
    ];
    const fd = openSync(log, "a", 0o600);
    const child = spawn(argv[0], argv.slice(1), {
      detached: true,
      cwd: s.cwd,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    child.unref();
    let error: Error | undefined;
    child.on("error", (e) => {
      error = e;
    });
    let r: RecordState | undefined;
    try {
      await new Promise<void>((done, reject) => {
        child.once("spawn", done);
        child.once("error", reject);
      });
      const pid = child.pid ?? fail("Wasmtime did not spawn"),
        started = identity(pid);
      if (!started) fail(`Wasmtime exited: ${(await fs.readFile(log, "utf8")).slice(-8192)}`);
      r = {
        version: 1,
        pid,
        identity: started,
        port,
        component: s.component,
        digest,
        argv,
        env: s.env,
        cwd: s.cwd,
        desired: "running",
        log,
      };
      this.save(name, r);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        ctx.signal.throwIfAborted();
        if (error || identity(pid) !== started)
          fail(
            `Wasmtime exited: ${error?.message ?? ""}\n${(await fs.readFile(log, "utf8")).slice(-8192)}`,
          );
        if (await answering(port)) return { Running: true, host: "127.0.0.1" as const, port };
        await delay(50);
      }
      fail(`Wasmtime readiness timed out on port ${port}`);
    } catch (e) {
      if (r) {
        await this.terminate(r);
        const saved = await this.read(name);
        if (saved?.pid === r.pid) this.save(name, { ...r, desired: "stopped" });
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      throw e;
    }
  }
  async stop(ctx: Context, name: string) {
    const r = await this.read(name);
    if (!r) return;
    phase(ctx, `Stopping wasmtime ${name}`);
    try {
      this.save(name, { ...r, desired: "stopped" });
    } finally {
      await this.terminate(r);
    }
  }
  private async terminate(r: RecordState) {
    if (identity(r.pid) !== r.identity) return;
    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-r.pid, signal);
      } catch (e) {
        if (!isCode(e, "ESRCH")) throw e;
      }
    };
    kill("SIGTERM");
    const deadline = Date.now() + 5000;
    while (identity(r.pid) === r.identity && Date.now() < deadline) await delay(50);
    if (identity(r.pid) === r.identity) kill("SIGKILL");
    const killed = Date.now() + 5000;
    while (identity(r.pid) === r.identity && Date.now() < killed) await delay(50);
    if (identity(r.pid) === r.identity) fail(`Cannot stop wasmtime pid ${r.pid}`);
  }
  async remove(ctx: Context, name: string) {
    await this.stop(ctx, name);
    await Promise.all(
      [
        this.path(name),
        join(this.directory, `${name}.log`),
        join(this.directory, `${name}.log.1`),
      ].map((p) => fs.rm(p, { force: true })),
    );
  }
  async recover(ctx: Context) {
    const outcomes: Record<string, string> = {};
    if (!existsSync(this.directory)) return outcomes;
    for (const file of await fs.readdir(this.directory)) {
      if (!file.endsWith(".json")) continue;
      const name = file.slice(0, -5),
        r = await this.read(name);
      if (!r) continue;
      if (r.desired === "stopped") {
        await this.stop(ctx, name);
        outcomes[name] = "stopped";
      } else if (identity(r.pid) === r.identity && (await answering(r.port)))
        outcomes[name] = "reattached";
      else {
        await this.start(ctx, name);
        outcomes[name] = "restarted";
      }
    }
    return outcomes;
  }
  async logs(ctx: Context, name: string) {
    const r = await this.read(name);
    if (!r) return;
    let offset = 0,
      inode: number | undefined;
    while (!ctx.signal.aborted) {
      const file = await fs.open(r.log, "r");
      try {
        const stat = await file.stat(),
          size = stat.size;
        if (stat.ino !== inode || size < offset) offset = 0;
        inode = stat.ino;
        while (offset < size) {
          const bytes = Buffer.alloc(Math.min(65536, size - offset));
          const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
          if (!bytesRead) break;
          offset += bytesRead;
          ctx.log(bytes.subarray(0, bytesRead));
        }
      } finally {
        await file.close();
      }
      await delay(100);
    }
  }
  watch(
    ctx: Context,
    spec: Omit<ServeSpec, "component"> & {
      root: string;
      build: BuildSpec["command"];
      component: string;
      buildEnv?: Record<string, string>;
    },
    callbacks?: { error?: (error: unknown) => void; ready?: () => void },
  ) {
    let timer: ReturnType<typeof setTimeout> | undefined,
      active: Promise<void> | undefined,
      pending = false,
      stopped = false;
    const rebuild = () => {
      pending = true;
      if (active || stopped) return;
      active = (async () => {
        while (pending && !stopped) {
          pending = false;
          try {
            const built = await this.build(ctx, {
              root: spec.root,
              command: spec.build,
              component: spec.component,
              env: spec.buildEnv,
            });
            if (stopped) break;
            await this.start(ctx, { ...spec, component: built.component });
            callbacks?.ready?.();
          } catch (e) {
            ctx.log(`WASM rebuild failed: ${message(e)}\n`);
            callbacks?.error?.(e);
          }
        }
      })().finally(() => {
        active = undefined;
      });
    };
    const watcher = watch(spec.root, { recursive: true }, (_event, filename) => {
      const path = filename?.toString();
      if (
        !path ||
        path.split(/[\\/]/).some((p) => [".git", ".jj", "target", "node_modules"].includes(p)) ||
        resolve(spec.root, path) === resolve(spec.root, spec.component)
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(rebuild, 300);
    });
    const stop = async () => {
      stopped = true;
      clearTimeout(timer);
      watcher.close();
      ctx.signal.removeEventListener("abort", abort);
      await active;
    };
    const abort = () => {
      void stop();
    };
    ctx.signal.addEventListener("abort", abort, { once: true });
    if (ctx.signal.aborted) void stop();
    return { stop };
  }
}
