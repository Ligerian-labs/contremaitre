import { randomUUID } from "node:crypto";
import type { Environment, Request } from "@contremaitre/environments/model";
import { type Context, context, fail } from "@contremaitre/execution/context";
import { sleep } from "@contremaitre/execution/sleep";
import { attempt } from "@contremaitre/hub/application";
import { Effect } from "effect";
import { call } from "./client.js";
import { onboard, terminalOnboarding } from "./saas.js";

export function tunnel(home: string, req: Request, json: boolean, workspace?: string) {
  // Browser approval is interruptible and never owns a hub session or restarts a service.
  return attempt(async (signal) => {
    const ctx = context(signal);
    const health = (await call(ctx, home, "health", {}, 5000)) as {
      foreground_tunnels?: number;
      saas_onboarding?: number;
    };
    if (health.foreground_tunnels !== 1 || health.saas_onboarding !== 1)
      fail("Restart the hub with this CLI to use foreground tunnel sessions");
    const env = (await call(ctx, home, "resolve", req, 15_000)) as Environment;
    if (env.Status !== "running") fail("Deploy the environment before sharing it");
    if (env.driver) fail("Foreground sharing requires native services");
    if (!Object.values(env.Services).some((service) => service.HTTP))
      fail("This environment has no HTTP services to share");
    const providers = Object.values(env.tunnels ?? {}).map((reservation) => reservation.Provider);
    const provider = await onboard(
      home,
      signal,
      { workspace, providers },
      { ui: terminalOnboarding(json) },
    );
    const current = (await call(ctx, home, "resolve", req, 15_000)) as Environment;
    if (current.Identity.ID !== env.Identity.ID)
      fail("Workspace changed during login; run contremaitre tunnel again");
    return { ...req, env: env.Identity.ID, session_id: randomUUID(), provider };
  }).pipe(
    Effect.flatMap((payload) =>
      Effect.acquireUseRelease(
        Effect.succeed(payload),
        (value) => attempt((signal) => runTunnel(context(signal), home, value, json)),
        (value) =>
          attempt(async () => {
            await call(context(AbortSignal.timeout(130_000)), home, "tunnel-stop", value, 130_000);
          }).pipe(Effect.orDie),
      ),
    ),
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
