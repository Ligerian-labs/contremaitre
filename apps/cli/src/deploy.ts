import { stripVTControlCharacters } from "node:util";
import type { Environment, Request } from "@contremaitre/environments/model";
import { context, decode, fail } from "@contremaitre/execution/context";
import { attempt } from "@contremaitre/hub/application";
import { type Operation, operationSchema, terminal } from "@contremaitre/operations/operations";
import { Effect, Exit } from "effect";
import { call, followDeployment, launch } from "./client.js";

const clean = (text: string) => stripVTControlCharacters(text).replace(/\p{Cc}/gu, " ");
export function deploymentRows(op: Operation, frame = 0, width = 120): string[] {
  return Object.entries(op.services ?? {}).map(([name, value]) => {
    const icon = {
      ready: "✅",
      failed: "❌",
      blocked: "⏸",
      cancelled: "⏹",
      waiting: "⏳",
      running: frame % 2 ? "⌛" : "⏳",
    }[value.status];
    const text = `${icon} ${clean(name).padEnd(12)} ${clean(value.detail)}${value.url ? `  ${clean(value.url)}` : ""}`;
    // Preserve usable URLs in final output, even when a terminal soft-wraps the row.
    if ((terminal(op) && value.url) || Bun.stringWidth(text) <= width) return text;
    let clipped = "";
    for (const char of text) {
      if (Bun.stringWidth(clipped + char) >= width) break;
      clipped += char;
    }
    return `${clipped}…`;
  });
}

class DeploymentDisplay {
  private rows = 0;
  private frame = 0;
  private readonly interactive = !!process.stdout.isTTY && process.env.TERM !== "dumb";
  constructor(
    private readonly json: boolean,
    op: Operation,
  ) {
    if (!json) {
      process.stdout.write(`Deploying ${clean(op.name ?? op.environmentId)}\n`);
      if (this.interactive) process.stdout.write("\x1b[?25l");
    }
  }
  update(op: Operation) {
    if (this.json || (!this.interactive && !terminal(op))) return;
    if (this.rows && this.interactive) process.stdout.write(`\x1b[${this.rows}A\r\x1b[J`);
    const rows = deploymentRows(
      op,
      this.frame++,
      this.interactive ? Math.max(8, (process.stdout.columns || 80) - 1) : 10000,
    );
    if (rows.length) process.stdout.write(`${rows.join("\n")}\n`);
    this.rows = this.interactive
      ? rows.reduce(
          (count, row) =>
            count + Math.max(1, Math.ceil(Bun.stringWidth(row) / (process.stdout.columns || 80))),
          0,
        )
      : rows.length;
  }
  close() {
    if (!this.json && this.interactive) process.stdout.write("\x1b[?25h");
  }
}

export function deploy(
  home: string,
  req: Request,
  options: {
    port: number;
    publicPort: number;
    detach: boolean;
    json: boolean;
    http?: boolean;
    httpsPort?: number;
  },
) {
  let display: DeploymentDisplay | undefined;
  // Acquisition is uninterruptible: an accepted operation always has an ID for cancellation.
  return attempt(async (signal) => {
    if (
      options.port < 1 ||
      options.port > 65535 ||
      options.publicPort < 0 ||
      options.publicPort > 65535
    )
      fail("Invalid HTTP port");
    const ctx = context(signal);
    await launch(
      ctx,
      home,
      options.port,
      options.publicPort,
      options.http ? undefined : (options.httpsPort ?? 8443),
    );
    const health = (await call(ctx, home, "health")) as {
      deployment_progress?: number;
      development?: number;
    };
    if (health.deployment_progress !== 1 || health.development !== 1)
      fail(
        "The running hub needs an update; restart it with this Contremaitre binary before deploying",
      );
  }).pipe(
    Effect.flatMap(() =>
      Effect.acquireUseRelease(
        attempt(async (signal) =>
          decode(
            operationSchema,
            await call(context(signal), home, "deploy-async", req),
            "deployment operation",
          ),
        ),
        (op) =>
          attempt(async (signal) => {
            if (options.detach) {
              process.stdout.write(
                `${options.json ? JSON.stringify({ version: 1, data: op }) : `Deployment ${op.id} started`}\n`,
              );
              return;
            }
            display = new DeploymentDisplay(options.json, op);
            const result = await followDeployment(context(signal), home, op, (op) =>
              display?.update(op),
            );
            if (result.status !== "succeeded")
              fail(`Deployment ${result.status}. Details: contremaitre deploy logs --failure`);
            if (options.json) {
              const env = (await call(context(signal), home, "resolve", {
                env: op.environmentId,
              })) as Environment;
              process.stdout.write(`${JSON.stringify({ version: 1, data: env })}\n`);
            }
          }),
        (op, exit) =>
          Effect.gen(function* () {
            if (!options.detach && Exit.isInterrupted(exit)) {
              yield* attempt(async () => {
                const cancelled = decode(
                  operationSchema,
                  await call(context(AbortSignal.timeout(300_000)), home, "cancel", { id: op.id }),
                  "cancelled deployment",
                );
                display?.update(cancelled);
              }).pipe(
                Effect.catchAll((error) =>
                  Effect.sync(() =>
                    process.stderr.write(`Could not confirm cancellation: ${error.message}\n`),
                  ),
                ),
              );
            }
            display?.close();
          }),
      ),
    ),
  );
}
