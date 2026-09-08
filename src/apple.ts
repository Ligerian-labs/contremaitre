import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { prepareBuildContext } from "./build-context.js";
import { Semaphore } from "./locks.js";
import {
  type BuildRecord,
  type Context,
  fail,
  HubError,
  keys,
  message,
  phase,
  type Service,
} from "./model.js";
import { type RunOptions, run, sleep } from "./process.js";
import { lockHome } from "./store.js";
export interface Inspection {
  IP: string;
  Running: boolean;
}
export interface RunSpec {
  name: string;
  image: string;
  network: string;
  service: Service;
  volumes: Record<string, string>;
  envFile: string;
  task?: boolean;
}
export interface Runtime {
  startSystem(ctx: Context): Promise<void>;
  build(
    ctx: Context,
    root: string,
    dockerfile: string,
    tag: string,
    previous?: BuildRecord,
  ): Promise<BuildRecord>;
  network(ctx: Context, name: string): Promise<void>;
  removeNetwork(ctx: Context, name: string): Promise<void>;
  volume(ctx: Context, name: string): Promise<void>;
  removeVolume(ctx: Context, name: string): Promise<void>;
  removeImage(ctx: Context, name: string): Promise<void>;
  run(ctx: Context, s: RunSpec): Promise<void>;
  inspect(ctx: Context, name: string): Promise<Inspection | undefined>;
  stop(ctx: Context, name: string): Promise<void>;
  start(ctx: Context, name: string): Promise<void>;
  remove(ctx: Context, name: string): Promise<void>;
  exec(ctx: Context, name: string, args: readonly string[], options?: RunOptions): Promise<Buffer>;
  logs(ctx: Context, name: string): Promise<void>;
}
export const missing = (e: unknown): boolean =>
  /notFound|not found|does not exist/.test(message(e));
