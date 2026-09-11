import {
  type Context,
  context,
  fail,
  HubError,
  keys,
  message,
} from "@contremaitre/execution/context";
import { EnvironmentLocks, Semaphore } from "@contremaitre/execution/locks";
import { sleep } from "@contremaitre/execution/sleep";
import { detectIdentity } from "@contremaitre/projects/config";
import type { Lookup } from "@contremaitre/routing/proxy";
import type { Manager, TunnelHooks } from "./manager.js";
import { type Environment, httpEndpoints } from "./model.js";
import { Tunnels } from "./tunnel.js";

export const tunnelLeaseMs = 15_000;

async function prepareTogether(ctx: Context, tasks: Array<(ctx: Context) => Promise<unknown>>) {
  const controller = new AbortController();
  const scope = { ...ctx, signal: AbortSignal.any([ctx.signal, controller.signal]) };
  const slots = new Semaphore(4);
  await Promise.allSettled(
    tasks.map((task) =>
      slots
        .use(scope.signal, () => task(scope))
        .catch((error) => {
          controller.abort(error);
          throw error;
        }),
    ),
  );
  // Wait for cancellation to finish before the caller restores local configuration.
  scope.signal.throwIfAborted();
}
interface Session {
  id: string;
  env: Environment;
  controller: AbortController;
  expires: number;
  enabled: boolean;
  done: Promise<void>;
}

