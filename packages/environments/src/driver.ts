import { appendFileSync, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { type Context, decode, fail, hash, keys, phase } from "@contremaitre/execution/context";
import { atomicWrite, privateFile, removeFile } from "@contremaitre/execution/files";
import { type RunOptions, run } from "@contremaitre/execution/process";
import { safePath, validName } from "@contremaitre/projects/config";
import type { Driver } from "@contremaitre/projects/model";
import { Schema } from "effect";
import type { Environment } from "./model.js";

const replySchema = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.String,
  services: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Struct({
        host: Schema.optional(Schema.String),
        port: Schema.optional(Schema.Int),
        http: Schema.optional(Schema.Boolean),
        url: Schema.optional(Schema.String),
      }),
    }),
  ),
});
export type DriverReply = Schema.Schema.Type<typeof replySchema>;
export const driverContext = (e: Environment) => ({
  id: e.Identity.ID,
  project: e.Identity.Project,
  root: e.Root,
  state_directory: e.driver_directory,
  resource_prefix: e.Network,
  host: e.Identity.Host,
});
export function snapshotDriver(home: string, env: Environment, driver: Driver): void {
  const source = safePath(env.Root, driver.executable),
    info = statSync(source);
  if (!info.isFile() || !(info.mode & 0o111))
    fail("Project driver must be an executable regular file");
  const bytes = readFileSync(source);
  env.driver_directory = join(home, "drivers", env.Identity.ID);
  const executable = join(env.driver_directory, `driver-${hash(bytes).slice(0, 16)}`);
  atomicWrite(executable, bytes, 0o700);
  env.driver = { ...driver, executable };
}
export async function driverProcess(
  ctx: Context,
  env: Environment,
  operation: string,
  source?: Environment,
  service?: string,
  args?: readonly string[],
  options: RunOptions = {},
): Promise<Buffer> {
  if (!env.driver || !env.driver_directory) fail("Project driver is not configured");
  const path = privateFile(
    env.driver_directory,
    JSON.stringify({
      version: 1,
      operation,
      environment: driverContext(env),
      source: source ? driverContext(source) : undefined,
      service,
      arguments: args,
    }),
    "request",
  );
  try {
    return await run(ctx, [env.driver.executable], {
      cwd: env.driver_directory,
      env: { ...process.env, CONTREMAITRE_REQUEST: path },
      timeout: (env.driver.timeout_seconds ?? 1800) * 1000,
      ...options,
    });
  } finally {
    removeFile(path);
  }
}
export async function invokeDriver(
  ctx: Context,
  env: Environment,
  operation: string,
  source?: Environment,
): Promise<DriverReply> {
  phase(ctx, `Driver ${env.Identity.Name}: ${operation}`);
  const log = join(env.driver_directory ?? "", "driver.log");
  let size = 0;
  try {
    size = statSync(log).size;
  } catch {}
  const output = await driverProcess(ctx, env, operation, source, undefined, undefined, {
    maxOutput: 1048576,
    strictOutput: true,
    stderr: (data) => {
      ctx.log(data);
      const chunk = data.subarray(0, Math.max(0, 10 * 1048576 - size));
      if (chunk.length) {
        appendFileSync(log, chunk, { mode: 0o600 });
        size += chunk.length;
      }
    },
  });
  let value: unknown;
  try {
    value = JSON.parse(output.toString());
  } catch {
    fail("Project driver must return one version 1 JSON response");
  }
  return decode(replySchema, value, "project driver response");
}
export function applyDriverReply(env: Environment, reply: DriverReply): void {
  if (!["running", "stopped"].includes(reply.status))
    fail("Driver status must be running or stopped");
  if (reply.status === "running" && !keys(reply.services).length)
    fail("Running driver returned no services");
  const services: Environment["Services"] = {};
  for (const [name, s] of Object.entries(reply.services ?? {})) {
    if (!validName.test(name) || (s.port ?? 0) < 0 || (s.port ?? 0) > 65535)
      fail("Driver returned invalid service name or port");
    if (s.host && (!isIP(s.host) || !(s.host === "::1" || s.host.startsWith("127."))))
      fail(`Driver service ${name} must use a loopback upstream`);
    if (s.http && (!s.host || !s.port)) fail(`HTTP driver service ${name} needs an upstream`);
    if (s.url) {
      let url: URL;
      try {
        url = new URL(s.url);
      } catch {
        fail("Invalid driver URL");
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        !(url.hostname === env.Identity.Host || url.hostname.endsWith(`.${env.Identity.Host}`))
      )
        fail(`Driver service ${name} URL must use its environment hostname`);
    }
    services[name] = {
      Name: name,
      Container: "",
      Image: "",
      Volume: "",
      Initialized: true,
      IP: s.host ?? "",
      Port: s.port ?? 0,
      HTTP: s.http ?? false,
      url: s.url,
      Spec: { kind: "app" },
    };
  }
  if (reply.status === "running") env.Services = services;
  else for (const s of Object.values(env.Services)) s.IP = "";
  env.Status = reply.status;
}
