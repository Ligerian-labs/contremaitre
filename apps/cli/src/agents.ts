import type { Request } from "@contremaitre/environments/model";
import { type Context, decode, fail, HubError } from "@contremaitre/execution/context";
import { sleep } from "@contremaitre/execution/sleep";
import { type Operation, operationSchema, terminal } from "@contremaitre/operations/operations";
import { call, launch } from "./client.js";

export class AgentResultError extends HubError {
  constructor() {
    super({ message: "Agent operation did not pass", classification: "permanent", exitCode: 1 });
  }
}
export async function waitOperation(ctx: Context, home: string, id: string, seconds = 1800) {
  if (seconds < 1 || seconds > 7200) fail("--timeout must be 1..7200 seconds");
  const deadline = Date.now() + seconds * 1000;
  while (true) {
    const value = (await call(ctx, home, "operation", { id, summary: true })) as {
      operation: unknown;
    };
    const operation = decode(operationSchema, value.operation, "operation summary");
    if (terminal(operation)) return operation;
    if (Date.now() >= deadline)
      fail(`Wait timed out; operation continues. Resume with contremaitre wait ${id}`);
    await sleep(250, ctx.signal);
  }
}
export async function agentCommand(
  ctx: Context,
  home: string,
  action: string,
  req: Request,
  options: {
    profile: string;
    run: string;
    check: string;
    offset: number;
    timeout: number;
    http: boolean;
    port: number;
    publicPort: number;
    httpsPort: number;
    detach: boolean;
  },
  args: readonly string[],
) {
  if (
    ["ensure", "verify", "wait"].includes(action) &&
    (options.timeout < 1 || options.timeout > 7200)
  )
    fail("--timeout must be 1..7200 seconds");
  if (action === "diagnose") {
    if (!options.run) fail("diagnose requires --run ID");
    return {
      data: await call(ctx, home, "diagnose", {
        id: options.run,
        offset: options.offset,
        ...(options.check ? { check: options.check } : {}),
      }),
      failed: false,
    };
  }
  if (action === "report" || action === "status")
    return { data: await call(ctx, home, "report", req), failed: false };
  if (action === "wait") {
    if (args.length !== 1) fail("wait requires an operation ID");
    const op = await waitOperation(ctx, home, args[0], options.timeout);
    return {
      data: { operation_id: op.id, status: op.status, error: op.error?.slice(0, 500) },
      failed: op.status !== "succeeded",
    };
  }
  if (action === "ensure")
    await launch(
      ctx,
      home,
      options.port,
      options.publicPort,
      options.http ? undefined : options.httpsPort,
    );
  const capabilities = (await call(ctx, home, "health")) as {
    agent_workflow?: number;
    compact_config?: number;
  };
  if (capabilities.agent_workflow !== 1 || capabilities.compact_config !== 1)
    fail("Restart the hub with this Contremaitre binary to use agent workflows");
  const accepted = (await call(ctx, home, action, {
    ...req,
    ...(action === "verify" ? { profile: options.profile } : {}),
  })) as Operation | { status: "not-configured" };
  if (accepted.status === "not-configured") return { data: accepted, failed: true };
  const op = decode(operationSchema, accepted, "agent operation");
  if (options.detach) return { data: { operation_id: op.id, status: op.status }, failed: false };
  const result = await waitOperation(ctx, home, op.id, options.timeout);
  try {
    return {
      data: await call(ctx, home, "agent-result", { id: op.id }),
      failed: result.status !== "succeeded",
    };
  } catch {
    ctx.signal.throwIfAborted();
    return {
      data: {
        operation_id: op.id,
        status: result.status,
        error: result.error?.slice(0, 500),
        next: `contremaitre diagnose --run ${op.id}`,
      },
      failed: true,
    };
  }
}