// Owns a group of connectors. Durable reservations never authorize a new session.
export class TunnelSessions implements TunnelHooks {
  private readonly sessions = new Map<string, Session>();
  private readonly transport: Tunnels;
  private closing = false;
  constructor(
    readonly manager: Manager,
    lookup: Lookup,
    private readonly locks = new EnvironmentLocks(),
  ) {
    this.transport = new Tunnels(manager, lookup);
  }
  sharing(id: string) {
    return this.sessions.has(id);
  }
  running(id: string, name: string) {
    const session = this.sessions.get(id);
    return !!session?.enabled && session.expires > Date.now() && this.transport.running(id, name);
  }
  renew(id: string) {
    const session = [...this.sessions.values()].find((s) => s.id === id);
    if (!session || session.controller.signal.aborted || session.expires <= Date.now())
      fail("Tunnel session ended; start contremaitre tunnel again");
    session.expires = Date.now() + tunnelLeaseMs;
    this.transport.renew(session.env, id, session.expires, session.enabled);
    return { expires_at: session.expires };
  }
  private enable(session: Session, names: string[]) {
    session.controller.signal.throwIfAborted();
    if (session.expires <= Date.now()) fail("Tunnel owner lease expired");
    for (const name of names) {
      const failure = this.transport.failure(session.env.Identity.ID, name);
      if (failure) throw failure;
      if (!this.transport.running(session.env.Identity.ID, name))
        fail("Tunnel connector exited before group activation", "transient");
    }
    session.enabled = true;
    this.transport.renew(session.env, session.id, session.expires, true);
  }
  async open(
    ctx: Context,
    env: Environment,
    id: string,
    provider?: string,
  ): Promise<Record<string, string>> {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail("Tunnel requires a unique foreground session ID");
    if ([...this.sessions.values()].some((session) => session.id === id))
      fail("Tunnel session ID is already in use", "conflict");
    if (this.closing) fail("Hub is shutting down");
    if (this.sharing(env.Identity.ID))
      fail("A tunnel session already owns this environment", "conflict");
    if (env.Status !== "running") fail("Deploy the environment before sharing it");
    if (env.driver)
      fail("Foreground sharing requires native services; drivers cannot apply URL configuration");
    if (env.tunnel_configuration) fail("Tunnel configuration recovery is pending; restart the hub");
    const names = keys(httpEndpoints(env));
    if (!names.length) fail("This environment has no HTTP services to share");
    this.transport.reset(env);
    const session: Session = {
      id,
      env,
      controller: new AbortController(),
      expires: Date.now() + tunnelLeaseMs,
      enabled: false,
      done: Promise.resolve(),
    };
    this.sessions.set(env.Identity.ID, session);
    let resolveReady: (urls: Record<string, string>) => void = () => {};
    let rejectReady: (error: unknown) => void = () => {};
    const ready = new Promise<Record<string, string>>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const cancel = () => session.controller.abort(Error("Tunnel startup cancelled"));
    ctx.signal.addEventListener("abort", cancel, { once: true });
    if (ctx.signal.aborted) cancel();
    const scope = { ...ctx, signal: session.controller.signal };
    // Lease expiry also cancels slow startup, readiness checks and reconnection.
    const watchdog = setInterval(() => {
      if (session.expires <= Date.now())
        session.controller.abort(Error("Tunnel owner lease expired"));
    }, 250);
    session.done = (async () => {
      try {
        const baseline = await detectIdentity(scope, env.Root, env.Identity.Project);
        const urls: Record<string, string> = {};
        await this.locks.use([env.Identity.ID], scope.signal, async () => {
          if (env.Status !== "running") fail("Environment changed before tunnel startup");
          await prepareTogether(
            scope,
            names.map((name) => async (task) => {
              urls[name] = (await this.transport.reserve(task, env, name, provider)).URL;
            }),
          );
          if (new Set(names.map((name) => env.tunnels?.[name].Provider)).size !== 1)
            fail(
              "All services in a foreground session must use the same provider; release or migrate older reservations first",
            );
          await prepareTogether(scope, [
            (task) => this.manager.configureTunnel(task, env, urls),
            ...names.map(
              (name) => (task: Context) =>
                this.transport.start(task, env, name, {
                  id,
                  expires: session.expires,
                  enabled: () => session.enabled && session.expires > Date.now(),
                }),
            ),
          ]);
          if ((await detectIdentity(scope, env.Root, env.Identity.Project)).ID !== baseline.ID)
            fail("Workspace branch changed during tunnel startup");
          this.enable(session, names);
        });
        ctx.signal.removeEventListener("abort", cancel);
        resolveReady(Object.fromEntries(names.map((name) => [name, urls[name]])));
        let retryAt = 0,
          retryDelay = 1000;
        while (true) {
          await sleep(1000, scope.signal);
          if ((await detectIdentity(scope, env.Root, env.Identity.Project)).ID !== baseline.ID)
            fail("Workspace branch changed; tunnel session ended");
          if (env.Status !== "running") fail("Environment is no longer running");
          for (const name of names) {
            const failure = this.transport.failure(env.Identity.ID, name);
            if (failure) throw failure;
          }
          const missing = names.filter((name) => !this.transport.running(env.Identity.ID, name));
          if (!missing.length) continue;
          session.enabled = false;
          this.transport.renew(env, id, session.expires, false);
          if (Date.now() < retryAt) continue;
          try {
            await prepareTogether(
              scope,
              missing.map(
                (name) => (task) =>
                  this.transport.start(task, env, name, {
                    id,
                    expires: session.expires,
                    enabled: () => session.enabled && session.expires > Date.now(),
                  }),
              ),
            );
            this.enable(session, names);
            retryDelay = 1000;
          } catch (error) {
            scope.signal.throwIfAborted();
            if (error instanceof HubError && error.classification === "permanent") throw error;
            ctx.log(`[contremaitre] Tunnel reconnect failed: ${message(error)}\n`);
            retryAt = Date.now() + retryDelay;
            retryDelay = Math.min(10_000, retryDelay * 2);
          }
        }
      } catch (error) {
        rejectReady(error);
        if (!scope.signal.aborted) ctx.log(`[contremaitre] ${message(error)}\n`);
      } finally {
        session.enabled = false;
        session.controller.abort();
        ctx.signal.removeEventListener("abort", cancel);
        clearInterval(watchdog);
        const cleanup = context(AbortSignal.timeout(120_000), ctx.log);
        try {
          await this.locks.use([env.Identity.ID], cleanup.signal, async () => {
            const stopped = await Promise.allSettled(
              names.map((name) => this.transport.stop(cleanup, env, name, false)),
            );
            for (const result of stopped)
              if (result.status === "rejected")
                ctx.log(
                  `[contremaitre] Remote tunnel stop failed; lease will expire: ${message(result.reason)}\n`,
                );
            if (env.tunnel_configuration) await this.manager.configureTunnel(cleanup, env, {});
          });
        } catch (error) {
          env.Status = "failed";
          env.Error = `Tunnel cleanup failed: ${message(error)}; restart the hub to retry configuration recovery`;
          this.manager.save();
          ctx.log(`[contremaitre] ${env.Error}\n`);
        } finally {
          this.sessions.delete(env.Identity.ID);
        }
      }
    })();
    try {
      return await ready;
    } catch (error) {
      await session.done;
      throw error;
    }
  }
  async end(env: Environment, id?: string) {
    const session = this.sessions.get(env.Identity.ID);
    if (!session || (id && session.id !== id)) return;
    session.enabled = false;
    session.controller.abort();
    await session.done;
    if (env.tunnel_configuration) fail(env.Error || "Tunnel configuration recovery is pending");
  }
  async stop(ctx: Context, env: Environment, name: string, release: boolean) {
    if (this.sharing(env.Identity.ID))
      fail("Stop the whole tunnel session before changing a reservation", "conflict");
    await this.transport.stop(ctx, env, name, release);
  }
  async shutdown() {
    this.closing = true;
    for (const session of this.sessions.values()) {
      session.enabled = false;
      session.controller.abort();
    }
    await Promise.all([...this.sessions.values()].map((s) => s.done));
    await this.transport.shutdown();
  }
}
