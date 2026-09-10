import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  type Context,
  context,
  decode,
  fail,
  HubError,
  hash,
} from "@contremaitre/execution/context";
import { atomicWrite } from "@contremaitre/execution/files";
import { EnvironmentLocks } from "@contremaitre/execution/locks";
import { run } from "@contremaitre/execution/process";
import { closeServer, type Lookup, listen, proxyServer } from "@contremaitre/routing/proxy";
import { Schema } from "effect";
import type { Manager } from "./manager.js";
import type { Environment, TunnelReservation } from "./model.js";
import { providerConfig } from "./tunnel-provider.js";

const readinessSchema = Schema.Struct({ version: Schema.Literal(2), ready: Schema.Boolean });
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
  input: PassThrough;
  ready: boolean;
}
export class Tunnels {
  private readonly failures = new Map<string, HubError>();
  failure(id: string, name: string) {
    return this.failures.get(`${id}/${name}`);
  }
  reset(env: Environment) {
    for (const name of Object.keys(env.Services))
      this.failures.delete(`${env.Identity.ID}/${name}`);
  }
  private readonly active = new Map<string, Connector>();
  private readonly locks = new EnvironmentLocks();
  private closing = false;
  private readonly machine: string;
  constructor(
    readonly manager: Manager,
    readonly lookup: Lookup,
  ) {
    const path = join(manager.store.home, "tunnel-machine-id");
    if (!existsSync(path)) atomicWrite(path, randomUUID());
    this.machine = readFileSync(path, "utf8").trim();
    if (!/^[a-f0-9-]{36}$/.test(this.machine)) fail("Invalid tunnel machine identity");
  }
  private identity(env: Environment) {
    return {
      environment_id: hash(`${this.machine}\0${env.Identity.ID}`).slice(0, 32),
      machine_id: this.machine,
      project: env.Identity.Project,
      branch: env.Identity.Branch,
      workspace_id: hash(env.Identity.Workspace).slice(0, 32),
    };
  }
  running(id: string, name: string) {
    return this.active.get(`${id}/${name}`)?.ready ?? false;
  }
  private config(provider?: string) {
    return (
      providerConfig(this.manager.store.home, provider) ??
      fail("Run contremaitre tunnel to set up the SaaS provider first")
    );
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
                  ...this.identity(env),
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
    } catch (error) {
      const permanent =
        error instanceof HubError &&
        ([77, 78].includes(error.exitCode ?? 0) ||
          (!error.exitCode && error.classification === "permanent"));
      fail(`Tunnel provider ${operation} failed`, permanent ? "permanent" : "transient");
    }
  }
  async reserve(
    ctx: Context,
    env: Environment,
    name: string,
    provider?: string,
  ): Promise<TunnelReservation> {
    return this.locks.use([`${env.Identity.ID}/${name}`], ctx.signal, async () => {
      if (this.closing) fail("Hub is shutting down");
      if (!env.Services[name]?.HTTP) fail(`Service ${name} is not HTTP`);
      env.tunnels ??= {};
      let reservation = env.tunnels[name];
      if (reservation && provider && reservation.Provider !== provider)
        fail("Tunnel reservation belongs to another provider; release it before switching");
      const cfg = this.config(reservation?.Provider ?? provider);
      const caps = await this.call(ctx, env, name, "capabilities", cfg.name);
      if (
        !caps.capabilities?.stable_urls ||
        !caps.capabilities.https ||
        !caps.capabilities.foreground_sessions
      )
        fail(
          "Provider must support stable_urls, https and foreground_sessions; upgrade the tunnel adapter",
        );
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
      return reservation;
    });
  }
  async start(
    ctx: Context,
    env: Environment,
    name: string,
    lease: { id: string; expires: number; enabled: () => boolean },
  ): Promise<TunnelReservation> {
    const reservation = await this.reserve(ctx, env, name);
    return this.locks.use([`${env.Identity.ID}/${name}`], ctx.signal, async () => {
      if (this.closing) fail("Hub is shutting down");
      const key = `${env.Identity.ID}/${name}`;
      if (this.active.has(key)) fail("Connector already running");
      const cfg = this.config(reservation.Provider);
      const publicHost = new URL(reservation.URL).host;
      const localHost = new URL(this.manager.localURL(env, name)).host;
      const server = proxyServer(this.lookup, () => {
        const route = this.lookup(key);
        return route
          ? { ...route, upstream: lease.enabled() ? route.upstream : "", publicHost, localHost }
          : undefined;
      });
      const port = await listen(server, 0);
      const controller = new AbortController();
      const input = new PassThrough();
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
          stdin: input,
          /* initial request is written below, followed by lease renewals */
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
                  readinessSchema,
                  JSON.parse(line.toString()),
                  "provider readiness",
                );
                if (!response.ready) fail("Provider did not report ready");
                readyResolve();
              } catch {
                readyReject(
                  new HubError({
                    message: "Provider did not report ready",
                    classification: "permanent",
                  }),
                );
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
          () => readyReject(Error("Tunnel connector exited")),
          (error) => {
            const permanent = error instanceof HubError && [77, 78].includes(error.exitCode ?? 0);
            const failure = new HubError({
              message: permanent
                ? "Tunnel provider refused authorization or configuration"
                : "Tunnel connector failed",
              classification: permanent ? "permanent" : "transient",
            });
            if (permanent) this.failures.set(key, failure);
            readyReject(failure);
          },
        )
        .finally(() => {
          exited = true;
          input.destroy();
          this.active.delete(key);
          return closeServer(server);
        });
      const connector: Connector = { controller, done, server, input, ready: false };
      this.active.set(key, connector);
      input.write(
        `${JSON.stringify({
          version: 2,
          config: cfg.config,
          ...this.identity(env),
          service_id: name,
          display_name: env.Identity.Name,
          reservation_id: reservation.ID,
          upstream: `http://127.0.0.1:${port}`,
          session_id: lease.id,
          service_ids: Object.keys(env.Services)
            .filter((n) => env.Services[n].HTTP)
            .sort(),
          expires_at: lease.expires,
          enabled: false,
        })}\n`,
      );
      const timeout = setTimeout(() => readyReject(Error("Provider readiness timed out")), 30_000);
      const abort = () => readyReject(Error("Tunnel start cancelled"));
      ctx.signal.addEventListener("abort", abort, { once: true });
      if (ctx.signal.aborted) abort();
      try {
        await ready;
        if (exited) fail("Tunnel connector exited before readiness completed");
        controller.signal.throwIfAborted();
        connector.ready = true;
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
        await closeServer(active.server);
        active.controller.abort();
        await active.done;
      }
      await this.call(ctx, env, name, release ? "release" : "stop", reservation.Provider);
      if (release) delete env.tunnels?.[name];
      this.manager.save();
    });
  }
  renew(env: Environment, id: string, expires: number, enabled: boolean) {
    for (const name of Object.keys(env.tunnels ?? {})) {
      const connector = this.active.get(`${env.Identity.ID}/${name}`);
      if (!connector) continue;
      if (
        !connector.input.write(
          `${JSON.stringify({ version: 2, operation: "renew", session_id: id, expires_at: expires, enabled })}\n`,
        )
      )
        connector.controller.abort();
    }
  }
  async shutdown() {
    this.closing = true;
    for (const c of this.active.values()) c.controller.abort();
    await Promise.all([...this.active.values()].map((c) => c.done));
  }
}
