import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Apple, type Runtime } from "@contremaitre/environments/apple";
import { Manager } from "@contremaitre/environments/manager";
import { requestSchema } from "@contremaitre/environments/model";
import { Store } from "@contremaitre/environments/store";
import { Tunnels } from "@contremaitre/environments/tunnel";
import { context, decode, fail, keys, message } from "@contremaitre/execution/context";
import { lockHome } from "@contremaitre/execution/files";
import { reapProcesses } from "@contremaitre/execution/process-journal";
import { sleep } from "@contremaitre/execution/sleep";
import { type Operation, Operations, terminal } from "@contremaitre/operations/operations";
import { closeServer, listen, proxyServer, type Route } from "@contremaitre/routing/proxy";
import { load, Settings } from "@structure-ai/config";
import { Readiness, Shutdown } from "@structure-ai/runtime";
import { Duration, Effect, Layer } from "effect";
import {
  application,
  attempt,
  Cancel,
  CommandBus,
  Deploy,
  DesignateMain,
  Down,
  List,
  ListOperations,
  Prune,
  QueryBus,
  ReadOperation,
  Resolve,
  Share,
  StopShare,
} from "./application.js";
export interface ServerOptions {
  home: string;
  port: number;
  publicPort?: number;
  concurrency?: number;
  runtime?: Runtime;
  skipSystemStart?: boolean;
}
export function routes(m: Manager, host: string): Route | undefined {
  for (const env of Object.values(m.state.Environments)) {
    let first = true;
    for (const name of keys(env.Services)) {
      const s = env.Services[name];
      if (!s.HTTP) continue;
      const route: Route = {
        upstream:
          ["running", "deploying", "failed"].includes(env.Status) &&
          (s.ready ?? env.Status === "running") &&
          s.IP
            ? `http://${s.IP.includes(":") ? `[${s.IP}]` : s.IP}:${s.Port}`
            : "",
      };
      const hosts = [`${env.Identity.ID}/${name}`, new URL(m.localURL(env, name)).hostname];
      if (first && m.state.Main[env.Identity.Project] === env.Identity.ID)
        hosts.push(`main.${env.Identity.Project}.localhost`);
      first = false;
      if (hosts.includes(host)) return route;
    }
  }
}
const settings = Settings.struct({
  concurrency: Settings.int("CONTREMAITRE_CONCURRENCY", {
    default: 2,
    description: "Simultaneous environment operations, 1..16",
  }),
});
async function body(req: IncomingMessage): Promise<unknown> {
  let data = Buffer.alloc(0);
  for await (const chunk of req) {
    data = Buffer.concat([data, Buffer.from(chunk)]);
    if (data.length > 65536) fail("Request exceeds 64 KiB");
  }
  return data.length ? JSON.parse(data.toString()) : {};
}
function json(res: ServerResponse, data?: unknown, error?: string) {
  if (res.destroyed) return;
  res.writeHead(error ? 400 : 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ version: 1, data, error }));
}
async function write(res: ServerResponse, event: unknown, signal: AbortSignal) {
  if (res.destroyed || signal.aborted) return;
  const ok = res.write(`${JSON.stringify(event)}\n`);
  if (!ok)
    await new Promise<void>((resolve) => {
      const done = () => {
        res.off("drain", done);
        res.off("close", done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      res.once("drain", done);
      res.once("close", done);
      signal.addEventListener("abort", done, { once: true });
    });
}
export async function startServer(
  options: ServerOptions,
  signal: AbortSignal = new AbortController().signal,
) {
  const store = new Store(options.home),
    unlock = lockHome(store.home);
  let control: Server | undefined, publicServer: Server | undefined;
  let ops: Operations | undefined, tunnels: Tunnels | undefined;
  let closeApp: (() => Promise<void>) | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let monitoring: ReturnType<typeof setInterval> | undefined;
  let ready = false;
  const requests = new Set<AbortController>();
  const close = () =>
    (shutdownPromise ??= (async () => {
      ready = false;
      if (monitoring) clearInterval(monitoring);
      for (const request of requests) request.abort();
      await ops?.shutdown();
      await tunnels?.shutdown();
      if (control) await closeServer(control);
      if (publicServer) await closeServer(publicServer);
      await closeApp?.();
      if (existsSync(join(store.home, "hub.sock"))) unlinkSync(join(store.home, "hub.sock"));
      unlock();
    })());
  try {
    await reapProcesses(context(signal), join(store.home, "processes"));
    const runtime = options.runtime ?? new Apple();
    if (!options.skipSystemStart)
      await runtime.startSystem(context(signal, (chunk) => process.stderr.write(chunk)));
    const manager = new Manager(store, runtime, options.publicPort || options.port);
    ops = new Operations(store.home, options.concurrency ?? 2);
    const operations = ops;
    await manager.recover({
      ...context(signal, (chunk) => process.stderr.write(chunk)),
      processDirectory: join(store.home, "processes"),
    });
    const lookup = (host: string) => routes(manager, host);
    tunnels = new Tunnels(manager, lookup);
    manager.tunnels = tunnels;
    const sharing = tunnels;
    const app = application({
      manager,
      operations,
      share: (ctx, e, name) => sharing.start(ctx, e, name),
    });
    closeApp = () => app.dispose();
    operations.onTransition = (op) => {
      app.runFork(
        Effect.logInfo(`contremaitre.operation.${op.status}`).pipe(
          Effect.annotateLogs({
            operationId: op.id,
            environmentId: op.environmentId,
            kind: op.kind,
          }),
        ),
      );
    };
    const command = <A, E>(effect: Effect.Effect<A, E, CommandBus | QueryBus>) =>
      app.runPromise(effect);
    const wait = async (op: Operation) => {
      const result = await operations.wait(op.id);
      if (result.status !== "succeeded") fail(result.error ?? `Operation ${result.status}`);
      return manager.state.Environments[result.environmentId]
        ? manager.view(manager.state.Environments[result.environmentId])
        : undefined;
    };
    control = createServer((req, res) => {
      const controller = new AbortController();
      requests.add(controller);
      res.once("close", () => {
        controller.abort();
        requests.delete(controller);
      });
      void (async () => {
        if (req.url === "/v1/health" && req.method === "GET") {
          if (!ready) {
            res.writeHead(503);
            res.end();
            return;
          }
          json(res, {
            public_port: manager.httpPort,
            version: "0.2.0",
            operations: true,
            deployment_progress: 1,
          });
          return;
        }
        if (!ready) fail("Hub is not accepting requests", "transient");
        if (req.method !== "POST") fail("Use POST for control requests");
        const action = req.url?.replace(/^\/v1\//, "");
        const value = await body(req);
        if (action === "operations") {
          json(res, await command(Effect.flatMap(QueryBus, (b) => b.dispatch(ListOperations, {}))));
          return;
        }
        if (action === "operation") {
          const data = await command(
            Effect.flatMap(QueryBus, (b) =>
              b.dispatch(ReadOperation, decode(ReadOperation.payload, value, "operation query")),
            ),
          );
          json(res, data);
          return;
        }
        if (action === "cancel") {
          json(
            res,
            await command(
              Effect.flatMap(CommandBus, (b) =>
                b.dispatch(Cancel, decode(Cancel.payload, value, "cancel request")),
              ),
            ),
          );
          return;
        }
        const payload = decode(requestSchema, value, "request");
        if (action === "deployment") {
          const id = payload.env
            ? manager.resolve(payload.env).Identity.ID
            : (
                await manager.current(
                  context(controller.signal),
                  payload.root ?? process.cwd(),
                  payload.branch,
                )
              ).ID;
          json(res, operations.latestDeployment(id));
          return;
        }
        switch (action) {
          case "deploy":
          case "deploy-async": {
            const op = await command(
              Effect.flatMap(CommandBus, (b) => b.dispatch(Deploy, payload)),
            );
            if (action === "deploy-async") {
              json(res, op);
              return;
            }
            if (req.headers.accept?.includes("application/x-ndjson")) {
              res.writeHead(200, {
                "Content-Type": "application/x-ndjson",
                "Cache-Control": "no-store",
              });
              await write(
                res,
                {
                  version: 1,
                  type: "log",
                  message: `[contremaitre] Operation ${op.id}; reconnect with contremaitre attach ${op.id}\n`,
                },
                controller.signal,
              );
              let offset = 0;
              while (!controller.signal.aborted) {
                const chunk = operations.read(op.id, offset);
                offset = chunk.offset;
                if (chunk.output)
                  await write(
                    res,
                    { version: 1, type: "log", output: chunk.output },
                    controller.signal,
                  );
                if (terminal(chunk.operation) && !chunk.output) {
                  const final = chunk.operation;
                  await write(
                    res,
                    {
                      version: 1,
                      type: "result",
                      data:
                        final.status === "succeeded"
                          ? manager.view(manager.resolve(final.environmentId))
                          : undefined,
                      error:
                        final.status === "succeeded" ? undefined : (final.error ?? final.status),
                    },
                    controller.signal,
                  );
                  res.end();
                  return;
                }
                if (!chunk.output) await sleep(200, controller.signal);
              }
              return;
            }
            json(res, await wait(op));
            return;
          }
          case "list":
            json(res, await command(Effect.flatMap(QueryBus, (b) => b.dispatch(List, {}))));
            return;
          case "resolve":
            json(res, await command(Effect.flatMap(QueryBus, (b) => b.dispatch(Resolve, payload))));
            return;
          case "down":
            await wait(await command(Effect.flatMap(CommandBus, (b) => b.dispatch(Down, payload))));
            json(res);
            return;
          case "main":
            await wait(
              await command(Effect.flatMap(CommandBus, (b) => b.dispatch(DesignateMain, payload))),
            );
            json(res);
            return;
          case "prune": {
            const jobs = await command(
              Effect.flatMap(CommandBus, (b) => b.dispatch(Prune, payload)),
            );
            await Promise.all(jobs.map(wait));
            json(res, "Prune complete");
            return;
          }
          case "tunnel":
            json(res, await command(Effect.flatMap(CommandBus, (b) => b.dispatch(Share, payload))));
            return;
          case "tunnel-stop":
          case "tunnel-release":
            json(
              res,
              await command(
                Effect.flatMap(CommandBus, (b) =>
                  b.dispatch(StopShare, { ...payload, delete_data: action === "tunnel-release" }),
                ),
              ),
            );
            return;
          case "stop": {
            ready = false;
            await operations.shutdown();
            for (const env of Object.values(manager.state.Environments))
              await manager.down(context(AbortSignal.timeout(180_000)), env, false);
            json(res);
            setTimeout(() => void close(), 20);
            return;
          }
          default:
            fail("Unknown control operation");
        }
      })().catch((error) => {
        if (!res.headersSent) json(res, undefined, message(error));
        else if (!res.destroyed) {
          res.end(`${JSON.stringify({ version: 1, type: "result", error: message(error) })}\n`);
        }
      });
    });
    control.requestTimeout = 30_000;
    control.headersTimeout = 10_000;
    const socket = join(store.home, "hub.sock");
    if (existsSync(socket)) unlinkSync(socket);
    await new Promise<void>((resolve, reject) => {
      control?.once("error", reject);
      control?.listen(socket, () => resolve());
    });
    chmodSync(socket, 0o600);
    publicServer = proxyServer(lookup);
    await listen(publicServer, options.port);
    ready = true;
    let restoring = false;
    const restore = async () => {
      if (restoring || !ready) return;
      restoring = true;
      try {
        await sharing.restore(
          context(AbortSignal.timeout(30_000), (chunk) => process.stderr.write(chunk)),
        );
      } finally {
        restoring = false;
      }
    };
    monitoring = setInterval(() => void restore(), 15_000);
    void restore();
    return {
      manager,
      operations,
      close,
      get closed() {
        return !!shutdownPromise;
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
export const serve = (options: ServerOptions) =>
  Effect.gen(function* () {
    const readiness = yield* Readiness,
      shutdown = yield* Shutdown;
    const config = yield* load(settings);
    const concurrency = options.concurrency ?? config.concurrency;
    if (concurrency < 1 || concurrency > 16)
      return yield* Effect.fail(new Error("CONTREMAITRE_CONCURRENCY must be 1..16"));
    const hub = yield* attempt((signal) => startServer({ ...options, concurrency }, signal));
    yield* shutdown.onShutdown(
      "hub",
      Effect.promise(() => hub.close()),
    );
    yield* readiness.setReady;
    yield* Effect.logInfo("contremaitre.hub.ready").pipe(
      Effect.annotateLogs({ home: options.home, port: options.port, concurrency }),
    );
    return yield* Effect.race(
      shutdown.awaitShutdown,
      Effect.gen(function* () {
        while (!hub.closed) yield* Effect.sleep("200 millis");
        yield* shutdown.trigger("stop");
        return "stop";
      }),
    ).pipe(
      Effect.onInterrupt(() => shutdown.trigger("signal")),
      Effect.ensuring(Effect.promise(() => hub.close())),
    );
  }).pipe(
    Effect.provide(
      Shutdown.layer({ finalizerTimeout: Duration.seconds(150) }).pipe(
        Layer.provideMerge(Readiness.layer),
      ),
    ),
  );
