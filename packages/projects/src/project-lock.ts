import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { decode, fail, hash, message } from "@contremaitre/execution/context";
import { atomicWrite } from "@contremaitre/execution/files";
import { Schema } from "effect";
import { parseAllDocuments, stringify } from "yaml";
import { inside, parseManifest, prepareManifest, serviceDefaults, validName } from "./config.js";
import { type Manifest, type Service, serviceSchema, verificationSchema } from "./model.js";

const appSchema = Schema.Struct({ ...serviceSchema.fields, path: Schema.optional(Schema.String) });
const projectSchema = Schema.Struct({
  version: Schema.optional(Schema.Literal(2)),
  project: Schema.String,
  apps: Schema.Record({ key: Schema.String, value: Schema.Union(Schema.String, appSchema) }),
  services: Schema.optional(Schema.Record({ key: Schema.String, value: serviceSchema })),
  verification: Schema.optional(verificationSchema),
});
export type Project = Schema.Schema.Type<typeof projectSchema>;
export type App = Schema.Schema.Type<typeof appSchema>;
const launchSchema = Schema.Struct({
  image: serviceSchema.fields.image,
  build: serviceSchema.fields.build,
  dockerfile: serviceSchema.fields.dockerfile,
  command: serviceSchema.fields.command,
  working_dir: serviceSchema.fields.working_dir,
  dev: serviceSchema.fields.dev,
  port: serviceSchema.fields.port,
  http: serviceSchema.fields.http,
  endpoints: serviceSchema.fields.endpoints,
  cpus: serviceSchema.fields.cpus,
  memory: serviceSchema.fields.memory,
});
const lockedAppSchema = Schema.Struct({
  path: Schema.String,
  defaults: launchSchema,
  resolved: launchSchema,
});
const lockSchema = Schema.Struct({
  version: Schema.Literal(1),
  config_hash: Schema.String,
  apps: Schema.Record({ key: Schema.String, value: lockedAppSchema }),
});
export type ProjectLock = Schema.Schema.Type<typeof lockSchema>;
export const lockFilename = ".contremaitre.lock";
export interface LoadOptions {
  refresh?: boolean;
  log?: (message: string) => void;
}

export function projectDocument(text: string): unknown {
  const docs = parseAllDocuments(text);
  if (docs.length !== 1 || docs[0].errors.length)
    fail("Manifest must contain one valid YAML document");
  return docs[0].toJSON();
}
export function isCompact(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    ("apps" in value || ("version" in value && value.version === 2))
  );
}
export function parseProject(text: string): Project {
  const project = decode(
    projectSchema,
    projectDocument(text),
    "compact config; check apps, services and overrides",
  );
  if (!validName.test(project.project))
    fail("Project must be a lowercase DNS label, at most 40 characters");
  for (const [name, value] of Object.entries(project.apps)) {
    if (!validName.test(name) || Object.hasOwn(project.services ?? {}, name))
      fail(`Invalid or duplicate app name ${name}`);
    const app = appConfig(value);
    if (!app.path || app.path.startsWith("/") || !inside("/project", join("/project", app.path)))
      fail(`${name}: app path must stay within project`);
    if (app.kind && app.kind !== "app") fail(`${name}: databases belong in services`);
  }
  return project;
}
export function appConfig(value: Project["apps"][string]): App & { path: string } {
  return typeof value === "string" ? { path: value } : { ...value, path: value.path ?? "." };
}