const networks = Schema.Array(Schema.Struct({ ipv4Address: Schema.String }));
const inspection = Schema.Array(
  Schema.Struct({
    status: Schema.Union(
      Schema.String,
      Schema.Struct({ state: Schema.String, networks: Schema.optional(networks) }),
    ),
    networks: Schema.optional(networks),
  }),
);
export function decodeInspection(data: unknown): Inspection {
  const values = Schema.decodeUnknownSync(inspection)(data);
  if (values.length !== 1) fail("Expected one container inspection");
  const v = values[0],
    status = typeof v.status === "string" ? { state: v.status, networks: v.networks } : v.status;
  return {
    Running: status.state === "running",
    IP: status.networks?.[0]?.ipv4Address.split("/")[0] ?? "",
  };
}
export class Apple implements Runtime {
  private readonly builder = new Semaphore(1);
  constructor(readonly binary = "container") {}
  output(ctx: Context, args: readonly string[], opts: RunOptions = {}) {
    return run(ctx, [this.binary, ...args], opts);
  }
  async call(ctx: Context, ...args: string[]) {
    await this.output(ctx, args);
  }
  async startSystem(ctx: Context) {
    await this.call(ctx, "system", "start", "--enable-kernel-install");
  }
  async network(ctx: Context, name: string) {
    try {
      await this.call(ctx, "network", "inspect", name);
    } catch (e) {
      if (!missing(e)) throw e;
      await this.call(ctx, "network", "create", name);
    }
  }
  async volume(ctx: Context, name: string) {
    try {
      await this.call(ctx, "volume", "inspect", name);
    } catch (e) {
      if (!missing(e)) throw e;
      await this.call(ctx, "volume", "create", "--label", "dev.contremaitre.managed=true", name);
    }
  }
  private async removeResource(ctx: Context, kind: string, name: string) {
    try {
      await this.call(ctx, kind, "inspect", name);
    } catch (e) {
      if (missing(e)) return;
      throw e;
    }
    await this.call(ctx, kind, "delete", name);
  }
  removeNetwork(ctx: Context, name: string) {
    return this.removeResource(ctx, "network", name);
  }
  removeVolume(ctx: Context, name: string) {
    return this.removeResource(ctx, "volume", name);
  }
  removeImage(ctx: Context, name: string) {
    return this.removeResource(ctx, "image", name);
  }
  async inspect(ctx: Context, name: string): Promise<Inspection | undefined> {
    try {
      return decodeInspection(
        JSON.parse((await this.output(ctx, ["inspect", name], { timeout: 10_000 })).toString()),
      );
    } catch (e) {
      if (missing(e)) return;
      throw e;
    }
  }
  async stop(ctx: Context, name: string) {
    if ((await this.inspect(ctx, name))?.Running) await this.call(ctx, "stop", name);
  }
  async start(ctx: Context, name: string) {
    await this.call(ctx, "start", name);
  }
  async remove(ctx: Context, name: string) {
    if (await this.inspect(ctx, name)) await this.call(ctx, "delete", "--force", name);
  }
  async run(ctx: Context, s: RunSpec) {
    const args = [
      "run",
      "--name",
      s.name,
      "--network",
      s.network,
      "--label",
      "dev.contremaitre.managed=true",
      "--cpus",
      String(s.service.cpus ?? 1),
      "--memory",
      s.service.memory ?? "512M",
      s.task ? "--rm" : "--detach",
    ];
    if (s.envFile) args.push("--env-file", s.envFile);
    for (const source of keys(s.volumes)) args.push("--volume", `${source}:${s.volumes[source]}`);
    args.push(s.image, ...(s.service.command ?? []));
    await this.output(ctx, args, s.task ? { stdout: ctx.log, stderr: ctx.log } : {});
  }
  exec(ctx: Context, name: string, args: readonly string[], options: RunOptions = {}) {
    return this.output(
      ctx,
      ["exec", ...(options.stdin ? ["--interactive"] : []), name, ...args],
      options,
    );
  }
  async logs(ctx: Context, name: string) {
    await this.output(ctx, ["logs", "--follow", name], {
      stdout: ctx.log,
      stderr: ctx.log,
      timeout: 86_400_000,
    });
  }
  async build(
    ctx: Context,
    root: string,
    dockerfile: string,
    tag: string,
    previous?: BuildRecord,
  ): Promise<BuildRecord> {
    phase(ctx, "Preparing filtered build context");
    const staged = await prepareBuildContext(ctx, root, dockerfile);
    try {
      phase(ctx, `Build context: ${staged.files} files, ${(staged.bytes / 1e6).toFixed(2)} MB`);
      if (previous?.digest === staged.digest) {
        try {
          await this.call(ctx, "image", "inspect", previous.image);
          phase(ctx, `Reusing unchanged image ${previous.image}`);
          return previous;
        } catch (e) {
          if (!missing(e)) throw e;
        }
      }
      phase(ctx, "Waiting for the shared builder");
      return await this.builder.use(ctx.signal, async () => {
        const release = await sharedBuilderLock(ctx);
        try {
          const args = ["build", "--tag", tag, "--file", staged.dockerfile, "--progress", "plain"];
          try {
            const value: unknown = JSON.parse(
              (await this.output(ctx, ["inspect", "buildkit"])).toString(),
            );
            const builders = Schema.decodeUnknownSync(
              Schema.Array(
                Schema.Struct({
                  configuration: Schema.Struct({
                    resources: Schema.Struct({ cpus: Schema.Number, memoryInBytes: Schema.Number }),
                  }),
                }),
              ),
            )(value);
            const r = builders[0]?.configuration.resources;
            if (r && r.cpus > 0 && r.memoryInBytes > 0) {
              args.push("--cpus", String(r.cpus), "--memory", String(r.memoryInBytes));
              phase(
                ctx,
                `Builder: ${r.cpus} CPUs, ${Math.floor(r.memoryInBytes / 1048576)} MB RAM`,
              );
            }
          } catch (e) {
            if (!missing(e)) throw e;
          }
          await this.output(ctx, [...args, staged.root], {
            stdout: ctx.log,
            stderr: ctx.log,
            timeout: 7_200_000,
          });
          return { digest: staged.digest, image: tag };
        } finally {
          release();
        }
      });
    } finally {
      await staged.cleanup();
    }
  }
}
async function sharedBuilderLock(ctx: Context): Promise<() => void> {
  const directory = join(
    homedir(),
    process.platform === "darwin" ? "Library/Caches" : ".cache",
    "contremaitre",
    "builder-lock",
  );
  while (true) {
    ctx.signal.throwIfAborted();
    try {
      return lockHome(directory);
    } catch (e) {
      if (!(e instanceof HubError) || e.classification !== "conflict") throw e;
      await sleep(250, ctx.signal);
    }
  }
}
export async function tcpReady(host: string, port: number, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (ok: boolean) => {
      signal.removeEventListener("abort", abort);
      socket.destroy();
      resolve(ok);
    };
    const abort = () => finish(false);
    socket.setTimeout(2000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    signal.addEventListener("abort", abort, { once: true });
  });
}
