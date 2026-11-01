import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Context, fail, phase } from "@contremaitre/execution/context";
import { EnvironmentLocks } from "@contremaitre/execution/locks";
import type { BuildRecord, ServiceState } from "./model.js";
import { checkPgliteAssets } from "./pglite-assets.js";
import { forkPgliteData } from "./pglite-fork.js";
import { type LogTail, PgliteLogWriter, tailPgliteLog } from "./pglite-logs.js";
import { waitPgliteReady } from "./pglite-ready.js";
import { type PgliteHandle, startPglite } from "./pglite-server.js";
import type {
  Address,
  BuildRequest,
  CloneSide,
  Inspection,
  RunSpec,
  RuntimeCapabilities,
  ServiceRuntime,
} from "./runtimes.js";
import { Store } from "./store.js";

interface Instance {
  spec: Omit<RunSpec, "envFile">;
  password: string;
  port: number;
  data: string;
  handle?: PgliteHandle;
  writer?: PgliteLogWriter;
  launchCursor?: LogTail;
}

export class PGliteRuntime implements ServiceRuntime {
  readonly capabilities: RuntimeCapabilities = {
    network: "host",
    development: "mount",
    clone: "files",
  };
  private readonly instances = new Map<string, Instance>();
  private readonly locks = new EnvironmentLocks();
  private readonly home: string;
  constructor(options: { home: string; apple?: unknown }) {
    this.home = options.home;
  }
  private logPath(name: string): string {
    const instance = this.instances.get(name);
    if (instance) return `${instance.data}.pglite-log`;
    for (const env of Object.values(new Store(this.home).load().Environments)) {
      const service = Object.values(env.Services).find((service) => service.Container === name);
      if (service)
        return join(this.home, "data", env.Identity.ID, ".services", `${service.Name}.pglite-log`);
    }
    return join(this.home, `${encodeURIComponent(name)}.pglite-log`);
  }

  async preflight(ctx: Context): Promise<void> {
    ctx.signal.throwIfAborted();
    await checkPgliteAssets();
  }
  async build(
    _ctx: Context,
    _request: BuildRequest,
    _previous?: BuildRecord,
  ): Promise<BuildRecord> {
    return fail("PGlite postgres does not support builds");
  }
  async run(ctx: Context, spec: RunSpec): Promise<void> {
    if (spec.task) fail("PGlite postgres does not support task commands or init/migrate");
    if (spec.service.kind !== "postgres") fail("PGlite runtime requires kind postgres");
    const port = spec.ports?.[String(spec.service.port ?? 5432)];
    if (!port || !spec.data)
      fail("PGlite requires a reserved port and private service data directory");
    const data = spec.data;
    // Manager unlinks the file as soon as this method returns.
    const environment = Object.fromEntries(
      (await readFile(spec.envFile, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf("=");
          if (at < 1) fail("Invalid PGlite environment file");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    if (
      environment.POSTGRES_USER !== "app" ||
      environment.POSTGRES_DB !== "app" ||
      !environment.POSTGRES_PASSWORD
    )
      fail("PGlite requires POSTGRES_USER=app, POSTGRES_DB=app and POSTGRES_PASSWORD");
    const { envFile: _, ...remembered } = spec;
    await this.locks.use([spec.name], ctx.signal, async () => {
      await this.stopInstance(this.instances.get(spec.name));
      const instance: Instance = {
        spec: {
          ...remembered,
          service: structuredClone(remembered.service),
          ports: { ...remembered.ports },
        },
        password: environment.POSTGRES_PASSWORD,
        port,
        data,
      };
      this.instances.set(spec.name, instance);
      await this.launch(ctx, instance);
    });
  }
  private async launch(ctx: Context, instance: Instance): Promise<void> {
    ctx.signal.throwIfAborted();
    if (instance.handle && !instance.handle.running) await this.stopInstance(instance);
    // A deployment context expires independently of the service's lifetime.
    mkdirSync(dirname(instance.data), { recursive: true, mode: 0o700 });
    instance.writer = new PgliteLogWriter(this.logPath(instance.spec.name));
    instance.launchCursor = instance.writer.cursor();
    try {
      instance.handle = await startPglite({
        dataDir: instance.data,
        port: instance.port,
        host: "127.0.0.1",
        ...(instance.spec.service.connection_wait_seconds === undefined
          ? {}
          : { connectionWaitMs: instance.spec.service.connection_wait_seconds * 1000 }),
        log: (text) => instance.writer?.append(text),
      });
    } finally {
      await instance.writer.flush();
    }
    if (ctx.signal.aborted) {
      await this.stopInstance(instance);
      ctx.signal.throwIfAborted();
    }
  }
  private async stopInstance(instance?: Instance): Promise<void> {
    try {
      await instance?.handle?.stop();
    } finally {
      await instance?.writer?.close();
    }
  }
  async inspect(_ctx: Context, name: string): Promise<Inspection | undefined> {
    const instance = this.instances.get(name);
    return instance ? { Host: "127.0.0.1", Running: instance.handle?.running ?? false } : undefined;
  }
  async start(ctx: Context, name: string): Promise<void> {
    await this.locks.use([name], ctx.signal, async () => {
      const instance = this.instances.get(name);
      if (!instance) fail(`Unknown PGlite service ${name}`);
      if (!instance.handle?.running) await this.launch(ctx, instance);
    });
  }
  async stop(ctx: Context, name: string): Promise<void> {
    await this.locks.use([name], ctx.signal, async () => {
      await this.stopInstance(this.instances.get(name));
    });
  }
  async remove(ctx: Context, name: string): Promise<void> {
    await this.locks.use([name], ctx.signal, async () => {
      await this.stopInstance(this.instances.get(name));
      this.instances.delete(name);
    });
  }
  async logs(ctx: Context, name: string, follow = false): Promise<void> {
    await tailPgliteLog(
      ctx,
      this.logPath(name),
      follow,
      follow ? this.instances.get(name)?.launchCursor : undefined,
    );
  }

  async ready(ctx: Context, service: ServiceState, address: Address): Promise<boolean> {
    const instance = this.instances.get(service.Container);
    if (!instance?.handle?.running) return false;
    const url = `postgresql://app:${encodeURIComponent(instance.password)}@${address.host}:${address.port}/app?sslmode=disable`;
    try {
      await waitPgliteReady(url, { signal: ctx.signal, timeout: 1000 });
      return true;
    } catch {
      ctx.signal.throwIfAborted();
      return false;
    }
  }
  async clone(ctx: Context, from: CloneSide, to: CloneSide): Promise<void> {
    await this.locks.use([from.name, to.name], ctx.signal, async () => {
      if (
        this.instances.get(from.name)?.handle?.running ||
        this.instances.get(to.name)?.handle?.running
      )
        fail("PGlite clone requires both services stopped and writers paused");
      const { method } = await forkPgliteData({
        source: from.data,
        target: to.data,
        ctx,
        replace: true,
      });
      phase(
        ctx,
        method === "clonefile"
          ? "cloned Postgres data with clonefile"
          : "copied Postgres data (clonefile unavailable)",
      );
    });
  }
}
