import { randomUUID } from "node:crypto";
import type { Environment, Request } from "@contremaitre/environments/model";
import { type Context, context, fail } from "@contremaitre/execution/context";
import { sleep } from "@contremaitre/execution/sleep";
import { attempt } from "@contremaitre/hub/application";
import { Effect } from "effect";
import { call } from "./client.js";

export function tunnel(home: string, req: Request, json: boolean) {
  return Effect.acquireUseRelease(
    attempt(async (signal) => {
      const ctx = context(signal);
      const health = (await call(ctx, home, "health", {}, 5000)) as { foreground_tunnels?: number };
      if (health.foreground_tunnels !== 1)
        fail("Restart the hub with this CLI to use foreground tunnel sessions");
      const env = (await call(ctx, home, "resolve", req, 15_000)) as Environment;
      return { ...req, env: env.Identity.ID, session_id: randomUUID() };
    }),
    (payload) => attempt((signal) => runTunnel(context(signal), home, payload, json)),
    (payload) =>
      attempt(async () => {
        await call(context(AbortSignal.timeout(130_000)), home, "tunnel-stop", payload, 130_000);
      }).pipe(Effect.orDie),
  );
}
async function runTunnel(ctx: Context, home: string, payload: Request, json: boolean) {
  const controller = new AbortController();
  const scope = { ...ctx, signal: AbortSignal.any([ctx.signal, controller.signal]) };
  let started = false;
  if (!json) process.stderr.write("Preparing live preview; services may restart.\n");
  // Renew during slow preparation as well as after readiness. Never retry start.
  const renewing = (async () => {
    while (true) {
      await sleep(3000, scope.signal);
      try {
        await call(scope, home, "tunnel-renew", payload, 5000);
      } catch (error) {
        if (started) throw error;
        // The first start request may still be waiting for the hub to accept it.
      }
    }
  })();
  void renewing.catch(() => controller.abort());
  const onHangup = () => controller.abort();
  process.on("SIGHUP", onHangup);
  try {
    const urls = (await call(scope, home, "tunnel", payload, 600_000)) as Record<string, string>;
    started = true;
    if (json) process.stdout.write(`${JSON.stringify({ version: 1, data: urls })}\n`);
    else {
      for (const [name, url] of Object.entries(urls)) process.stdout.write(`${name}\t${url}\n`);
      process.stderr.write("Sharing live. Press Ctrl-C to stop.\n");
    }
    await renewing;
  } finally {
    controller.abort();
    process.off("SIGHUP", onHangup);
    await renewing.catch(() => {});
  }
}
