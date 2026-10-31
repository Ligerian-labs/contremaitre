import type { Readable } from "node:stream";
import { type Context, fail } from "@contremaitre/execution/context";
import type { RunOptions } from "@contremaitre/execution/process";
import type { RuntimeKind, Service, ServiceKind } from "@contremaitre/projects/model";
import { Apple, containerRuntime, type Runtime } from "./apple.js";
import { Docker } from "./docker.js";
import type { BuildRecord, ServiceState } from "./model.js";
import { PGliteRuntime } from "./pglite-runtime.js";
import { WasmtimeRuntime } from "./wasmtime.js";
/** Where a service accepts connections from the hub and from host processes. */
export interface Address {
  host: string;
  port: number;
}
export interface Inspection {
  /** Apple: the container IP. Host-process runtimes: a loopback address. Empty when unknown. */
  Host: string;
  Running: boolean;
}
export interface RunSpec {
  /** Process or container name, unique per environment and service (`ServiceState.Container`). */
  name: string;
  /** Apple image tag, or the artifact path returned by `build`. Empty for runtimes without one. */
  image: string;
  /** Apple network name. Host-process runtimes ignore it. */
  network: string;
  service: Service;
  /** Host path or volume name -> guest path. Persistent `volumes` entries use host paths. */
  volumes: Record<string, string>;
  /** Private KEY=VALUE file. Manager removes it after `run` resolves. */
  envFile: string;
  task?: boolean;
  timeout?: number;
  stdin?: Readable;
  /** Project root of the deployment. Set for every service. */
  root?: string;
  /** Declared port (string key) -> loopback port to bind. Set for `network: "host"` runtimes. */
  ports?: Record<string, number>;
  /** Private per-service data directory, kept until data deletion. Set for `network: "host"` runtimes. */
  data?: string;
  /** Host directory of `dev.source`. Set for `development: "mount"` runtimes with dev configured. */
  source?: string;
}
export interface BuildRequest {
  /** Project root. Manifest paths are relative to it. */
  root: string;
  name: string;
  service: Service;
  /** Unique tag Manager records before the build, for Apple image cleanup. */
  tag: string;
}
export interface CloneSide {
  /** Process or container name. */
  name: string;
  /** Private per-service data directory (`RunSpec.data`). */
  data: string;
  service: ServiceState;
}
export interface RuntimeCapabilities {
  /**
   * container: reachable on its own IP at the declared ports, attached to the
   * environment network. host: a host process on loopback; Manager reserves one
   * loopback port per declared port and passes them in `RunSpec.ports`.
   */
  network: "container" | "host";
  /**
   * sync: Manager mirrors `dev.source` and pushes changes with `sync`.
   * mount: Manager passes the host directory in `RunSpec.source` and never syncs;
   * the runtime reacts to source changes itself.
   */
  development: "sync" | "mount";
  /**
   * online: `clone` runs while source and target Postgres are running.
   * files: Manager stops source and target first, calls `clone`, then restarts both.
   */
  clone: "online" | "files";
}
/** One backend for one service kind. Manager selects it from the registry per service. */
export interface ServiceRuntime {
  readonly capabilities: RuntimeCapabilities;
  /** Check host prerequisites before a deployment uses this runtime. */
  preflight(ctx: Context): Promise<void>;
  /** Produce the runnable artifact for a service with `build` or `wasm`. */
  build(ctx: Context, request: BuildRequest, previous?: BuildRecord): Promise<BuildRecord>;
  /** Start a service, or run a task to completion when `spec.task` is set. */
  run(ctx: Context, spec: RunSpec): Promise<void>;
  inspect(ctx: Context, name: string): Promise<Inspection | undefined>;
  /** Restart a stopped service created by `run`. */
  start(ctx: Context, name: string): Promise<void>;
  stop(ctx: Context, name: string): Promise<void>;
  /** Remove a service; a missing one is not an error. */
  remove(ctx: Context, name: string): Promise<void>;
  /** Write service output to `ctx.log`; follow until `ctx.signal` aborts when `follow` is set. */
  logs(ctx: Context, name: string, follow?: boolean): Promise<void>;
  /** Run a command inside the service. Absent: readiness commands and service checks are unsupported. */
  exec?(ctx: Context, name: string, args: readonly string[], options?: RunOptions): Promise<Buffer>;
  /** Push source changes. Required for `development: "sync"`. */
  sync?(
    ctx: Context,
    spec: RunSpec,
    directory: string,
    changed: string[],
    removed: string[],
    initial: boolean,
  ): Promise<void>;
  /** Readiness probe. Absent: Manager runs the kind's readiness command through `exec`, or checks TCP. */
  ready?(ctx: Context, service: ServiceState, address: Address): Promise<boolean>;
  /** Copy Postgres data between environments, following `capabilities.clone`. */
  clone?(ctx: Context, from: CloneSide, to: CloneSide): Promise<void>;
}
export type RuntimeRegistry = {
  readonly [R in RuntimeKind]: Partial<Record<ServiceKind, ServiceRuntime>>;
};
export interface RegistryOptions {
  /** Hub state directory. */
  home: string;
  /** Native container adapter; the option name is retained for existing callers. */
  apple: Runtime;
}
export function runtimeRegistry(options: RegistryOptions): RuntimeRegistry {
  const native = containerRuntime(options.apple, options.home);
  const apple = {
    ...native,
    preflight: async (ctx: Context) => {
      if (options.apple instanceof Docker)
        fail("Apple containers require macOS; use runtime: docker on Linux");
      await native.preflight(ctx);
    },
  };
  const docker = {
    ...native,
    preflight: async (ctx: Context) => {
      if (options.apple instanceof Apple)
        fail("Docker native containers require a Linux hub; use runtime: apple on macOS");
      await native.preflight(ctx);
    },
  };
  return {
    apple: { app: apple, postgres: apple, redis: apple },
    docker: { app: docker, postgres: docker, redis: docker },
    wasm: {
      app: new WasmtimeRuntime(options),
      postgres: new PGliteRuntime(options),
    },
  };
}
export function selectRuntime(
  registry: RuntimeRegistry,
  runtime: RuntimeKind,
  kind: ServiceKind,
): ServiceRuntime {
  const selected = registry[runtime]?.[kind];
  if (!selected) fail(`No ${runtime} runtime for kind ${kind}`);
  return selected;
}
/** Placeholder until a lane registers the real runtime. Cleanup succeeds so environments stay deletable. */
export function unavailableRuntime(kind: ServiceKind): ServiceRuntime {
  const unavailable = (): never => fail(`WASM ${kind} runtime not available yet`);
  return {
    capabilities: { network: "host", development: "mount", clone: "files" },
    preflight: async () => unavailable(),
    build: async () => unavailable(),
    run: async () => unavailable(),
    start: async () => unavailable(),
    logs: async () => unavailable(),
    inspect: async () => undefined,
    stop: async () => {},
    remove: async () => {},
  };
}
