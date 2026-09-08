import type { Manager } from "@contremaitre/environments/manager";
import { type Environment, type Request, requestSchema } from "@contremaitre/environments/model";
import {
  type Context,
  context,
  fail,
  HubError,
  keys,
  message,
} from "@contremaitre/execution/context";
import { type Operations, operationSchema } from "@contremaitre/operations/operations";
import {
  Command,
  CommandBus,
  CommandHandler,
  layer as cqrsLayer,
  HandlerRegistry,
  Query,
  QueryBus,
  QueryHandler,
} from "@structure-ai/cqrs";
import { layer as observabilityLayer } from "@structure-ai/observability";
import { Effect, Context as EffectContext, Layer, ManagedRuntime, Schema } from "effect";
export const Deploy = Command.define("DeployEnvironment", {
  payload: requestSchema,
  success: operationSchema,
  failure: Schema.instanceOf(HubError),
});
export const Down = Command.define("StopEnvironment", {
  payload: requestSchema,
  success: operationSchema,
  failure: Schema.instanceOf(HubError),
});
export const DesignateMain = Command.define("DesignateMain", {
  payload: requestSchema,
  success: operationSchema,
  failure: Schema.instanceOf(HubError),
});
export const Prune = Command.define("PruneResources", {
  payload: requestSchema,
  success: Schema.Array(operationSchema),
  failure: Schema.instanceOf(HubError),
});
export const List = Query.define("ListEnvironments", {
  payload: Schema.Struct({}),
  success: Schema.Unknown,
});
export const Resolve = Query.define("ResolveEnvironment", {
  payload: requestSchema,
  success: Schema.Unknown,
  failure: Schema.instanceOf(HubError),
});
export const ListOperations = Query.define("ListOperations", {
  payload: Schema.Struct({}),
  success: Schema.Array(operationSchema),
});
export const ReadOperation = Query.define("ReadOperation", {
  payload: Schema.Struct({ id: Schema.String, offset: Schema.optional(Schema.Int) }),
  success: Schema.Unknown,
  failure: Schema.instanceOf(HubError),
});
export const Cancel = Command.define("CancelOperation", {
  payload: Schema.Struct({ id: Schema.String }),
  success: operationSchema,
  failure: Schema.instanceOf(HubError),
});
export const Share = Command.define("ShareService", {
  payload: requestSchema,
  success: Schema.Unknown,
  failure: Schema.instanceOf(HubError),
});
export const StopShare = Command.define("StopSharingService", {
  payload: requestSchema,
  success: Schema.Unknown,
  failure: Schema.instanceOf(HubError),
});
export class Hub extends EffectContext.Tag("contremaitre/Hub")<
  Hub,
  {
    manager: Manager;
    operations: Operations;
    share: (ctx: Context, e: Environment, name: string) => Promise<unknown>;
  }
>() {}
export const attempt = <A>(work: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (e) =>
      e instanceof HubError
        ? e
        : new HubError({ message: message(e), classification: "permanent" }),
  });
async function resolveRequest(m: Manager, ctx: Context, req: Request) {
  return m.resolve(req.env || (await m.current(ctx, req.root ?? process.cwd(), req.branch)).ID);
}
const registry = HandlerRegistry.layer(
  CommandHandler.make(Deploy, (req) =>
    Effect.gen(function* () {
      const { manager: m, operations: ops } = yield* Hub;
      return yield* attempt(async (signal) => {
        const prepared = await m.prepare(context(signal), req);
        const id = prepared.identity.ID,
          source = prepared.sourceId;
        return ops.submit(
          id,
          "deploy",
          [
            id,
            ...(source && source !== id && !m.state.Environments[id]?.CloneComplete
              ? [source]
              : []),
          ],
          (ctx) => m.deploy(ctx, prepared),
        );
      });
    }),
  ),
  CommandHandler.make(Down, (req) =>
    Effect.gen(function* () {
      const { manager: m, operations: ops } = yield* Hub;
      return yield* attempt(async (signal) => {
        const env = await resolveRequest(m, context(signal), req);
        return ops.submit(env.Identity.ID, "down", [env.Identity.ID], (ctx) =>
          m.down(ctx, env, req.delete_data),
        );
      });
    }),
  ),
  CommandHandler.make(DesignateMain, (req) =>
    Effect.gen(function* () {
      const { manager: m, operations: ops } = yield* Hub;
      return yield* attempt(async (signal) => {
        const env = await resolveRequest(m, context(signal), req);
        return ops.submit(env.Identity.ID, "main", [env.Identity.ID], async () => m.setMain(env));
      });
    }),
  ),
  CommandHandler.make(Prune, (req) =>
    Effect.gen(function* () {
      const { manager: m, operations: ops } = yield* Hub;
      return yield* attempt(async () =>
        Object.values(m.state.Environments)
          .filter((e) => !ops.current(e.Identity.ID))
          .map((env) =>
            ops.submit(env.Identity.ID, "prune", [env.Identity.ID], async (ctx) => {
              await m.pruneImages(ctx, env);
              if (req.delete_data && env.Status === "stopped" && !keys(env.tunnels).length)
                await m.down(ctx, env, true);
            }),
          ),
      );
    }),
  ),
  QueryHandler.make(List, () =>
    Effect.gen(function* () {
      return (yield* Hub).manager.list();
    }),
  ),
  QueryHandler.make(Resolve, (req) =>
    Effect.gen(function* () {
      const { manager: m } = yield* Hub;
      return yield* attempt(async (signal) =>
        m.view(await resolveRequest(m, context(signal), req)),
      );
    }),
  ),
  QueryHandler.make(ListOperations, () =>
    Effect.gen(function* () {
      return (yield* Hub).operations.list();
    }),
  ),
  QueryHandler.make(ReadOperation, (req) =>
    Effect.gen(function* () {
      const { operations: ops } = yield* Hub;
      return yield* attempt(async () => ops.read(req.id, req.offset));
    }),
  ),
  CommandHandler.make(Cancel, (req) =>
    Effect.gen(function* () {
      const { operations: ops } = yield* Hub;
      return yield* attempt(() => ops.cancel(req.id));
    }),
  ),
  CommandHandler.make(Share, (req) =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      return yield* attempt(async (signal) => {
        const ctx = context(signal),
          env = await resolveRequest(hub.manager, ctx, req);
        if (!req.service) fail("Tunnel requires a service");
        return hub.operations.locks.use([env.Identity.ID], signal, () =>
          hub.share(ctx, env, req.service ?? ""),
        );
      });
    }),
  ),
  CommandHandler.make(StopShare, (req) =>
    Effect.gen(function* () {
      const { manager: m, operations: ops } = yield* Hub;
      return yield* attempt(async (signal) => {
        const ctx = context(signal),
          env = await resolveRequest(m, ctx, req);
        return ops.locks.use([env.Identity.ID], signal, async () => {
          for (const name of req.service ? [req.service] : keys(env.tunnels))
            await m.tunnels?.stop(ctx, env, name, !!req.delete_data);
          return "Tunnel stopped";
        });
      });
    }),
  ),
);
export function application(hub: EffectContext.Tag.Service<Hub>) {
  return ManagedRuntime.make(
    cqrsLayer.pipe(
      Layer.provideMerge(registry),
      Layer.provideMerge(Layer.succeed(Hub, hub)),
      Layer.provideMerge(
        observabilityLayer({ service: { name: "contremaitre", version: "0.2.0" } }),
      ),
    ),
  );
}
export { CommandBus, QueryBus };
