import { existsSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  type Context,
  context,
  decode,
  fail,
  message,
  strings,
} from "@contremaitre/execution/context";
import { atomicWrite, privateFile, removeFile } from "@contremaitre/execution/files";
import { EnvironmentLocks } from "@contremaitre/execution/locks";
import { sleep } from "@contremaitre/execution/sleep";
import { serviceSchema } from "@contremaitre/projects/model";
import { Schema } from "effect";
import type { ServiceState } from "./model.js";
import type { Address, BuildRequest, CloneSide, RunSpec, ServiceRuntime } from "./runtimes.js";

export const defaultWasmIdleTimeoutSeconds = 60;
const startupTimeoutMs = 35_000;
const maxConnections = 128;
const portsSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Int.pipe(Schema.between(1, 65535)),
});
const recordSchema = Schema.Struct({
  version: Schema.Literal(1),
  desired: Schema.Literal("running", "stopped"),
  suspended: Schema.Boolean,
  ports: portsSchema,
  spec: Schema.Struct({
    name: Schema.String,
    image: Schema.String,
    network: Schema.String,
    service: serviceSchema,
    volumes: strings,
    ports: portsSchema,
    root: Schema.optional(Schema.String),
    data: Schema.optional(Schema.String),
    source: Schema.optional(Schema.String),
  }),
  environment: Schema.String,
});
type RecordState = Schema.Schema.Type<typeof recordSchema>;
interface Instance {
  record: RecordState;
  servers: Server[];
  sockets: Set<Socket>;
  clients: Set<Socket>;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  enabled: boolean;
  awake: boolean;
}

