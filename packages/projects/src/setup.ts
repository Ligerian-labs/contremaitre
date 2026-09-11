import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { fail, strings } from "@contremaitre/execution/context";
import { Schema } from "effect";
import { stringify } from "yaml";
import { parseManifest, prepareManifest, safePath } from "./config.js";
import { type Manifest, type Service, slug } from "./model.js";
import {
  type App,
  appConfig,
  createProjectLock,
  isCompact,
  type ProjectLock,
  parseProject,
  projectDocument,
} from "./project-lock.js";

const packageSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  packageManager: Schema.optional(Schema.String),
  engines: Schema.optional(Schema.Struct({ node: Schema.optional(Schema.String) })),
  scripts: Schema.optional(strings),
  workspaces: Schema.optional(
    Schema.Union(
      Schema.Array(Schema.String),
      Schema.Struct({ packages: Schema.Array(Schema.String) }),
    ),
  ),
});
type Package = Schema.Schema.Type<typeof packageSchema>;
function packageFile(root: string, path: string): Package {
  try {
    return Schema.decodeUnknownSync(packageSchema)(
      JSON.parse(readFileSync(safePath(root, join(path, "package.json")), "utf8")),
    );
  } catch {
    return fail(
      `${path}: cannot read package.json; run contremaitre init with an agent or supply explicit launch settings`,
    );
  }
}
function literalPort(script: string): number | undefined {
  const ports = [...script.matchAll(/(?:--port[= ]|\bPORT=)(\d+)\b/g)].map((match) =>
    Number(match[1]),
  );
  if (new Set(ports).size === 1 && ports[0] > 0 && ports[0] <= 65535) return ports[0];
}
function endpoints(root: string, path: string, name: string, pkg: Package): Record<string, number> {
  const script = pkg.scripts?.dev ?? "",
    port = literalPort(script);
  if (port) return { [name]: port };
  const result: Record<string, number> = {};
  if (/\bturbo(?:\s+run)?\s+dev\b/.test(script)) {
    // Filtered runners need an agent to establish the active workspace subset.
    if (/--filter|--affected/.test(script))
      fail(`${name}: filtered workspace runner needs setup; run contremaitre init with an agent`);
    const workspaces =
      pkg.workspaces && "packages" in pkg.workspaces ? pkg.workspaces.packages : pkg.workspaces;
    const visited = new Set<string>();
    for (const pattern of workspaces ?? []) {
      if (isAbsolute(pattern) || pattern.split("/").includes(".."))
        fail(`${name}: workspaces must stay inside the project`);
      for (const file of [
        ...new Bun.Glob(`${pattern}/package.json`).scanSync({
          cwd: safePath(root, path),
          onlyFiles: true,
        }),
      ].sort()) {
        if (visited.has(file)) continue;
        visited.add(file);
        if (visited.size > 1000) fail(`${name}: more than 1000 workspace packages; narrow setup`);
        const directory = join(path, file.slice(0, -"/package.json".length));
        const child = packageFile(root, directory);
        if (!child.scripts?.dev) continue;
        const childPort = literalPort(child.scripts.dev),
          endpoint = slug(basename(directory));
        if (!childPort || result[endpoint] || Object.values(result).includes(childPort))
          fail(
            `${name}: workspace endpoints are ambiguous; run contremaitre init with an agent or declare endpoints`,
          );
        result[endpoint] = childPort;
      }
    }
  }
  if (!Object.keys(result).length)
    fail(
      `${name}: cannot detect HTTP ports; run contremaitre init with an agent or declare endpoints ({} for a worker)`,
    );
  return result;
}

