import { appendFileSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { isAbsolute, join } from "node:path";
import { type Context, context, decode, fail } from "@contremaitre/execution/context";
import { atomicWrite } from "@contremaitre/execution/files";
import { EnvironmentLocks } from "@contremaitre/execution/locks";
import { run } from "@contremaitre/execution/process";
import { closeServer, type Lookup, listen, proxyServer } from "@contremaitre/routing/proxy";
import { Schema } from "effect";
import type { Manager } from "./manager.js";
import type { Environment, TunnelReservation } from "./model.js";

const configSchema = Schema.Struct({
  default: Schema.String,
  providers: Schema.Record({
    key: Schema.String,
    value: Schema.Struct({ executable: Schema.String, config: Schema.optional(Schema.Unknown) }),
  }),
});
const responseSchema = Schema.Struct({
  version: Schema.Literal(1),
  reservation_id: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  ready: Schema.optional(Schema.Boolean),
  capabilities: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Boolean })),
});
interface Connector {
  controller: AbortController;
  done: Promise<void>;
  server: Server;
}
export class Tunnels {
  private readonly active = new Map<string, Connector>();
  private readonly locks = new EnvironmentLocks();
  private closing = false;
  constructor(
    readonly manager: Manager,
    readonly lookup: Lookup,
  ) {}
  running(id: string, name: string) {
    return this.active.has(`${id}/${name}`);
  }
  private config(provider?: string) {
    const all = decode(
      configSchema,
      JSON.parse(readFileSync(join(this.manager.store.home, "tunnels.json"), "utf8")),
      "tunnel provider configuration",
    );
    const name = provider || all.default,
      cfg = all.providers[name];
    if (!cfg || !isAbsolute(cfg.executable))
      fail(`Tunnel provider ${name} needs an absolute executable path`);
    return { name, ...cfg };
  }
  private async call(
    ctx: Context,
    env: Environment,
    name: string,
    operation: string,
    provider?: string,
  ) {
    const cfg = this.config(provider),
      reservation = env.tunnels?.[name];
    try {
      return decode(
        responseSchema,
        JSON.parse(
          (
            await run(ctx, [cfg.executable, operation], {
              stdin: Buffer.from(
                JSON.stringify({
                  version: 1,
                  config: cfg.config,
                  environment_id: env.Identity.ID,
                  service_id: name,
                  display_name: env.Identity.Name,
                  reservation_id: reservation?.ID,
                }),
              ),
              timeout: 30_000,
              maxOutput: 1048576,
              strictOutput: true,
              stderr: () => {},
            })
          ).toString(),
        ),
        "tunnel provider response",
      );
    } catch {
      fail(`Tunnel provider ${operation} failed`);
    }
  }
  async start(ctx: Context, env: Environment, name: string): Promise<TunnelReservation> {
    return this.locks.use([`${env.Identity.ID}/${name}`], ctx.signal, async () => {
      if (this.closing) fail("Hub is shutting down");
      if (env.Status !== "running") fail("Deploy the environment before sharing it");
      if (!env.Services[name]?.HTTP) fail(`Service ${name} is not HTTP`);
      const key = `${env.Identity.ID}/${name}`;
      env.tunnels ??= {};
      let reservation = env.tunnels[name];
      if (this.active.has(key) && reservation) return reservation;
      const cfg = this.config(reservation?.Provider);
      const caps = await this.call(ctx, env, name, "capabilities", cfg.name);
      if (!caps.capabilities?.stable_urls || !caps.capabilities.https)
        fail("Provider must support stable_urls and https");
      if (!reservation) {
        const reserved = await this.call(ctx, env, name, "reserve", cfg.name);
        let url: URL;
        try {
          url = new URL(reserved.url ?? "");
        } catch {
          return fail("Provider returned invalid reservation");
        }
        if (url.protocol !== "https:" || url.username || url.password || !reserved.reservation_id)
          fail("Provider returned invalid reservation");
        reservation = {
          Provider: cfg.name,
          ID: reserved.reservation_id,
          URL: url.toString(),
          Desired: false,
          Connected: false,
        };
        env.tunnels[name] = reservation;
        this.manager.save();
      }
      const publicHost = new URL(reservation.URL).host;
      const server = proxyServer(this.lookup, () => {
        const route = this.lookup(key);
        return route ? { ...route, publicHost } : undefined;
      });
      const port = await listen(server, 0);
      const controller = new AbortController();
      const log = join(this.manager.store.home, `tunnel-${env.Identity.ID}-${name}.log`);
      atomicWrite(log, "");
      let logged = 0,
        line = Buffer.alloc(0),
        reported = false;
      let readyResolve: () => void = () => {},
        readyReject: (error: Error) => void = () => {};
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      let exited = false;
      const done = run(
        {
          ...context(controller.signal),
          processDirectory: join(this.manager.store.home, "processes"),
        },
        [cfg.executable, "start"],
        {
          stdin: Buffer.from(
            JSON.stringify({
              version: 1,
              config: cfg.config,
              environment_id: env.Identity.ID,
              service_id: name,
              display_name: env.Identity.Name,
              reservation_id: reservation.ID,
              upstream: `http://127.0.0.1:${port}`,
            }),
          ),
          timeout: 2_147_483_647,
          stdout: (chunk) => {
            if (reported) return;
            const end = chunk.indexOf(10);
            const segment = end < 0 ? chunk : chunk.subarray(0, end);
            if (line.length + segment.length > 65536) {
              reported = true;
              readyReject(Error("Provider readiness response exceeded limit"));
              return;
            }
            line = Buffer.concat([line, segment]);
            if (end >= 0) {
              reported = true;
              try {
                const response = decode(
                  responseSchema,
                  JSON.parse(line.toString()),
                  "provider readiness",
                );
                if (!response.ready) fail("Provider did not report ready");
                readyResolve();
              } catch {
                readyReject(Error("Provider did not report ready"));
              }
            }
          },
          stderr: (chunk) => {
            const data = chunk.subarray(0, Math.max(0, 10 * 1048576 - logged));
            if (data.length) {
              appendFileSync(log, data);
              logged += data.length;
            }
          },
        },
      )
        .then(
          () => {
            readyReject(Error("Tunnel connector exited"));
          },
          () => {
            readyReject(Error("Tunnel connector failed"));
          },
        )
        .finally(() => {
          exited = true;
          this.active.delete(key);
          void closeServer(server);
        });
      const timeout = setTimeout(() => readyReject(Error("Provider readiness timed out")), 30_000);
      const abort = () => readyReject(Error("Tunnel start cancelled"));
      ctx.signal.addEventListener("abort", abort, { once: true });
      if (ctx.signal.aborted) abort();
      try {
        await ready;
        if (exited) fail("Tunnel connector exited before readiness completed");
        controller.signal.throwIfAborted();
        this.active.set(key, { controller, done, server });
        reservation.Desired = true;
        reservation.Connected = true;
        this.manager.save();
        return { ...reservation };
      } catch (e) {
        controller.abort();
        await done;
        throw e;
      } finally {
        clearTimeout(timeout);
        ctx.signal.removeEventListener("abort", abort);
      }
    });
  }
  async stop(ctx: Context, env: Environment, name: string, release: boolean) {
    await this.locks.use([`${env.Identity.ID}/${name}`], ctx.signal, async () => {
      const reservation = env.tunnels?.[name];
      if (!reservation) return;
      reservation.Desired = false;
      reservation.Connected = false;
      this.manager.save();
      const active = this.active.get(`${env.Identity.ID}/${name}`);
      if (active) {
        active.controller.abort();
        await active.done;
      }
      await this.call(ctx, env, name, release ? "release" : "stop", reservation.Provider);
      if (release) delete env.tunnels?.[name];
      this.manager.save();
    });
  }
  async restore(ctx: Context) {
    for (const env of Object.values(this.manager.state.Environments))
      if (env.Status === "running")
        for (const [name, t] of Object.entries(env.tunnels ?? {}))
          if (t.Desired && !this.running(env.Identity.ID, name))
            try {
              await this.start(ctx, env, name);
            } catch {
              ctx.log(`[contremaitre] Tunnel ${env.Identity.ID}/${name} could not reconnect\n`);
            }
  }
  async shutdown() {
    this.closing = true;
    for (const c of this.active.values()) c.controller.abort();
    await Promise.all([...this.active.values()].map((c) => c.done));
  }
}