/** Stable loopback listeners outlive idle backends. The hub owns listeners and timers. */
export class ActivationRuntime implements ServiceRuntime {
  readonly capabilities;
  private readonly instances = new Map<string, Instance>();
  private readonly locks = new EnvironmentLocks();
  constructor(
    readonly backend: ServiceRuntime,
    readonly home: string,
  ) {
    this.capabilities = backend.capabilities;
  }
  private path(name: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) fail("Invalid activation service name");
    return join(this.home, "activation", `${name}.json`);
  }
  private read(name: string): RecordState | undefined {
    const path = this.path(name);
    if (!existsSync(path)) return;
    const r = decode(
      recordSchema,
      JSON.parse(readFileSync(path, "utf8")),
      `activation record ${name}`,
    );
    if (
      r.spec.name !== name ||
      Object.keys(r.ports).length === 0 ||
      Object.keys(r.ports).some((key) => !r.spec.ports[key])
    )
      fail(`Invalid activation record ${name}`);
    return r;
  }
  private save(instance: Instance) {
    atomicWrite(this.path(instance.record.spec.name), JSON.stringify(instance.record));
  }
  private log(name: string, event: string, error?: unknown) {
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), event: `contremaitre.service.${event}`, service: name, ...(error ? { error: message(error) } : {}) })}\n`,
    );
  }
  preflight(ctx: Context, service?: RunSpec["service"]) {
    return this.backend.preflight(ctx, service);
  }
  build(ctx: Context, request: BuildRequest, previous?: Parameters<ServiceRuntime["build"]>[2]) {
    return this.backend.build(ctx, request, previous);
  }
  logs(ctx: Context, name: string, follow = false) {
    return this.backend.logs(ctx, name, follow);
  }
  async clone(ctx: Context, from: CloneSide, to: CloneSide) {
    if (!this.backend.clone) fail("Runtime does not support cloning");
    await this.backend.clone(ctx, from, to);
  }
  private schedule(instance: Instance) {
    clearTimeout(instance.timer);
    const seconds =
      instance.record.spec.service.idle_timeout_seconds ?? defaultWasmIdleTimeoutSeconds;
    if (!instance.enabled || !instance.awake || instance.clients.size || !seconds) return;
    instance.timer = setTimeout(() => {
      void this.locks
        .use([instance.record.spec.name], instance.controller.signal, async () => {
          if (!instance.enabled || instance.clients.size || !instance.awake) return;
          await this.backend.stop(context(instance.controller.signal), instance.record.spec.name);
          instance.awake = false;
          instance.record = { ...instance.record, suspended: true };
          this.save(instance);
          this.log(instance.record.spec.name, "idle_suspend");
        })
        .catch((error) => {
          if (instance.enabled) {
            this.log(instance.record.spec.name, "idle_suspend_failed", error);
            this.schedule(instance);
          }
        });
    }, seconds * 1000);
    instance.timer.unref();
  }
  private async wake(ctx: Context, instance: Instance) {
    const name = instance.record.spec.name;
    await this.locks.use([name], ctx.signal, async () => {
      if (!instance.enabled) fail("Service is stopped");
      // A disconnected first caller must not cancel startup for the other callers.
      ctx = context(
        AbortSignal.any([instance.controller.signal, AbortSignal.timeout(startupTimeoutMs)]),
      );
      await this.ensureAwake(ctx, instance);
      this.schedule(instance);
    });
  }
  private async ensureAwake(ctx: Context, instance: Instance) {
    const name = instance.record.spec.name;
    const existing = await this.backend.inspect(ctx, name);
    if (!existing?.Running) {
      const ports = await backendPorts(instance.record.ports, instance.record.spec.ports);
      instance.record = { ...instance.record, spec: { ...instance.record.spec, ports } };
      this.save(instance);
      if (existing && !existing.RecordInvalid) await this.backend.start(ctx, name, ports);
      else {
        if (existing?.RecordInvalid) await this.backend.remove(ctx, name);
        const envFile = privateFile(join(this.home, "tmp"), instance.record.environment);
        try {
          await this.backend.run(ctx, { ...instance.record.spec, envFile });
        } finally {
          removeFile(envFile);
        }
      }
      this.log(name, "wake");
    }
    if (!existing?.Running || !instance.awake) {
      try {
        await this.httpReady(ctx, instance.record);
      } catch (error) {
        await this.backend.stop(context(AbortSignal.timeout(15_000)), name);
        throw error;
      }
    }
    const changed = !instance.awake || instance.record.suspended;
    instance.awake = true;
    instance.record = { ...instance.record, suspended: false };
    if (changed) this.save(instance);
  }
  private async httpReady(ctx: Context, record: RecordState) {
    ctx = { ...ctx, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(startupTimeoutMs)]) };
    const service = record.spec.service;
    if (service.kind === "postgres" || (!service.http && service.wasm?.engine === "wasmer")) return;
    const port = record.spec.ports[String(service.port)];
    if (!port) return;
    // Some frameworks listen before their handler is installed. Probe a safe HTTP
    // exchange rather than forwarding user bytes into that startup window.
    const probe = () =>
      new Promise<boolean>((resolve, reject) => {
        ctx.signal.throwIfAborted();
        const req = request({
          host: "127.0.0.1",
          port,
          method: "OPTIONS",
          path: "/",
          agent: false,
        });
        const timer = setTimeout(() => finish(false), 500);
        const finish = (ready: boolean, error?: unknown) => {
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", abort);
          req.destroy();
          if (error) reject(error);
          else resolve(ready);
        };
        const abort = () => finish(false, ctx.signal.reason);
        req.once("response", (response) => {
          response.destroy();
          finish(true);
        });
        req.once("error", () => finish(false));
        ctx.signal.addEventListener("abort", abort, { once: true });
        req.end();
      });
    while (!(await probe())) await sleep(50, ctx.signal);
  }
  private accept(instance: Instance, declared: string, client: Socket) {
    if (!instance.enabled || instance.clients.size >= maxConnections) {
      client.destroy();
      return;
    }
    client.pause();
    instance.clients.add(client);
    instance.sockets.add(client);
    clearTimeout(instance.timer);
    let upstream: Socket | undefined;
    const deadline = setTimeout(() => client.destroy(), startupTimeoutMs);
    const cancelled = new AbortController();
    client.on("error", () => client.destroy());
    client.once("close", () => {
      clearTimeout(deadline);
      cancelled.abort();
      upstream?.destroy();
      instance.clients.delete(client);
      instance.sockets.delete(client);
      this.schedule(instance);
    });
    const signal = AbortSignal.any([
      instance.controller.signal,
      cancelled.signal,
      AbortSignal.timeout(startupTimeoutMs),
    ]);
    void this.wake(context(signal), instance)
      .then(() => {
        if (client.destroyed || !instance.enabled) return;
        const port = instance.record.spec.ports?.[declared];
        if (!port) throw Error("Missing backend port");
        upstream = createConnection({
          host: "127.0.0.1",
          port,
        });
        instance.sockets.add(upstream);
        upstream.once("connect", () => {
          clearTimeout(deadline);
          client.pipe(upstream as Socket).pipe(client);
        });
        upstream.on("error", () => client.destroy());
        upstream.once("close", () => {
          instance.sockets.delete(upstream as Socket);
          client.destroy();
        });
      })
      .catch((error) => {
        if (!signal.aborted) this.log(instance.record.spec.name, "wake_failed", error);
        client.destroy();
      });
  }
  private async bind(record: RecordState): Promise<Instance> {
    const instance: Instance = {
      record,
      servers: [],
      sockets: new Set(),
      clients: new Set(),
      controller: new AbortController(),
      enabled: true,
      awake: !record.suspended,
    };
    try {
      for (const [declared, port] of Object.entries(record.ports)) {
        const server = createServer((socket) => this.accept(instance, declared, socket));
        instance.servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
            server.off("error", reject);
            resolve();
          });
        });
        server.on("error", (error) => this.log(record.spec.name, "listener_failed", error));
        server.unref();
      }
      this.instances.set(record.spec.name, instance);
      return instance;
    } catch (error) {
      await this.unbind(instance);
      throw error;
    }
  }
  private async unbind(instance: Instance) {
    instance.enabled = false;
    instance.controller.abort();
    clearTimeout(instance.timer);
    for (const socket of instance.sockets) socket.destroy();
    await Promise.all(
      instance.servers.map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    if (this.instances.get(instance.record.spec.name) === instance)
      this.instances.delete(instance.record.spec.name);
  }
  async run(ctx: Context, spec: RunSpec) {
    if (spec.task) return this.backend.run(ctx, spec);
    await this.locks.use([spec.name], ctx.signal, async () => {
      const previous = this.instances.get(spec.name);
      if (previous) await this.unbind(previous);
      const ports = { ...spec.ports };
      const privatePorts = await backendPorts(ports);
      const { envFile, stdin: _, ...remembered } = spec;
      const record: RecordState = {
        version: 1,
        desired: "running",
        suspended: false,
        ports,
        spec: { ...remembered, ports: privatePorts },
        environment: readFileSync(envFile, "utf8"),
      };
      // Hold public ports before starting the backend. Wake requests wait on this lock.
      const instance = await this.bind(record);
      try {
        await this.backend.run(ctx, { ...spec, ports: privatePorts });
        await this.httpReady(ctx, record);
        this.save(instance);
        this.schedule(instance);
      } catch (error) {
        try {
          await this.backend.stop(context(AbortSignal.timeout(15_000)), spec.name);
        } finally {
          await this.unbind(instance);
        }
        throw error;
      }
    });
  }
  async inspect(ctx: Context, name: string) {
    return this.locks.use([name], ctx.signal, async () => {
      let instance = this.instances.get(name);
      const record = instance?.record ?? this.read(name);
      if (!record) return this.backend.inspect(ctx, name);
      if (record.desired !== "running") return { Host: "", Running: false };
      if (!instance) {
        if (record.suspended) await this.backend.stop(ctx, name);
        instance = await this.bind(record);
        if (!record.suspended) await this.ensureAwake(ctx, instance);
        this.schedule(instance);
      }
      return { Host: "127.0.0.1", Running: true, Suspended: !instance.awake };
    });
  }
  async start(ctx: Context, name: string) {
    await this.locks.use([name], ctx.signal, async () => {
      let instance = this.instances.get(name);
      if (!instance) {
        const record = this.read(name);
        if (!record) {
          await this.backend.start(ctx, name);
          return;
        }
        instance = await this.bind({ ...record, desired: "running" });
        this.save(instance);
      }
    });
    const instance = this.instances.get(name);
    if (instance) {
      await this.wake(ctx, instance);
      this.schedule(instance);
    }
  }
  async stop(ctx: Context, name: string) {
    // Abort an in-flight wake before waiting for the lifecycle lock.
    const active = this.instances.get(name);
    if (active) {
      active.enabled = false;
      active.controller.abort();
    }
    await this.locks.use([name], ctx.signal, async () => {
      const instance = this.instances.get(name);
      const record = instance?.record ?? this.read(name);
      if (record) {
        atomicWrite(this.path(name), JSON.stringify({ ...record, desired: "stopped" }));
      }
      if (instance) await this.unbind(instance);
      await this.backend.stop(ctx, name);
    });
  }
  async remove(ctx: Context, name: string) {
    await this.stop(ctx, name);
    await this.backend.remove(ctx, name);
    rmSync(this.path(name), { force: true });
  }
  async ready(ctx: Context, service: ServiceState, _address: Address) {
    const instance = this.instances.get(service.Container);
    if (!instance?.enabled) return false;
    await this.wake(ctx, instance);
    try {
      const port = instance.record.spec.ports?.[String(service.Port)];
      if (!port) return false;
      return this.backend.ready
        ? await this.backend.ready(ctx, service, { host: "127.0.0.1", port })
        : !!(await this.backend.inspect(ctx, service.Container))?.Running;
    } finally {
      this.schedule(instance);
    }
  }
  async shutdown() {
    for (const instance of [...this.instances.values()]) {
      await this.unbind(instance);
      await this.locks.use(
        [instance.record.spec.name],
        AbortSignal.timeout(startupTimeoutMs),
        async () => {},
      );
    }
    await this.backend.shutdown?.();
  }
}
async function backendPorts(
  publicPorts: Record<string, number>,
  previous: Record<string, number> = {},
) {
  const used = new Set(Object.values(publicPorts));
  const ports: Record<string, number> = {};
  for (const key of Object.keys(publicPorts)) {
    let port = previous[key] && !used.has(previous[key]) ? await freePort(previous[key]) : 0;
    while (!port || used.has(port)) port = await freePort();
    used.add(port);
    ports[key] = port;
  }
  return ports;
}
async function freePort(port = 0): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", (error) =>
      "code" in error && error.code === "EADDRINUSE" ? resolve(0) : reject(error),
    );
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        address && typeof address !== "string"
          ? resolve(address.port)
          : reject(Error("No backend port assigned")),
      );
    });
  });
}
