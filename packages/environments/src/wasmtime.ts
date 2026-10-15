import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, promises as fs, openSync, watch } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Readable } from "node:stream";
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
import { Schema } from "effect";
import type { BuildRecord } from "./model.js";

const wasmSchema = Schema.Struct({
  build: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String))),
  directory: Schema.optional(Schema.String),
  component: Schema.String,
});
const devSchema = Schema.Struct({
  source: Schema.String,
  exclude: Schema.optional(Schema.Array(Schema.String)),
});
// Replace these local structural mirrors with ./runtimes.js imports at wiring.
export interface Service {
  port?: number;
  wasm?: Schema.Schema.Type<typeof wasmSchema>;
  dev?: Schema.Schema.Type<typeof devSchema>;
}
export interface BuildRequest {
  root: string;
  name: string;
  service: Service;
  tag: string;
}
export interface RunSpec {
  name: string;
  image: string;
  network: string;
  service: Service;
  volumes: Record<string, string>;
  envFile: string;
  task?: boolean;
  timeout?: number;
  stdin?: Readable;
  root?: string;
  ports?: Record<string, number>;
  data?: string;
  source?: string;
}
export interface Inspection {
  Host: string;
  Running: boolean;
}
export interface RuntimeCapabilities {
  network: "container" | "host";
  development: "sync" | "mount";
  clone: "online" | "files";
}
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
  root: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  service: Schema.optional(
    Schema.Struct({
      port: Schema.optional(Schema.Number),
      wasm: Schema.optional(wasmSchema),
      dev: Schema.optional(devSchema),
    }),
  ),
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
export class WasmtimeRuntime {
  readonly capabilities: RuntimeCapabilities = {
    network: "host",
    development: "mount",
    clone: "files",
  };
  private directory: string;
  private bind: string;
  private watchers = new Map<string, { stop: () => Promise<void> }>();
  constructor(options: { home: string; bind?: string }) {
    this.directory = resolve(options.home, "wasmtime");
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
  private save(name: string, r: RecordState) {
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
    try {
      if (wasm.build) {
        const cwd = await fs.realpath(resolve(root, wasm.directory ?? "."));
        inside(cwd);
        await run(
          ctx,
          typeof wasm.build === "string" ? ["/bin/sh", "-c", wasm.build] : wasm.build,
          { cwd, stdout: ctx.log, stderr: ctx.log },
        );
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
  async inspect(_ctx: Context, name: string): Promise<Inspection | undefined> {
    const r = await this.read(name);
    return r ? { Running: identity(r.pid) === r.identity, Host: this.bind } : undefined;
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
    const digest = hash(await fs.readFile(s.component));
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
      s.component,
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
        component: s.component,
        digest,
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
        if (await answering(port, this.bind)) return;
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
  async stop(ctx: Context, name: string): Promise<void> {
    const watcher = this.watchers.get(name);
    this.watchers.delete(name);
    await watcher?.stop();
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
  async remove(ctx: Context, name: string): Promise<void> {
    await this.stop(ctx, name);
    await Promise.all(
      [
        this.path(name),
        join(this.directory, `${name}.log`),
        join(this.directory, `${name}.log.1`),
      ].map((p) => fs.rm(p, { force: true })),
    );
  }
  async recover(ctx: Context): Promise<Record<string, string>> {
    const outcomes: Record<string, string> = {};
    if (!existsSync(this.directory)) return outcomes;
    for (const file of await fs.readdir(this.directory)) {
      if (!file.endsWith(".json")) continue;
      const name = file.slice(0, -5);
      try {
        const r = await this.read(name);
        if (!r) continue;
        if (r.desired === "stopped") {
          await this.stop(ctx, name);
          outcomes[name] = "stopped";
        } else if (identity(r.pid) === r.identity && (await answering(r.port, this.bind))) {
          await this.watchService(ctx, name);
          outcomes[name] = "reattached";
        } else {
          await this.start(ctx, name);
          outcomes[name] = "restarted";
        }
      } catch (e) {
        outcomes[name] = `failed: ${message(e)}`;
      }
    }
    return outcomes;
  }
  async logs(ctx: Context, name: string, follow = false): Promise<void> {
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
      if (!follow) return;
      await delay(100);
    }
  }
  private async watchService(parent: Context, name: string) {
    if (this.watchers.has(name)) return;
    const r = await this.read(name);
    if (!r?.source || !r.root || !r.service?.wasm) return;
    const root = r.root,
      service = r.service,
      source = await fs.realpath(r.source),
      component = await fs.realpath(r.component);
    const controller = new AbortController();
    const ctx: Context = {
      signal: controller.signal,
      log: (data) => {
        // Watcher output survives deployment-context cancellation and hub recovery.
        fs.appendFile(r.log, data).catch(() => {});
        parent.log(data);
      },
    };
    const matcher = ignore().add([...(r.service.dev?.exclude ?? [])]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: Promise<void> | undefined;
    let pending = false;
    const rebuild = () => {
      pending = true;
      if (active || controller.signal.aborted) return;
      active = (async () => {
        while (pending && !controller.signal.aborted) {
          pending = false;
          try {
            const built = await this.build(ctx, {
              root,
              name,
              service,
              tag: name,
            });
            if (controller.signal.aborted) break;
            const current = await this.read(name);
            if (!current) break;
            await this.terminate(current);
            await this.spawn(ctx, name, { ...current, component: built.image });
          } catch (e) {
            ctx.log(`WASM rebuild failed: ${message(e)}\n`);
          }
        }
      })().finally(() => {
        active = undefined;
      });
    };
    const watcher = watch(source, { recursive: true }, (_event, filename) => {
      const path = filename?.toString();
      if (
        !path ||
        path.split(/[\\/]/).some((p) => [".git", ".jj", "node_modules"].includes(p)) ||
        resolve(source, path) === component ||
        matcher.ignores(path)
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(rebuild, 300);
    });
    this.watchers.set(name, {
      stop: async () => {
        controller.abort();
        clearTimeout(timer);
        watcher.close();
        await active;
      },
    });
  }
}