export function detectApplication(root: string, name: string, app: App): Service {
  const path = app.path ?? ".";
  if (
    (app.image || app.build) &&
    app.command &&
    app.dev &&
    app.working_dir &&
    (app.endpoints !== undefined || app.port !== undefined)
  )
    return {};
  const pkg = packageFile(root, path),
    repository = path === "." ? pkg : packageFile(root, ".");
  if (/\b(docker|podman|container)\b/.test(pkg.scripts?.dev ?? ""))
    fail(
      `${name}: dev launches a container tool; run contremaitre init with an agent to select the application command`,
    );
  const manager = pkg.packageManager ?? repository.packageManager;
  const match = manager?.match(/^(bun|npm|pnpm|yarn)@(\d+\.\d+\.\d+)(?:\+.*)?$/);
  if (!match)
    fail(`${name}: pin packageManager or supply launch settings during contremaitre init`);
  const [, runner, version] = match;
  if (runner === "yarn" && Number(version.split(".")[0]) > 1)
    fail(
      `${name}: modern Yarn requires project-specific setup; run contremaitre init with an agent`,
    );
  const node = pkg.engines?.node ?? repository.engines?.node;
  const nodeVersion = node?.match(/^(?:\^|~|>=)?(\d+(?:\.\d+){0,2})(?:\s|$|\|)/)?.[1];
  if (runner !== "bun" && !nodeVersion && !app.image && !app.build)
    fail(
      `${name}: Node version is unknown; declare engines.node or an image during contremaitre init`,
    );
  const image =
    runner === "bun" && !node
      ? `oven/bun:${version}`
      : nodeVersion
        ? `node:${nodeVersion}`
        : undefined;
  if (!image && !app.image && !app.build)
    fail(`${name}: cannot resolve runtime requirements; run contremaitre init`);
  const executable =
    runner === "bun"
      ? node
        ? ["npx", "--yes", `bun@${version}`]
        : ["bun"]
      : ["npx", "--yes", `${runner}@${version}`];
  if (!app.command && !pkg.scripts?.dev)
    fail(`${name}: no dev script; specify command during contremaitre init`);
  const lockfiles =
    runner === "bun"
      ? ["bun.lock", "bun.lockb"]
      : runner === "pnpm"
        ? ["pnpm-lock.yaml"]
        : runner === "yarn"
          ? ["yarn.lock"]
          : ["package-lock.json"];
  const frozen = lockfiles.some((file) => existsSync(join(root, file)));
  const install = [
    ...executable,
    ...(runner === "npm"
      ? [frozen ? "ci" : "install"]
      : ["install", ...(frozen ? ["--frozen-lockfile"] : [])]),
  ];
  return {
    image,
    command: [...executable, "run", "dev"],
    working_dir: join("/app", path),
    dev: { source: ".", target: "/app", install },
    ...(app.port === undefined && app.endpoints === undefined
      ? { endpoints: endpoints(root, path, name, pkg) }
      : {}),
  };
}

export function conventionalProject(root: string): string | undefined {
  if (!existsSync(join(root, "package.json"))) return;
  const pkg = packageFile(root, ".");
  if (!pkg.scripts?.dev) return;
  return stringify({ project: slug(pkg.name ?? basename(root)), apps: { app: "." } });
}

export function prepareSetup(root: string, text: string, detected: Record<string, Service> = {}) {
  let lock: ProjectLock | undefined;
  let manifest: Manifest;
  if (isCompact(projectDocument(text))) {
    const project = parseProject(text);
    for (const name of Object.keys(detected))
      if (!Object.hasOwn(project.apps, name))
        fail(`Detected settings refer to unknown app ${name}`);
    const defaults = Object.fromEntries(
      Object.entries(project.apps).map(([name, value]) => {
        const app = appConfig(value);
        safePath(root, app.path);
        return [
          name,
          { path: app.path, defaults: detected[name] ?? detectApplication(root, name, app) },
        ];
      }),
    );
    ({ manifest, lock } = createProjectLock(project, defaults));
  } else {
    if (Object.keys(detected).length) fail("Detected app settings require a compact apps config");
    manifest = parseManifest(text);
  }
  for (const service of Object.values(manifest.services)) {
    for (const path of [service.build, service.dockerfile, service.dev?.source])
      if (path) safePath(root, path);
    if (service.build) safePath(root, service.dockerfile ?? join(service.build, "Dockerfile"));
  }
  if (manifest.driver) safePath(root, manifest.driver.executable);
  prepareManifest(root, manifest);
  return { manifest, lock };
}
