import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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
import { fingerprintBuildContext, prepareBuildContext } from "./build-context.js";
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
interface BuilderLease {
  resources: string[];
  release: () => void;
}
interface BuilderSession {
  users: number;
  ready: Promise<BuilderLease>;
}
export class Apple implements Runtime {
  private readonly builder = new Semaphore(4);
  // Service contexts in one deployment share a cancellation signal. Keep other
  // deployments out of the builder until every build in this session has settled.
  private readonly buildSessions = new Map<AbortSignal, BuilderSession>();
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
      const removeDeleted = 'for p do if [ ! -d "$p" ]; then rm -f -- "$p"; fi; done';
      const replaceShapes =
        // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion must remain literal.
        'for p do if [ -d "$p" ]; then rm -rf -- "$p"; fi; d=${p%/*}; while [ ! -d "$d" ]; do if [ -e "$d" ]; then rm -f -- "$d"; break; fi; d=${d%/*}; d=${d:-/}; done; done';
      if (initial) {
        // A reused source volume retains dependencies and generated files. Remove
        // deleted tracked inputs and resolve file/directory changes before extraction.
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const script: string[] = [];
        for (const [paths, action] of [
          [removed, removeDeleted],
          [changed, replaceShapes],
        ] as const)
          for (let i = 0; i < paths.length; i += 100)
            script.push(
              `set -- ${paths
                .slice(i, i + 100)
                .map((p) => quote(join(target, p)))
                .join(" ")}; ${action}`,
            );
        script.push(`mkdir -p ${quote(target)}; tar -xf - -C ${quote(target)}`);
        // The image may run as a non-root user. The parent state directory remains private.
        await fs.chmod(temp, 0o755);
        await fs.writeFile(join(temp, "apply.sh"), script.join("\n"), { mode: 0o644 });
        const control = join("/tmp", basename(temp));
        await this.remove(ctx, `${spec.name}-sync`);
        await this.run(ctx, {
          ...spec,
          name: `${spec.name}-sync`,
          task: true,
          stdin: createReadStream(archive),
          volumes: { ...spec.volumes, [temp]: control },
          service: {
            ...spec.service,
            working_dir: target,
            command: ["sh", "-eu", join(control, "apply.sh")],
          },
        });
      } else {
        for (let i = 0; i < removed.length; i += 100)
          await this.exec(ctx, spec.name, [
            "sh",
            "-eu",
            "-c",
            removeDeleted,
            "sync",
            ...removed.slice(i, i + 100).map((p) => join(target, p)),
          ]);
        for (let i = 0; i < changed.length; i += 100)
          await this.exec(ctx, spec.name, [
            "sh",
            "-eu",
            "-c",
            replaceShapes,
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
    if (previous) {
      phase(ctx, "Checking filtered build inputs");
      const current = await fingerprintBuildContext(ctx, root, dockerfile);
      if (previous.digest === current.digest) {
        try {
          await this.call(ctx, "image", "inspect", previous.image);
          phase(ctx, `Reusing unchanged image ${previous.image}`);
          return previous;
        } catch (e) {
          if (!missing(e)) throw e;
        }
      }
    }
    phase(ctx, "Preparing filtered build context");
    const staged = await prepareBuildContext(ctx, root, dockerfile);
    try {
      phase(ctx, `Build context: ${staged.files} files, ${(staged.bytes / 1e6).toFixed(2)} MB`);
      phase(ctx, "Waiting for a builder slot");
      return await this.builder.use(ctx.signal, () =>
        this.useBuilder(ctx, async (resources) => {
          phase(ctx, "building");
          await this.output(
            ctx,
            [
              "build",
              "--tag",
              tag,
              "--file",
              staged.dockerfile,
              "--progress",
              "plain",
              ...resources,
              staged.root,
            ],
            {
              stdout: ctx.log,
              stderr: ctx.log,
              timeout: 7_200_000,
            },
          );
          return { digest: staged.digest, image: tag };
        }),
      );
    } finally {
      await staged.cleanup();
    }
  }
  private async useBuilder(
    ctx: Context,
    work: (resources: string[]) => Promise<BuildRecord>,
  ): Promise<BuildRecord> {
    ctx.signal.throwIfAborted();
    let session = this.buildSessions.get(ctx.signal);
    if (!session) {
      session = { users: 0, ready: this.prepareBuilder(ctx) };
      this.buildSessions.set(ctx.signal, session);
    }
    session.users++;
    let lease: BuilderLease | undefined;
    try {
      lease = await session.ready;
      ctx.signal.throwIfAborted();
      return await work(lease.resources);
    } finally {
      if (--session.users === 0) {
        this.buildSessions.delete(ctx.signal);
        lease?.release();
      }
    }
  }
  private async prepareBuilder(ctx: Context): Promise<BuilderLease> {
    const release = await sharedBuilderLock(ctx);
    try {
      const resources: string[] = [];
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
          resources.push("--cpus", String(r.cpus), "--memory", String(r.memoryInBytes));
          phase(ctx, `Builder: ${r.cpus} CPUs, ${Math.floor(r.memoryInBytes / 1048576)} MB RAM`);
        }
      } catch (error) {
        if (!missing(error)) throw error;
      }
      // "running" does not mean compatible: Apple build reconciles image, resources,
      // managed environment, SSH and DNS, and may delete/recreate the builder.
      // Perform that reconciliation once, before this session launches any builds.
      phase(ctx, "Preparing shared builder");
      await this.output(ctx, ["builder", "start", ...resources]);
      return { resources, release };
    } catch (error) {
      release();
      throw error;
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
