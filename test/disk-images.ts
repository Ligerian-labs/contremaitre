import { type Context, context, HubError, phase } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";
import { sleep } from "@contremaitre/execution/sleep";

/** Detach only the temporary image owned by the calling test before deleting its directory. */
export async function detachDiskImage(
  mount: string,
  ctx: Context = context(AbortSignal.timeout(20_000), (data) => process.stdout.write(data)),
  execute: typeof run = run,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    ctx.signal.throwIfAborted();
    try {
      await execute(ctx, ["hdiutil", "detach", "-force", mount]);
      return;
    } catch (error) {
      ctx.signal.throwIfAborted();
      if (!(error instanceof HubError) || error.exitCode !== 16 || attempt >= 9) throw error;
      phase(ctx, `Disk image is busy; retrying detach of ${mount}`);
      await sleep(Math.min(attempt + 1, 4) * 250, ctx.signal);
    }
  }
}
