import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type Context, decode, fail, keys, own } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";
import { Schema } from "effect";
import { parseAllDocuments } from "yaml";
import {
  driverSchema,
  type Identity,
  type Manifest,
  newIdentity,
  type Service,
  serviceSchema,
} from "./model.js";
export const validName = /^[a-z][a-z0-9-]{0,39}$/;
export const envKey = /^[A-Za-z_][A-Za-z0-9_]*$/;
const manifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  project: Schema.String,
  services: Schema.optional(Schema.Record({ key: Schema.String, value: serviceSchema })),
  driver: Schema.optional(driverSchema),
});
export const inside = (root: string, path: string): boolean => {
  const r = relative(root, path);
  return r !== ".." && !r.startsWith("../") && !isAbsolute(r);
};
export function safePath(root: string, path: string): string {
  if (isAbsolute(path)) return fail(`Path must be relative to project: ${path}`);
  const base = realpathSync(root),
    target = realpathSync(resolve(base, path || "."));
  if (!inside(base, target)) return fail(`Path escapes project: ${path}`);
  return target;
}
export function order(services: Record<string, Service>): string[] {
  const result: string[] = [],
    seen = new Map<string, number>();
  const visit = (name: string) => {
    if (seen.get(name) === 2) return;
    if (seen.get(name) === 1) fail(`Dependency cycle involving ${name}`);
    if (!own(services, name)) fail(`Unknown dependency ${name}`);
    seen.set(name, 1);
    for (const dep of services[name].depends_on ?? []) visit(dep);
    seen.set(name, 2);
    result.push(name);
  };
  const names = keys(services).sort(
    (a, b) =>
      Number(services[a].kind === "app") - Number(services[b].kind === "app") ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const name of names) visit(name);
  return result;
}
export function parseManifest(text: string): Manifest {
  const docs = parseAllDocuments(text);
  if (docs.length !== 1 || docs[0].errors.length)
    fail("Manifest must contain one valid YAML document");
  const parsed = decode(
    manifestSchema,
    docs[0].toJSON(),
    "manifest; check version, field names and value types",
  );
  if (!validName.test(parsed.project))
    fail("Project must be a lowercase DNS label, at most 40 characters");
  const services: Record<string, Service> = Object.create(null);
  if (parsed.driver) {
    const d = parsed.driver;
    const timeout = d.timeout_seconds || 1800;
    if (
      !d.executable ||
      isAbsolute(d.executable) ||
      !inside("/project", resolve("/project", d.executable))
    )
      fail("Driver executable must be a file inside the project");
    if (timeout < 1 || timeout > 7200) fail("Driver timeout_seconds must be 1..7200");
    if (keys(parsed.services).length) fail("Driver and services are mutually exclusive");
    return {
      version: 1,
      project: parsed.project,
      services,
      driver: { ...d, timeout_seconds: timeout },
    };
  }
  for (const [name, original] of Object.entries(parsed.services ?? {})) {
    if (!validName.test(name)) fail(`Invalid service name ${name}`);
    const kind = original.kind || "app";
    if (!["app", "postgres", "redis"].includes(kind)) fail(`${name}: unknown kind`);
    const s: Service = {
      ...original,
      kind,
      image:
        original.image ||
        (kind === "postgres" ? "postgres:17" : kind === "redis" ? "redis:7-alpine" : ""),
      port: original.port || (kind === "postgres" ? 5432 : kind === "redis" ? 6379 : 0),
      cpus: original.cpus || 1,
      memory: original.memory || (original.dev ? "2G" : "512M"),
    };
    if (Boolean(s.image) === Boolean(s.build))
      fail(`${name}: specify exactly one of image or build`);
    if (
      kind !== "app" &&
      (s.build ||
        keys(s.volumes).length ||
        s.init?.length ||
        s.migrate?.length ||
        s.env_file ||
        s.working_dir ||
        keys(s.environment).length ||
        s.command?.length)
    )
      fail(
        `${name}: managed databases cannot override storage, credentials, command or initialization`,
      );
    const containerPath = (p: string) =>
      p.startsWith("/") && !/[,:\r\n]/.test(p) && resolve(p) === p && p !== "/";
    if (s.working_dir && !containerPath(s.working_dir)) fail(`${name}: invalid working_dir`);
    if (s.dev) {
      const target = s.dev.target;
      if (kind !== "app") fail(`${name}: dev is only supported for apps`);
      if (
        !s.dev.source ||
        isAbsolute(s.dev.source) ||
        !inside("/project", resolve("/project", s.dev.source))
      )
        fail(`${name}: dev.source must stay within project`);
      if (!containerPath(s.dev.target)) fail(`${name}: invalid dev.target`);
      if (!s.command?.length) fail(`${name}: dev requires an explicit command`);
      if (!s.working_dir || !inside(s.dev.target, s.working_dir))
        fail(`${name}: working_dir must be inside dev.target`);
      if (Object.values(s.volumes ?? {}).some((p) => inside(p, target) || inside(target, p)))
        fail(`${name}: persistent volumes cannot overlap dev.target`);
    }
    if ((s.port ?? 0) < 0 || (s.port ?? 0) > 65535) fail(`${name}: invalid port`);
    if (s.http && (kind !== "app" || !s.port)) fail(`${name}: http requires an app port`);
    if ((s.cpus ?? 0) < 1 || (s.cpus ?? 0) > 64) fail(`${name}: cpus must be 1..64`);
    if (!/^[1-9][0-9]*[MG]$/.test(s.memory ?? "")) fail(`${name}: invalid memory`);
    for (const [volume, target] of Object.entries(s.volumes ?? {}))
      if (
        !validName.test(volume) ||
        !target.startsWith("/") ||
        /[:,\n]/.test(target) ||
        resolve(target) === "/"
      )
        fail(`${name}: invalid persistent volume`);
    for (const [key, value] of Object.entries(s.environment ?? {}))
      if (!envKey.test(key) || /[\r\n]/.test(value)) fail(`${name}: invalid environment entry`);
    for (const p of [
      s.build,
      s.dockerfile,
      ...(typeof s.env_file === "string" ? [s.env_file] : (s.env_file ?? [])),
    ])
      if (p && (isAbsolute(p) || !inside("/project", resolve("/project", p))))
        fail(`${name}: paths must stay within project`);
    services[name] = s;
  }
  if (!keys(services).length) fail("At least one service is required");
  order(services);
  return { version: 1, project: parsed.project, services };
}
export function loadManifest(root: string): Manifest {
  for (const file of [".contremaitre.yaml", ".contremaitre.yml"]) {
    const p = join(root, file);
    if (existsSync(p)) return parseManifest(readFileSync(p, "utf8"));
  }
  return fail(`No .contremaitre.yaml in ${root}; run contremaitre init`);
}
export function readEnv(root: string, file: string | readonly string[]): Record<string, string> {
  if (typeof file !== "string")
    return Object.assign(Object.create(null), ...file.map((p) => readEnv(root, p)));
  const values: Record<string, string> = Object.create(null);
  for (const line of readFileSync(safePath(root, file), "utf8").split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq < 0) fail(`Invalid env_file line in ${file}`);
    const key = text.slice(0, eq).trim(),
      value = text.slice(eq + 1).replace(/^["']+|["']+$/g, "");
    if (!envKey.test(key) || /[\r\n]/.test(value)) fail("Invalid environment entry");
    values[key] = value;
  }
  return values;
}
export function prepareManifest(root: string, manifest: Manifest): Manifest {
  const services: Record<string, Service> = Object.create(null);
  for (const [name, s] of Object.entries(manifest.services))
    services[name] = {
      ...s,
      env_file: "",
      environment: { ...(s.env_file ? readEnv(root, s.env_file) : {}), ...s.environment },
    };
  const token = /\{\{([^{}]+)\}\}/g;
  for (const [name, s] of Object.entries(services))
    for (const value of Object.values(s.environment ?? {})) {
      for (const match of value.matchAll(token)) {
        if (["contremaitre.url", "contremaitre.local_url"].includes(match[1])) continue;
        const [dep, property, ...rest] = match[1].split(".");
        if (
          rest.length ||
          !["host", "port", "url", "local_url"].includes(property) ||
          !own(services, dep)
        )
          fail(`${name}: unsupported or unknown environment reference ${match[1]}`);
        if (property === "local_url") {
          if (!services[dep].http) fail(`${name}: local_url requires HTTP service ${dep}`);
          continue;
        }
        const seen = new Set<string>();
        const depends = (n: string): boolean => {
          if (seen.has(n)) return false;
          seen.add(n);
          return (services[n].depends_on ?? []).some((d) => d === dep || depends(d));
        };
        if (!depends(name)) fail(`${name}: declare depends_on for ${dep}`);
      }
      if (value.replace(token, "").includes("{{")) fail(`${name}: malformed environment reference`);
    }
  return { ...manifest, services };
}
export async function detectIdentity(
  ctx: Context,
  dir: string,
  project: string,
  branch = "",
): Promise<Identity> {
  let root = realpathSync(resolve(dir)),
    isJJ = false;
  for (let p = root; ; p = dirname(p)) {
    if (existsSync(join(p, ".jj"))) {
      isJJ = true;
      break;
    }
    if (dirname(p) === p) break;
  }
  const vcs = async (...args: string[]) =>
    (await run(ctx, args, { cwd: dir, timeout: 10_000 })).toString().trim();
  if (isJJ) {
    root = await vcs("jj", "root");
    if (!branch) {
      const bookmarks = (
        await vcs(
          "jj",
          "log",
          "--ignore-working-copy",
          "-r",
          "heads(::@ & bookmarks())",
          "--no-graph",
          "-T",
          'local_bookmarks.map(|b| b.name()).join("\\n") ++ "\\n"',
        )
      )
        .split(/\s+/)
        .filter(Boolean);
      if (bookmarks.length > 1) fail("Multiple jj bookmarks; select one with --branch");
      branch = bookmarks[0] ?? "";
    }
  } else {
    try {
      root = await vcs("git", "rev-parse", "--show-toplevel");
      if (!branch) {
        try {
          branch = await vcs("git", "symbolic-ref", "--quiet", "--short", "HEAD");
        } catch {
          branch = `detached-${await vcs("git", "rev-parse", "--short=12", "HEAD")}`;
        }
      }
    } catch {}
  }
  return newIdentity(project, root, branch || "workspace");
}
