import type { Manager } from "@contremaitre/environments/manager";
import { defaultIdleTimeoutSeconds, type Environment } from "@contremaitre/environments/model";
import { context, message } from "@contremaitre/execution/context";
import type { Operations } from "@contremaitre/operations/operations";

/** The hub owns this timer and joins in-flight shutdown before releasing its state lock. */
export class IdleShutdown {
  private readonly connections = new Map<string, number>();
  private readonly retries = new Set<string>();
  private readonly controller = new AbortController();
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  constructor(
    readonly manager: Manager,
    readonly operations: Operations,
    readonly now: () => number = Date.now,
    readonly log: (record: Record<string, unknown>) => void = (record) =>
      process.stderr.write(
        `${JSON.stringify({ ts: new Date(now()).toISOString(), level: record.error ? "ERROR" : "INFO", ...record })}\n`,
      ),
    readonly sweepIntervalMs = 60_000,
  ) {
    manager.onUse = (env) => this.touch(env.Identity.ID);
    // A recovered daemon cannot know activity while it was down. Grant a full window.
    for (const env of Object.values(manager.state.Environments)) this.touch(env.Identity.ID);
  }
  touch(id: string) {
    if (this.controller.signal.aborted) return;
    const env = this.manager.state.Environments[id];
    if (!env) return;
    env.last_activity_at = new Date(this.now()).toISOString();
    this.dirty = true;
  }
  begin(id: string): () => void {
    this.touch(id);
    this.connections.set(id, (this.connections.get(id) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const remaining = (this.connections.get(id) ?? 1) - 1;
      if (remaining) this.connections.set(id, remaining);
      else this.connections.delete(id);
      this.touch(id);
    };
  }
  private protected(env: Environment): boolean {
    return (
      this.operations.busy(env.Identity.ID) ||
      !!this.connections.get(env.Identity.ID) ||
      !!this.manager.tunnels?.sharing?.(env.Identity.ID)
    );
  }
  private expired(env: Environment): boolean {
    const seconds = env.idle_timeout_seconds ?? defaultIdleTimeoutSeconds;
    return (
      seconds > 0 &&
      (["running", "failed"].includes(env.Status) || this.retries.has(env.Identity.ID)) &&
      this.now() - Date.parse(env.last_activity_at ?? "") >= seconds * 1000
    );
  }
  sweep(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    this.active ??= this.run().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
  private async run() {
    for (const env of Object.values(this.manager.state.Environments)) {
      if (this.controller.signal.aborted) break;
      if (this.protected(env)) {
        this.touch(env.Identity.ID);
        continue;
      }
      if (!this.expired(env)) continue;
      const ctx = context(AbortSignal.any([this.controller.signal, AbortSignal.timeout(180_000)]));
      try {
        await this.operations.locks.use([env.Identity.ID], ctx.signal, async () => {
          if (
            this.manager.state.Environments[env.Identity.ID] !== env ||
            this.protected(env) ||
            !this.expired(env)
          )
            return;
          this.log({
            event: "contremaitre.environment.idle_stop",
            environment_id: env.Identity.ID,
            idle_timeout_seconds: env.idle_timeout_seconds ?? defaultIdleTimeoutSeconds,
          });
          await this.manager.down(ctx, env, false);
          this.retries.delete(env.Identity.ID);
        });
      } catch (error) {
        if (!this.controller.signal.aborted) {
          this.retries.add(env.Identity.ID);
          this.log({
            event: "contremaitre.environment.idle_stop_failed",
            environment_id: env.Identity.ID,
            error: message(error),
          });
        }
      }
    }
    for (const id of this.retries)
      if (!this.manager.state.Environments[id]) this.retries.delete(id);
    if (this.dirty && !this.controller.signal.aborted) {
      this.manager.save();
      this.dirty = false;
    }
  }
  start() {
    const schedule = () => {
      if (this.controller.signal.aborted) return;
      this.timer = setTimeout(() => {
        void this.sweep()
          .catch((error) => {
            this.log({ event: "contremaitre.idle_sweep_failed", error: message(error) });
          })
          .finally(schedule);
      }, this.sweepIntervalMs);
      this.timer.unref();
    };
    schedule();
  }
  async close() {
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.active;
    this.manager.onUse = () => {};
  }
}
