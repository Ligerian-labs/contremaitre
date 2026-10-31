import { type Context, fail, keys, message, phase } from "@contremaitre/execution/context";
import { type RunOptions, run } from "@contremaitre/execution/process";
import { Schema } from "effect";
import type { Runtime } from "./apple.js";
import { fingerprintBuildContext, prepareBuildContext } from "./build-context.js";
import { syncSource } from "./container-sync.js";
import type { BuildRecord } from "./model.js";
import type { Inspection, RunSpec } from "./runtimes.js";

// Docker's missing-resource errors differ from Apple's. Permission, daemon and
// active-resource failures must reach the caller rather than appear as absence.
const missing = (error: unknown) =>
  /No such (container|object|image|volume|network)\b|\b(network|volume|image) .+ not found\b/i.test(
    message(error),
  );
const inspection = Schema.Array(
  Schema.Struct({
    State: Schema.Struct({ Running: Schema.Boolean }),
    NetworkSettings: Schema.Struct({
      Networks: Schema.Record({
        key: Schema.String,
        value: Schema.Struct({ IPAddress: Schema.String }),
      }),
    }),
  }),
);

/** Local rootful Docker Engine. The Linux hub reaches containers on their bridge IPs. */
export class Docker implements Runtime {
  constructor(
    readonly binary = "docker",
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}
  output(ctx: Context, args: readonly string[], options: RunOptions = {}) {
    return run(ctx, [this.binary, ...args], options);
  }
  async startSystem(ctx: Context) {
    if (this.platform !== "linux")
      fail("Docker native containers require a Linux host with local Docker Engine");
    try {
      const endpoint =
        (!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST) ||
        (
          await this.output(ctx, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
            timeout: 10_000,
          })
        )
          .toString()
          .trim();
      if (!endpoint.startsWith("unix://"))
        fail("Docker requires a local Unix socket; remote Docker hosts are unsupported");
      const info = JSON.parse(
        (
          await this.output(ctx, ["info", "--format", "{{json .}}"], { timeout: 10_000 })
        ).toString(),
      );
      if (
        info.OSType !== "linux" ||
        info.SecurityOptions?.some((v: string) => v.includes("rootless")) ||
        /docker desktop/i.test(info.OperatingSystem ?? "")
      )
        fail(
          "Use local rootful Docker Engine; rootless Docker and Docker Desktop do not provide host-reachable bridge addresses",
        );
    } catch (error) {
      ctx.signal.throwIfAborted();
      fail(
        `Docker Engine is unavailable: ${message(error)}. Install and start local Docker Engine and give this user access to its socket.`,
      );
    }
  }
  async network(ctx: Context, name: string) {
    try {
      await this.output(ctx, ["network", "inspect", name], { timeout: 10_000 });
    } catch (error) {
      if (!missing(error)) throw error;
      await this.output(
        ctx,
        [
          "network",
          "create",
          "--driver",
          "bridge",
          "--label",
          "dev.contremaitre.managed=true",
          name,
        ],
        { timeout: 10_000 },
      );
    }
  }
  async hostNetwork(ctx: Context, name: string) {
    const schema = Schema.Array(
      Schema.Struct({
        IPAM: Schema.Struct({
          Config: Schema.Array(
            Schema.Struct({ Gateway: Schema.optional(Schema.String), Subnet: Schema.String }),
          ),
        }),
      }),
    );
    const [network] = Schema.decodeUnknownSync(schema)(
      JSON.parse(
        (await this.output(ctx, ["network", "inspect", name], { timeout: 10_000 })).toString(),
      ),
    );
    const config = network?.IPAM.Config.find((c) => c.Gateway && !c.Subnet.includes(":"));
    if (!config?.Gateway) fail(`Cannot inspect Docker IPv4 gateway for ${name}`);
    return { gateway: config.Gateway, subnet: config.Subnet };
  }
  async volume(ctx: Context, name: string) {
    try {
      await this.output(ctx, ["volume", "inspect", name]);
    } catch (error) {
      if (!missing(error)) throw error;
      await this.output(ctx, [
        "volume",
        "create",
        "--label",
        "dev.contremaitre.managed=true",
        name,
      ]);
    }
  }
  private async delete(ctx: Context, args: string[]) {
    try {
      await this.output(ctx, args, { timeout: 30_000 });
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  removeNetwork(ctx: Context, name: string) {
    return this.delete(ctx, ["network", "rm", name]);
  }
  removeVolume(ctx: Context, name: string) {
    return this.delete(ctx, ["volume", "rm", name]);
  }
  removeImage(ctx: Context, name: string) {
    return this.delete(ctx, ["image", "rm", name]);
  }
  remove(ctx: Context, name: string) {
    return this.delete(ctx, ["rm", "--force", name]);
  }
  async inspect(ctx: Context, name: string): Promise<Inspection | undefined> {
    try {
      const values = Schema.decodeUnknownSync(inspection)(
        JSON.parse(
          (
            await this.output(ctx, ["inspect", "--type", "container", name], { timeout: 10_000 })
          ).toString(),
        ),
      );
      if (values.length !== 1) fail("Expected one Docker container inspection");
      const value = values[0];
      return {
        Running: value.State.Running,
        Host:
          Object.values(value.NetworkSettings.Networks).find((n) => n.IPAddress)?.IPAddress ?? "",
      };
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  async stop(ctx: Context, name: string) {
    if ((await this.inspect(ctx, name))?.Running)
      await this.output(ctx, ["stop", name], { timeout: 30_000 });
  }
  async start(ctx: Context, name: string) {
    await this.output(ctx, ["start", name]);
  }
  exec(ctx: Context, name: string, args: readonly string[], options: RunOptions = {}) {
    return this.output(
      ctx,
      ["exec", ...(options.stdin ? ["--interactive"] : []), name, ...args],
      options,
    );
  }
  async logs(ctx: Context, name: string, follow = true) {
    await this.output(ctx, ["logs", ...(follow ? ["--follow"] : []), name], {
      stdout: ctx.log,
      stderr: ctx.log,
      timeout: 86_400_000,
    });
  }
  async run(ctx: Context, spec: RunSpec) {
    const args = [
      "run",
      "--name",
      spec.name,
      "--network",
      spec.network,
      "--label",
      "dev.contremaitre.managed=true",
      "--cpus",
      String(spec.service.cpus ?? 1),
      "--memory",
      spec.service.memory ?? "512M",
      spec.task ? "--rm" : "--detach",
    ];
    if (spec.envFile) args.push("--env-file", spec.envFile);
    if (spec.stdin) args.push("--interactive");
    if (spec.service.working_dir) args.push("--workdir", spec.service.working_dir);
    for (const source of keys(spec.volumes))
      args.push("--volume", `${source}:${spec.volumes[source]}`);
    args.push(spec.image, ...(spec.service.command ?? []));
    await this.output(
      ctx,
      args,
      spec.task
        ? { stdin: spec.stdin, stdout: ctx.log, stderr: ctx.log, timeout: spec.timeout }
        : {},
    );
  }
  sync(
    ctx: Context,
    spec: RunSpec,
    directory: string,
    changed: string[],
    removed: string[],
    initial: boolean,
  ) {
    return syncSource(this, ctx, spec, directory, changed, removed, initial);
  }
  async build(
    ctx: Context,
    root: string,
    dockerfile: string,
    tag: string,
    previous?: BuildRecord,
  ): Promise<BuildRecord> {
    if (previous) {
      const current = await fingerprintBuildContext(ctx, root, dockerfile);
      if (previous.digest === current.digest) {
        try {
          await this.output(ctx, ["image", "inspect", previous.image]);
          return previous;
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
    }
    const staged = await prepareBuildContext(ctx, root, dockerfile);
    try {
      phase(ctx, `Building Docker image ${tag}`);
      await this.output(ctx, ["build", "--tag", tag, "--file", staged.dockerfile, staged.root], {
        stdout: ctx.log,
        stderr: ctx.log,
        timeout: 7_200_000,
      });
      return { digest: staged.digest, image: tag };
    } finally {
      await staged.cleanup();
    }
  }
}