// Only launch settings belong in generated state. Application mappings, file
// contents and credentials remain outside the lock.
export function launchSettings(service: Service): Service {
  const {
    image,
    build,
    dockerfile,
    command,
    working_dir,
    dev,
    port,
    http,
    endpoints,
    cpus,
    memory,
  } = service;
  return JSON.parse(
    JSON.stringify({
      image,
      build,
      dockerfile,
      command,
      working_dir,
      dev,
      port,
      http,
      endpoints,
      cpus,
      memory,
    }),
  );
}
function effective(defaults: Service, app: App): Service {
  const { path: _path, ...overrides } = app;
  const result = { ...defaults, ...overrides };
  if (overrides.build) delete result.image;
  if (overrides.image) {
    delete result.build;
    delete result.dockerfile;
  }
  if (overrides.endpoints) {
    delete result.port;
    delete result.http;
  }
  if (overrides.port !== undefined || overrides.http !== undefined) delete result.endpoints;
  return result;
}
export function resolveProject(
  project: Project,
  defaults: Record<string, { path: string; defaults: Service }>,
) {
  const services: Record<string, Service> = { ...project.services };
  for (const [name, value] of Object.entries(project.apps)) {
    const app = appConfig(value),
      saved = defaults[name];
    if ((!saved || saved.path !== app.path) && !explicitLaunch(app))
      fail(`${name}: setup is required for this app path; run contremaitre init`);
    services[name] = effective(saved?.path === app.path ? saved.defaults : {}, app);
  }
  // References carry dependency intent, so compact files need not repeat it.
  const owners = Object.fromEntries(
    Object.entries(services).flatMap(([name, service]) =>
      Object.keys(service.endpoints ?? {}).map((endpoint) => [endpoint, name]),
    ),
  );
  for (const [name, service] of Object.entries(services)) {
    const deps = new Set(service.depends_on ?? []);
    for (const value of Object.values(service.environment ?? {}))
      for (const match of value.matchAll(/\{\{([a-z][a-z0-9-]*)\.(host|port|url)\}\}/g)) {
        const dependency = owners[match[1]] ?? match[1];
        if (dependency !== name && dependency !== "contremaitre") deps.add(dependency);
      }
    if (deps.size) services[name] = { ...service, depends_on: [...deps].sort() };
  }
  return parseManifest(
    stringify({
      version: 1,
      project: project.project,
      services,
      verification: project.verification,
    }),
  );
}
function explicitLaunch(app: App): boolean {
  return (
    !!(app.image || app.build) &&
    !!app.command?.length &&
    (app.endpoints !== undefined || app.port !== undefined) &&
    !!app.working_dir &&
    !!app.dev
  );
}
export function createProjectLock(
  project: Project,
  defaults: Record<string, { path: string; defaults: Service }>,
) {
  for (const [name, settings] of Object.entries(defaults)) {
    decode(
      launchSchema,
      settings.defaults,
      `${name} detected launch settings; keep application mappings in the config`,
    );
  }
  const manifest = resolveProject(project, defaults);
  const lock: ProjectLock = {
    version: 1,
    config_hash: hash(JSON.stringify(project)),
    apps: Object.fromEntries(
      Object.keys(project.apps)
        .sort()
        .map((name) => {
          const app = appConfig(project.apps[name]);
          const base = defaults[name]?.path === app.path ? defaults[name].defaults : {};
          const normalized = serviceDefaults({ ...base, dev: base.dev ?? app.dev });
          return [
            name,
            {
              path: app.path,
              defaults: launchSettings({ ...normalized, dev: base.dev }),
              resolved: launchSettings(manifest.services[name]),
            },
          ];
        }),
    ),
  };
  return { manifest, lock };
}
export function readProjectLock(root: string): ProjectLock | undefined {
  const path = join(root, lockFilename);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 1048576) fail("Lock must be a regular file up to 1 MiB");
    return decode(
      lockSchema,
      JSON.parse(readFileSync(path, "utf8")),
      ".contremaitre.lock; run contremaitre init to repair it",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return fail(`Cannot read .contremaitre.lock; run contremaitre init: ${message(error)}`);
  }
}
export function writeProjectLock(root: string, lock: ProjectLock) {
  atomicWrite(join(root, lockFilename), `${JSON.stringify(lock, null, 2)}\n`, 0o644);
}
export function saveSetupLock(root: string, lock: ProjectLock, saveConfig: () => void) {
  const path = join(root, lockFilename);
  const previous = existsSync(path) ? readFileSync(path) : undefined;
  writeProjectLock(root, lock);
  try {
    saveConfig();
  } catch (error) {
    if (previous) atomicWrite(path, previous, 0o644);
    else unlinkSync(path);
    throw error;
  }
}
export function manifestFile(root: string) {
  const files = [".contremaitre.yaml", ".contremaitre.yml"].filter((file) =>
    existsSync(join(root, file)),
  );
  if (files.length > 1) fail("Both manifest filenames exist; keep one");
  if (!files.length) fail(`No .contremaitre.yaml in ${root}; run contremaitre init`);
  return join(root, files[0]);
}
export function projectName(root: string) {
  const text = readFileSync(manifestFile(root), "utf8");
  return isCompact(projectDocument(text))
    ? parseProject(text).project
    : parseManifest(text).project;
}
export function loadProject(root: string, options: LoadOptions = {}): Manifest {
  try {
    const path = manifestFile(root),
      text = readFileSync(path, "utf8");
    if (!isCompact(projectDocument(text))) return parseManifest(text);
    const project = parseProject(text),
      previous = readProjectLock(root);
    if (!previous)
      fail("Missing .contremaitre.lock; run contremaitre init and commit both configuration files");
    const { manifest, lock } = createProjectLock(project, previous.apps);
    if (
      previous.config_hash === lock.config_hash &&
      Object.keys(lock.apps).some(
        (name) =>
          JSON.stringify(launchSettings(previous.apps[name]?.resolved ?? {})) !==
          JSON.stringify(lock.apps[name].resolved),
      )
    )
      fail(
        "Inconsistent .contremaitre.lock; run contremaitre init to resolve the saved launch settings",
      );
    if (previous.config_hash !== lock.config_hash) {
      if (!options.refresh)
        fail("Configuration changed; run contremaitre deploy to refresh .contremaitre.lock");
      // Check env files and template semantics before replacing the last valid lock.
      prepareManifest(root, manifest);
      if (readFileSync(path, "utf8") !== text)
        fail("Config changed during lock refresh; retry deploy", "conflict");
      writeProjectLock(root, lock);
      const changed = Object.keys(lock.apps).filter(
        (name) => JSON.stringify(lock.apps[name]) !== JSON.stringify(previous.apps[name]),
      );
      const removed = Object.keys(previous.apps).filter((name) => !Object.hasOwn(lock.apps, name));
      options.log?.(
        `Refreshed .contremaitre.lock from configuration changes${changed.length ? `; launch settings: ${changed.join(", ")}` : ""}${removed.length ? `; removed: ${removed.join(", ")}` : ""}. Review and commit it.\n`,
      );
    }
    return manifest;
  } catch (error) {
    options.log?.(`Configuration resolution failed: ${message(error)}\n`);
    throw error;
  }
}
