import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  type Context,
  fail,
  HubError,
  keys,
  message,
  phase,
} from "@contremaitre/execution/context";
import { lockHome } from "@contremaitre/execution/files";
import { Semaphore } from "@contremaitre/execution/locks";
import { type RunOptions, run } from "@contremaitre/execution/process";
import { sleep } from "@contremaitre/execution/sleep";
import type { Service } from "@contremaitre/projects/model";
import { Schema } from "effect";
import { prepareBuildContext } from "./build-context.js";
import type { BuildRecord } from "./model.js";
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
  stdin?: Readable;
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
  sync(
    ctx: Context,
    spec: RunSpec,
    directory: string,
    changed: string[],
    removed: string[],
    initial: boolean,
  ): Promise<void>;
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
  private readonly builder = new Semaphore(4);
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
    if (s.stdin) args.push("--interactive");
    if (s.service.working_dir) args.push("--workdir", s.service.working_dir);
    for (const source of keys(s.volumes)) args.push("--volume", `${source}:${s.volumes[source]}`);
    args.push(s.image, ...(s.service.command ?? []));
    await this.output(
      ctx,
      args,
      s.task ? { stdin: s.stdin, stdout: ctx.log, stderr: ctx.log } : {},
    );
  }
  async sync(
    ctx: Context,
    spec: RunSpec,
    directory: string,
    changed: string[],
    removed: string[],
    initial: boolean,
  ) {
    const target = spec.service.dev?.target;
    if (!target) fail("Source sync requires dev.target");
    const temp = await fs.mkdtemp(join(directory, "../archive-"));
    try {
      const archive = join(temp, "source.tar"),
        list = join(temp, "files");
      await fs.writeFile(list, changed.map((p) => `./${p}\0`).join(""));
      await run(
        ctx,
        ["tar", "--no-xattrs", "-cf", archive, "-C", directory, "--null", "-T", list],
        {
          env: { ...process.env, COPYFILE_DISABLE: "1" },
        },
      );
      const command = ["sh", "-eu", "-c", 'mkdir -p "$1"; tar -xf - -C "$1"', "sync", target];
      if (initial) {
        await this.remove(ctx, `${spec.name}-sync`);
        await this.run(ctx, {
          ...spec,
          name: `${spec.name}-sync`,
          task: true,
          stdin: createReadStream(archive),
          service: { ...spec.service, working_dir: target, command },
        });
      } else {
        for (let i = 0; i < removed.length; i += 100)
          await this.exec(ctx, spec.name, [
            "sh",
            "-eu",
            "-c",
            'for p do if [ ! -d "$p" ]; then rm -f -- "$p"; fi; done',
            "sync",
            ...removed.slice(i, i + 100).map((p) => join(target, p)),
          ]);
        for (let i = 0; i < changed.length; i += 100)
          await this.exec(ctx, spec.name, [
            "sh",
            "-eu",
            "-c",
            'for p do if [ -d "$p" ]; then rm -rf -- "$p"; fi; d=$(dirname "$p"); while [ ! -d "$d" ]; do if [ -e "$d" ]; then rm -f -- "$d"; break; fi; d=$(dirname "$d"); done; done',
            "sync",
            ...changed.slice(i, i + 100).map((p) => join(target, p)),
          ]);
        if (changed.length)
          await this.exec(ctx, spec.name, command, { stdin: createReadStream(archive) });
      }
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
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
      phase(ctx, "Waiting for a builder slot");
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
          // Serialize builder bootstrap only. Running BuildKit accepts independent sessions.
          if (!(await this.inspect(ctx, "buildkit"))?.Running) {
            const resourceArgs = args.slice(
              args.indexOf("--cpus") < 0 ? args.length : args.indexOf("--cpus"),
            );
            await this.output(ctx, ["builder", "start", ...resourceArgs]);
          }
          release();
          phase(ctx, "building");
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
      await sleep(25, ctx.signal);
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
