import type { Manager } from "@contremaitre/environments/manager";
import {
  type Environment,
  httpEndpoints,
  type Request,
  requestSchema,
} from "@contremaitre/environments/model";
import {
  type Context,
  context,
  fail,
  HubError,
  keys,
  message,
} from "@contremaitre/execution/context";
import { type Operations, operationSchema } from "@contremaitre/operations/operations";
import type { AgentWorkflow } from "@contremaitre/verification/workflow";
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
export const Show = Query.define("ShowEnvironmentURLs", {
  payload: requestSchema,
  success: Schema.Record({ key: Schema.String, value: Schema.String }),
  failure: Schema.instanceOf(HubError),
});
export const ListOperations = Query.define("ListOperations", {
  payload: Schema.Struct({}),
  success: Schema.Array(operationSchema),
});
export const ReadOperation = Query.define("ReadOperation", {
  payload: Schema.Struct({
    id: Schema.String,
    offset: Schema.optional(Schema.Int),
    failure: Schema.optional(Schema.Boolean),
    end: Schema.optional(Schema.Int),
    summary: Schema.optional(Schema.Boolean),
  }),
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
export const RenewShare = Command.define("RenewSharingSession", {
  payload: requestSchema,
  success: Schema.Unknown,
  failure: Schema.instanceOf(HubError),
});
export const StopShare = Command.define("StopSharingService", {
  payload: requestSchema,
  success: Schema.Unknown,
  failure: Schema.instanceOf(HubError),
});
export const Ensure = Command.define("EnsureEnvironment", {
  payload: requestSchema,
  success: Schema.Unknown,
  failure: Schema.instanceOf(HubError),
});
export const Verify = Command.define("VerifyEnvironment", {
  payload: Schema.Struct({ ...requestSchema.fields, profile: Schema.optional(Schema.String) }),
  success: Schema.Unknown,
  failure: Schema.instanceOf(HubError),
});
export const Report = Query.define("EnvironmentReport", {
  payload: requestSchema,
  success: Schema.Unknown,
  failure: Schema.instanceOf(HubError),
});
export const Diagnose = Query.define("DiagnoseVerification", {
  payload: Schema.Struct({
    id: Schema.String,
    offset: Schema.optional(Schema.Int),
    check: Schema.optional(Schema.String),
  }),
  success: Schema.Unknown,
  failure: Schema.instanceOf(HubError),
});
export class Hub extends EffectContext.Tag("contremaitre/Hub")<
  Hub,
  {
    manager: Manager;
    agents: AgentWorkflow;
    operations: Operations;
    share: (ctx: Context, e: Environment, id: string, provider?: string) => Promise<unknown>;
    renewShare?: (id: string) => unknown;
    endShare?: (e: Environment, id?: string) => Promise<void>;
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
  CommandHandler.make(Ensure, (req) =>
    Effect.gen(function* () {
      const { agents } = yield* Hub;
      return yield* attempt((signal) => agents.ensure(context(signal), req));
    }),
  ),
  CommandHandler.make(Verify, (req) =>
    Effect.gen(function* () {
      const { agents } = yield* Hub;
      return yield* attempt((signal) => agents.verify(context(signal), req, req.profile));
    }),
  ),
  QueryHandler.make(Report, (req) =>
    Effect.gen(function* () {
      const { agents } = yield* Hub;
      return yield* attempt((signal) => agents.report(context(signal), req));
    }),
  ),
  QueryHandler.make(Diagnose, (req) =>
    Effect.gen(function* () {
      const { agents } = yield* Hub;
      return yield* attempt(async () => agents.diagnose(req.id, req.offset, req.check));
    }),
  ),
  CommandHandler.make(Deploy, (req) =>
    Effect.gen(function* () {
      const { manager: m, operations: ops } = yield* Hub;
      return yield* attempt(async (signal) => {
        const prepared = await m.prepare(
          context(signal, (data) => process.stderr.write(data)),
          req,
        );
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
          {
            name: `${prepared.identity.Project} / ${prepared.identity.Branch}`,
            services: prepared.manifest.driver
              ? ["driver"]
              : keys(prepared.manifest.services).sort(
                  (a, b) =>
                    Number(prepared.manifest.services[a].kind === "app") -
                    Number(prepared.manifest.services[b].kind === "app"),
                ),
          },
        );
      });
    }),
  ),
  CommandHandler.make(Down, (req) =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      const { manager: m, operations: ops } = hub;
      return yield* attempt(async (signal) => {
        const env = await resolveRequest(m, context(signal), req);
        await hub.endShare?.(env);
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
  QueryHandler.make(Show, (req) =>
    Effect.gen(function* () {
      const { manager: m } = yield* Hub;
      return yield* attempt(async (signal) => {
        const env = await resolveRequest(m, context(signal), req);
        return Object.fromEntries(
          keys(httpEndpoints(env)).map((name) => [name, m.localURL(env, name)]),
        );
      });
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
      return yield* attempt(async () => ops.read(req.id, req.offset, 65536, req));
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
        if (!req.session_id || req.service)
          fail("Tunnel requires a foreground session for all HTTP services");
        return hub.share(ctx, env, req.session_id, req.provider);
      });
    }),
  ),
  CommandHandler.make(RenewShare, (req) =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      return yield* attempt(async () => {
        if (!req.session_id || !hub.renewShare) fail("Missing tunnel session");
        return hub.renewShare(req.session_id);
      });
    }),
  ),
  CommandHandler.make(StopShare, (req) =>
    Effect.gen(function* () {
      const hub = yield* Hub;
      const { manager: m, operations: ops } = hub;
      return yield* attempt(async (signal) => {
        const ctx = context(signal),
          env = await resolveRequest(m, ctx, req);
        await hub.endShare?.(env, req.session_id);
        if (req.session_id) return "Tunnel stopped";
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
