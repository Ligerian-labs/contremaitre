import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { type Context, decode, fail } from "@contremaitre/execution/context";
import { sleep } from "@contremaitre/execution/sleep";
import { type Operation, operationSchema, terminal } from "@contremaitre/operations/operations";
import { Schema } from "effect";

const replySchema = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
export async function call(
  ctx: Context,
  home: string,
  action: string,
  payload: unknown = {},
  timeout = 300_000,
): Promise<unknown> {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeout)]);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: join(home, "hub.sock"),
        agent: false,
        path: `/v1/${action}`,
        method: action === "health" ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        signal,
      },
      (res) => {
        let bytes = Buffer.alloc(0);
        res.on("data", (chunk) => {
          if (bytes.length + chunk.length > 32 * 1048576) {
            req.destroy(Error("Hub response too large"));
            return;
          }
          bytes = Buffer.concat([bytes, chunk]);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const reply = decode(replySchema, JSON.parse(bytes.toString()), "hub response");
            if (reply.error) fail(reply.error);
            if (res.statusCode !== 200) fail("Hub unavailable; run contremaitre start");
            resolve(reply.data);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(action === "health" ? undefined : JSON.stringify(payload));
  });
}
export async function health(ctx: Context, home: string): Promise<boolean> {
  try {
    await call(ctx, home, "health", {}, 1000);
    return true;
  } catch {
    return false;
  }
}
export async function launch(ctx: Context, home: string, port: number, publicPort?: number) {
  if (await health(ctx, home)) return;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const logPath = join(home, "daemon.log");
  if (existsSync(logPath) && statSync(logPath).size > 10 * 1048576)
    renameSync(logPath, `${logPath}.1`);
  const fd = openSync(logPath, "a", 0o600);
  const development = !Bun.main.startsWith("/$bunfs/");
  const args = [
    ...(development ? [Bun.main] : []),
    "serve",
    "--home",
    home,
    "--http-port",
    String(port),
    ...(publicPort ? ["--public-port", String(publicPort)] : []),
  ];
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  let exited = false;
  let error: Error | undefined;
  child.once("exit", () => {
    exited = true;
  });
  child.once("error", (e) => {
    error = e;
    exited = true;
  });
  child.unref();
  const deadline = Date.now() + 180_000;
  try {
    while (Date.now() < deadline) {
      if (await health(ctx, home)) return;
      if (exited) fail(`Hub failed to start${error ? `: ${error.message}` : ""}; see ${logPath}`);
      await sleep(250, ctx.signal);
    }
    fail(`Hub startup timed out; see ${logPath}`);
  } catch (e) {
    if (child.pid && !exited)
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {}
    throw e;
  }
}
const progressSchema = Schema.Struct({
  operation: operationSchema,
  offset: Schema.Int,
  output: Schema.String,
});
export async function attach(
  ctx: Context,
  home: string,
  id: string,
  offset = 0,
): Promise<Operation> {
  const started = Date.now();
  let lastOutput = started;
  while (true) {
    const chunk = decode(
      progressSchema,
      await call(ctx, home, "operation", { id, offset }),
      "operation progress",
    );
    offset = chunk.offset;
    if (chunk.output) {
      ctx.log(Buffer.from(chunk.output, "base64"));
      lastOutput = Date.now();
    } else if (!terminal(chunk.operation) && Date.now() - lastOutput >= 5000) {
      ctx.log(
        `[contremaitre] Operation ${chunk.operation.status} (${Math.floor((Date.now() - started) / 1000)}s attached)\n`,
      );
      lastOutput = Date.now();
    }
    if (terminal(chunk.operation) && !chunk.output) {
      if (chunk.operation.status !== "succeeded")
        fail(`${chunk.operation.status}: ${chunk.operation.error ?? id}`);
      return chunk.operation;
    }
    if (!chunk.output) await sleep(200, ctx.signal);
  }
}
export function projectRoot(dir = process.cwd()): string {
  for (let path = resolve(dir); ; path = dirname(path)) {
    if ([".contremaitre.yaml", ".contremaitre.yml"].some((f) => existsSync(join(path, f))))
      return path;
    if (dirname(path) === path) return resolve(dir);
  }
}
