import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, promises as fs, openSync, realpathSync, watch } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import ignore from "@balena/dockerignore";
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
import { type Service, serviceSchema } from "@contremaitre/projects/model";
import { Schema } from "effect";
import type { BuildRecord } from "./model.js";

import type {
  BuildRequest,
  Inspection,
  RegistryOptions,
  RunSpec,
  RuntimeCapabilities,
  ServiceRuntime,
} from "./runtimes.js";

const recordSchema = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  identity: Schema.String,
  port: Schema.Int,
  component: Schema.String,
  digest: Schema.String,
  previous: Schema.optional(Schema.String),
  argv: Schema.Array(Schema.String),
  env: strings,
  cwd: Schema.optional(Schema.String),
  desired: Schema.Literal("running", "stopped"),
  log: Schema.String,
  root: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  service: Schema.optional(serviceSchema),
});
type RecordState = Schema.Schema.Type<typeof recordSchema>;
function identity(pid: number) {
  const r = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart=,comm="], { encoding: "utf8" });
  if (r.status === 1) return undefined;
  if (r.status !== 0) fail("Cannot inspect wasmtime process identity");
  return r.stdout.trim() || undefined;
}
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function answering(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host, port });
    const finish = (ok: boolean) => {
      socket.destroy();
      done(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(200, () => finish(false));
  });
}
export class WasmtimeRuntime implements ServiceRuntime {
  readonly capabilities: RuntimeCapabilities = {
    network: "host",
    development: "mount",
    clone: "files",
  };
  private directory: string;
  private bind: string;
  private watchers = new Map<string, { stop: () => Promise<void> }>();
  private watcherEpochs = new Map<string, number>();
  private stopping = new Set<string>();
  constructor(options: RegistryOptions & { bind?: string }) {
    // The hub's store canonicalizes its home; a CLI may spell it through a symlink.
    const home = resolve(options.home);
    this.directory = join(existsSync(home) ? realpathSync(home) : home, "wasmtime");
    this.bind = options.bind ?? "127.0.0.1";
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
  private async broken(ctx: Context, name: string) {
    if (!existsSync(this.path(name)) && !existsSync(join(this.directory, `${name}.owner`))) return;
    phase(ctx, `Ignoring corrupt wasmtime record ${name}; cleaning verified process ownership`);
    let identified = false;
    for (const path of [this.path(name), join(this.directory, `${name}.owner`)]) {
      let value: unknown;
      try {
        value = JSON.parse(await fs.readFile(path, "utf8"));
      } catch (e) {
        if (!isCode(e, "ENOENT")) phase(ctx, `Cannot salvage wasmtime ownership: ${message(e)}`);
        continue;
      }
      if (
        value &&
        typeof value === "object" &&
        "pid" in value &&
        "identity" in value &&
        typeof value.pid === "number" &&
        Number.isSafeInteger(value.pid) &&
        value.pid >= 2 &&
        typeof value.identity === "string"
      ) {
        identified = true;
        await this.terminate({ pid: value.pid, identity: value.identity });
      }
    }
    if (!identified)
      phase(
        { ...ctx, log: (data) => ctx.log(data, name) },
        `Warning: cannot identify wasmtime process for ${name}; it may still be running. Both ownership records are unreadable or invalid; inspect and stop it manually.`,
      );
    await fs.rm(this.path(name), { force: true });
    await fs.rm(join(this.directory, `${name}.owner`), { force: true });
  }
  private save(name: string, r: RecordState) {
    atomicWrite(
      join(this.directory, `${name}.owner`),
      JSON.stringify({
        pid: r.pid,
        identity: r.identity,
      }),
    );
    atomicWrite(this.path(name), JSON.stringify(r));
  }
  async preflight(ctx: Context): Promise<void> {
    const binary = Bun.which("wasmtime", { PATH: process.env.PATH ?? "" });
    if (!binary)
      fail(
        "wasmtime is missing. Install with brew install wasmtime or curl https://wasmtime.dev/install.sh -sSf | bash",
      );
    phase(ctx, (await run(ctx, [binary, "--version"])).toString().trim());
  }
  async build(ctx: Context, spec: BuildRequest, previous?: BuildRecord): Promise<BuildRecord> {
    const wasm = spec.service.wasm ?? fail("WASM service requires wasm settings");
    const root = await fs.realpath(spec.root),
      component = resolve(root, wasm.component);
    const inside = (path: string) => {
      const p = relative(root, path);
      if (p === ".." || p.startsWith("../") || isAbsolute(p))
        fail("WASM component path escapes build root");
    };
    inside(component);
    phase(ctx, "Building WASM component on host");
    const cwd = await fs.realpath(resolve(root, wasm.directory ?? "."));
    inside(cwd);
    try {
      if (wasm.build) {
        await run(ctx, wasm.build, { cwd, stdout: ctx.log, stderr: ctx.log });
      }
    } catch (e) {
      ctx.signal.throwIfAborted();
      fail(`WASM build command failed; read the logs: ${message(e)}`);
    }
    if (!existsSync(component)) fail(`WASM build did not produce ${component}; read the logs`);
    inside(await fs.realpath(component));
    const built = { image: component, digest: hash(await fs.readFile(component)) };
    return previous?.digest === built.digest && previous.image === built.image ? previous : built;
  }
  async inspect(ctx: Context, name: string): Promise<Inspection | undefined> {
    let r: RecordState | undefined;
    try {
      r = await this.read(name);
    } catch (e) {
      phase(ctx, message(e));
      return { Running: false, Host: this.bind };
    }
    const running = !!r && identity(r.pid) === r.identity;
    if (running) await this.watchService(ctx, name);
    return r ? { Running: running, Host: this.bind } : undefined;
  }
  async run(ctx: Context, spec: RunSpec): Promise<void> {
    if (spec.task) fail("WASM apps have no tasks");
    const port = spec.ports?.[String(spec.service.port)];
    if (!port) fail(`Missing reserved WASM port mapping for ${spec.service.port}`);
    if (!spec.data || !spec.root) fail("WASM run requires root and data directories");
    const env: Record<string, string> = {};
    for (const line of (await fs.readFile(spec.envFile, "utf8")).split("\n")) {
      if (!line) continue;
      const split = line.indexOf("=");
      if (split < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, split)))
        fail("Invalid environment entry");
      env[line.slice(0, split)] = line.slice(split + 1);
    }
    await this.stop(ctx, spec.name);
    await this.spawn(ctx, spec.name, {
      component: spec.image,
      env,
      cwd: spec.data,
      port,
      root: spec.root,
      source: spec.source,
      service: {
        port: spec.service.port,
        wasm: spec.service.wasm && {
          build: spec.service.wasm.build,
          directory: spec.service.wasm.directory,
          component: spec.service.wasm.component,
        },
        dev: spec.service.dev && {
          source: spec.service.dev.source,
          exclude: spec.service.dev.exclude,
        },
      },
    });
    await this.watchService(ctx, spec.name);
  }
  async start(ctx: Context, name: string): Promise<void> {
    const r = (await this.read(name)) ?? fail(`Unknown wasmtime service ${name}`);
    await this.stop(ctx, name);
    await this.spawn(ctx, name, r);
    await this.watchService(ctx, name);
  }
  private async spawn(
    ctx: Context,
    name: string,
    s: Pick<RecordState, "component" | "env" | "cwd" | "port" | "root" | "source" | "service">,
  ): Promise<void> {
    ctx.signal.throwIfAborted();
    await this.preflight(ctx);
    phase(ctx, `Starting wasmtime ${name}`);
    const bytes = await fs.readFile(s.component);
    const digest = hash(bytes);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const snapshot = join(this.directory, `${name}.${digest}.wasm`);
    const previous = await this.read(name);
    let cached: Buffer | undefined;
    try {
      cached = await fs.readFile(snapshot);
    } catch (e) {
      if (!isCode(e, "ENOENT")) throw e;
    }
    if (!cached || hash(cached) !== digest) atomicWrite(snapshot, bytes);
    const port = s.port;
    if (await answering(port, this.bind))
      fail(`Wasmtime port ${port} is already in use`, "conflict");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const log = join(this.directory, `${name}.log`);
    if (existsSync(log) && (await fs.stat(log)).size > 5 * 1024 ** 2)
      await fs.rename(log, `${log}.1`);
    const argv = [
      Bun.which("wasmtime", { PATH: process.env.PATH ?? "" }) ??
        fail("wasmtime is missing; brew install wasmtime"),
      "serve",
      "-S",
      "cli=y", // WASI CLI imports provide guest environment and stderr.
      "--addr",
      `${this.bind}:${port}`,
      ...Object.keys(s.env).flatMap((k) => ["--env", k]),
      snapshot,
    ];
    const fd = openSync(log, "a", 0o600);
    const child = spawn(argv[0], argv.slice(1), {
      detached: true,
      cwd: s.cwd,
      env: { ...process.env, ...s.env },
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
        component: snapshot,
        digest,
        previous: previous?.component === snapshot ? previous.previous : previous?.component,
        argv,
        env: s.env,
        cwd: s.cwd,
        root: s.root,
        source: s.source,
        service: s.service,
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
        if (await answering(port, this.bind)) {
          for (const file of await fs.readdir(this.directory)) {
            if (
              file.startsWith(`${name}.`) &&
              /^[a-f0-9]{64}\.wasm$/.test(file.slice(name.length + 1))
            ) {
              const path = join(this.directory, file);
              if (path !== snapshot && path !== r.previous) await fs.rm(path, { force: true });
            }
          }
          return;
        }
        await delay(50);
      }
      fail(`Wasmtime readiness timed out on port ${port}`);
    } catch (e) {
      if (r) {
        await this.terminate(r);
        const saved = await this.read(name);
        if (saved?.pid === r.pid) this.save(name, previous ?? { ...r, desired: "stopped" });
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      throw e;
    }
  }
  async stop(ctx: Context, name: string): Promise<void> {
    this.stopping.add(name);
    this.watcherEpochs.set(name, (this.watcherEpochs.get(name) ?? 0) + 1);
    try {
      const watcher = this.watchers.get(name);
      await watcher?.stop();
      let r: RecordState | undefined;
      try {
        r = await this.read(name);
      } catch {
        await this.broken(ctx, name);
        return;
      }
      if (!r) {
        await this.broken(ctx, name);
        return;
      }
      phase(ctx, `Stopping wasmtime ${name}`);
      try {
        this.save(name, { ...r, desired: "stopped" });
      } finally {
        await this.terminate(r);
      }
    } finally {
      this.stopping.delete(name);
    }
  }
  private async terminate(r: Pick<RecordState, "pid" | "identity"> & { port?: number }) {
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
    const released = Date.now() + 5000;
    while (r.port && (await answering(r.port, this.bind)) && Date.now() < released) await delay(50);
  }
  async remove(ctx: Context, name: string): Promise<void> {
    await this.stop(ctx, name);
    await Promise.all(
      [
        this.path(name),
        join(this.directory, `${name}.owner`),
        ...(await fs.readdir(this.directory).catch(() => []))
          .filter(
            (p) =>
              p.startsWith(`${name}.`) && /^[a-f0-9]{64}\.wasm$/.test(p.slice(name.length + 1)),
          )
          .map((p) => join(this.directory, p)),
        join(this.directory, `${name}.log`),
        join(this.directory, `${name}.log.1`),
      ].map((p) => fs.rm(p, { force: true })),
    );
  }
  async logs(ctx: Context, name: string, follow = false): Promise<void> {
    this.path(name); // Reject names that escape the runtime directory before any fallback.
    try {
      if (!(await this.read(name))) return;
    } catch (e) {
      phase(ctx, `${message(e)}; the service is treated as stopped`);
    }
    const log = join(this.directory, `${name}.log`);
    let offset = 0,
      inode: number | undefined;
    while (!ctx.signal.aborted) {
      let file: fs.FileHandle;
      try {
        file = await fs.open(log, "r");
      } catch (e) {
        if (!isCode(e, "ENOENT")) throw e;
        if (!follow) return;
        await delay(100);
        continue;
      }
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
      if (!follow) return;
      await delay(100);
    }
  }
  private async watchService(_parent: Context, name: string) {
    if (this.watchers.has(name) || this.stopping.has(name)) return;
    const epoch = this.watcherEpochs.get(name);
    const r = await this.read(name);
    if (!r?.source || !r.root || !r.service?.wasm || r.desired !== "running") return;
    const root = r.root,
      service: Service = r.service,
      source = r.source,
      component = resolve(root, service.wasm?.component ?? r.component);
    if (!existsSync(source) || !existsSync(component)) return;
    // No await between this check and registration: concurrent inspect calls share one watcher.
    if (
      this.watchers.has(name) ||
      this.stopping.has(name) ||
      this.watcherEpochs.get(name) !== epoch
    )
      return;
    const controller = new AbortController();
    let writes = Promise.resolve();
    const ctx: Context = {
      signal: controller.signal,
      log: (data) => {
        // Watcher output survives deployment-context cancellation and hub recovery.
        writes = writes.then(() => fs.appendFile(r.log, data)).catch(() => {});
      },
    };
    const matcher = ignore().add([...(r.service.dev?.exclude ?? [])]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: Promise<void> | undefined;
    let pending = false;
    const close = () => {
      controller.abort();
      clearTimeout(timer);
      watcher.close();
      clearInterval(liveness);
      const forget = () => {
        if (this.watchers.get(name) === entry) this.watchers.delete(name);
      };
      if (active) void active.then(forget, forget);
      else forget();
    };
    const valid = async () => {
      if (controller.signal.aborted) return false;
      const current = await this.read(name);
      if (controller.signal.aborted) return false;
      if (!existsSync(source) || !current || current.desired !== "running") {
        close();
        return false;
      }
      return true;
    };
    const rebuild = () => {
      pending = true;
      if (active || controller.signal.aborted) return;
      active = (async () => {
        while (pending && !controller.signal.aborted) {
          pending = false;
          try {
            if (!(await valid())) break;
            const built = await this.build(ctx, {
              root,
              name,
              service,
              tag: name,
            });
            if (!(await valid())) break;
            const current = await this.read(name);
            if (!current) break;
            await this.terminate(current);
            try {
              await this.spawn(ctx, name, { ...current, component: built.image });
            } catch (e) {
              if (controller.signal.aborted) throw e;
              await this.spawn(ctx, name, current);
              ctx.log(`WASM restart failed; previous version restored: ${message(e)}\n`);
            }
          } catch (e) {
            if (!controller.signal.aborted) ctx.log(`WASM rebuild failed: ${message(e)}\n`);
          }
        }
      })().finally(() => {
        active = undefined;
      });
    };
    const watcher = watch(source, { recursive: true }, (_event, filename) => {
      if (controller.signal.aborted) return;
      const path = filename?.toString();
      if (!existsSync(source)) {
        close();
        return;
      }
      if (
        !path ||
        path.split(/[\\/]/).some((p) => [".git", ".jj", "node_modules"].includes(p)) ||
        resolve(source, path) === component ||
        matcher.ignores(path)
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(rebuild, 300);
      timer.unref();
    });
    watcher.unref();
    // FSEvents need not deliver an event when its watched directory itself disappears.
    const liveness = setInterval(() => {
      if (!existsSync(source) || !existsSync(this.path(name))) close();
    }, 200);
    liveness.unref();
    const entry = {
      stop: async () => {
        close();
        await active;
        await writes;
      },
    };
    this.watchers.set(name, entry);
  }
}
