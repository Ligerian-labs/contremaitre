import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import { type Context, HubError } from "./context.js";
import { trackProcess } from "./process-journal.js";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: Readable | Uint8Array;
  stdout?: (chunk: Buffer) => void;
  stderr?: (chunk: Buffer) => void;
  maxOutput?: number;
  strictOutput?: boolean;
  timeout?: number;
}
export async function run(
  ctx: Context,
  argv: readonly string[],
  options: RunOptions = {},
): Promise<Buffer> {
  ctx.signal.throwIfAborted();
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(options.timeout ?? 300_000)]);
  return new Promise((resolve, reject) => {
    const token = ctx.processDirectory ? randomUUID() : undefined;
    let untrack: () => void = () => {};
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: token
        ? { ...(options.env ?? process.env), CONTREMAITRE_PROCESS_TOKEN: token }
        : options.env,
      detached: true,
      stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (ctx.processDirectory && child.pid && token) {
      try {
        untrack = trackProcess(ctx.processDirectory, child.pid, token);
      } catch (e) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        reject(e);
        return;
      }
    }
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      overflow = false,
      settled = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    let pipeDeadline: ReturnType<typeof setTimeout> | undefined;
    let callbackFailure: Error | undefined;
    const kill = (sig: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, sig);
        } catch {}
    };
    const abort = () => {
      if (force) return;
      kill("SIGTERM");
      force = setTimeout(() => {
        kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
      }, 4000);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      try {
        untrack();
      } catch (e) {
        callbackFailure = e instanceof Error ? e : new Error(String(e));
      }
      signal.removeEventListener("abort", abort);
      if (force) {
        kill("SIGKILL");
        clearTimeout(force);
      }
      if (pipeDeadline) clearTimeout(pipeDeadline);
      if (callbackFailure) reject(callbackFailure);
      else if (error) reject(error);
      else if (signal.aborted)
        reject(
          new HubError({
            message: "Operation cancelled or timed out",
            classification: "transient",
          }),
        );
      else if (overflow)
        reject(
          new HubError({
            message: "Process response exceeds the configured limit",
            classification: "permanent",
          }),
        );
      else resolve(stdout);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (options.stdout) {
        try {
          options.stdout(chunk);
        } catch (e) {
          callbackFailure = e instanceof Error ? e : new Error(String(e));
          abort();
        }
        return;
      }
      const remaining = (options.maxOutput ?? 4 * 1024 * 1024) - stdout.length;
      if (chunk.length > remaining && options.strictOutput) {
        overflow = true;
        abort();
      }
      if (remaining > 0) stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (options.stderr) {
        try {
          options.stderr(chunk);
        } catch (e) {
          callbackFailure = e instanceof Error ? e : new Error(String(e));
          abort();
        }
      } else if (stderr.length < 65536)
        stderr = Buffer.concat([stderr, chunk.subarray(0, 65536 - stderr.length)]);
    });
    child.once("error", (e) => finish(e));
    child.once("exit", () => {
      pipeDeadline = setTimeout(() => {
        kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 5000);
    });
    child.once("close", (code) =>
      finish(
        code === 0 || signal.aborted || overflow
          ? undefined
          : new HubError({
              message: `${basename(argv[0])} ${argv[1] ?? ""}: exit ${code}: ${stderr.toString().trim()}`,
              exitCode: code ?? 1,
              classification: "permanent",
            }),
      ),
    );
    if (options.stdin instanceof Uint8Array) child.stdin?.end(options.stdin);
    else if (options.stdin && child.stdin) {
      options.stdin.pipe(child.stdin);
      options.stdin.once("error", (e) => {
        callbackFailure = e;
        abort();
      });
    }
    child.stdin?.on("error", () => {});
  });
}
