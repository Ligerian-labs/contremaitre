import type { Inspection, RunSpec, Runtime } from "@contremaitre/environments/apple";
import type { BuildRecord } from "@contremaitre/environments/model";
import type { Context } from "@contremaitre/execution/context";
import type { RunOptions } from "@contremaitre/execution/process";
import { sleep } from "@contremaitre/execution/sleep";
export class FakeRuntime implements Runtime {
  async sync(
    _ctx: Context,
    spec: RunSpec,
    _directory: string,
    changed: string[],
    removed: string[],
    initial: boolean,
  ) {
    this.calls.push(
      `sync ${spec.name} ${initial ? "initial" : "live"} ${changed.join(",")} -${removed.join(",")}`,
    );
  }
  containers = new Map<string, Inspection>();
  calls: string[] = [];
  failBuild = false;
  failTask = false;
  buildDelay = 0;
  async startSystem() {}
  async build(
    ctx: Context,
    _root: string,
    _dockerfile: string,
    tag: string,
    previous?: BuildRecord,
  ) {
    this.calls.push("build");
    if (this.buildDelay) await sleep(this.buildDelay, ctx.signal);
    if (this.failBuild) throw Error("build failed");
    return previous ?? { digest: "digest", image: tag };
  }
  async network(_ctx: Context, name: string) {
    this.calls.push(`network ${name}`);
  }
  async removeNetwork(_ctx: Context, name: string) {
    this.calls.push(`remove network ${name}`);
  }
  async volume(_ctx: Context, name: string) {
    this.calls.push(`volume ${name}`);
  }
  async removeVolume(_ctx: Context, name: string) {
    this.calls.push(`remove volume ${name}`);
  }
  async removeImage(_ctx: Context, name: string) {
    this.calls.push(`remove image ${name}`);
  }
  async run(_ctx: Context, s: RunSpec) {
    this.calls.push(`run ${s.name}`);
    if (s.task) {
      if (this.failTask) throw Error("task failed");
      return;
    }
    this.containers.set(s.name, { IP: "127.0.0.1", Running: true });
  }
  async inspect(_ctx: Context, name: string) {
    return this.containers.get(name);
  }
  async stop(_ctx: Context, name: string) {
    this.calls.push(`stop ${name}`);
    const value = this.containers.get(name);
    if (value) value.Running = false;
  }
  async start(_ctx: Context, name: string) {
    this.calls.push(`start ${name}`);
    this.containers.set(name, { IP: "127.0.0.1", Running: true });
  }
  async remove(_ctx: Context, name: string) {
    this.calls.push(`remove ${name}`);
    this.containers.delete(name);
  }
  async exec(_ctx: Context, _name: string, _args: readonly string[], opts: RunOptions = {}) {
    if (opts.stdin && !(opts.stdin instanceof Uint8Array))
      for await (const _ of opts.stdin) {
      }
    opts.stdout?.(Buffer.from("dump"));
    return Buffer.from("ok");
  }
  async logs(ctx: Context) {
    await sleep(100_000, ctx.signal);
  }
}
