import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { decode, fail, strings } from "@contremaitre/execution/context";
import { Schema } from "effect";
import { parse, stringify } from "yaml";
import { parseManifest, safePath, validName } from "./config.js";
import { type Service, slug } from "./model.js";
import { isCompact, manifestFile, projectDocument, saveSetupLock } from "./project-lock.js";
import { conventionalProject, prepareSetup } from "./setup.js";
export function dockerfilePort(contents: string): number {
  const stages = new Map<string, string[]>();
  let exposed: string[] = [],
    stage = "",
    instruction = "";
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.includes("<<") || line.endsWith("`"))
      fail("Cannot infer a port from this Dockerfile syntax");
    instruction += `${line.replace(/\\$/, "")} `;
    if (line.endsWith("\\")) continue;
    const fields = instruction.trim().split(/\s+/);
    instruction = "";
    if (fields[0].toUpperCase() === "FROM") {
      stages.set(stage, exposed);
      const args = fields.slice(1);
      while (args[0]?.startsWith("--")) args.shift();
      if (!args.length) fail("FROM is missing an image");
      exposed = [...(stages.get(args[0].toLowerCase()) ?? [])];
      stage = args.length === 3 && args[1].toUpperCase() === "AS" ? args[2].toLowerCase() : "";
    } else if (fields[0].toUpperCase() === "EXPOSE") exposed.push(...fields.slice(1));
  }
  let port = 0;
  for (const value of exposed) {
    if (!/^[0-9]+(?:\/(?:tcp|udp))?$/.test(value)) fail("EXPOSE must use literal port numbers");
    const [number, protocol] = value.split("/"),
      n = Number(number);
    if (n < 1 || n > 65535) fail("Invalid EXPOSE port");
    if (protocol === "udp") continue;
    if (port && port !== n) fail("Multiple TCP ports are exposed; configure routing explicitly");
    port = n;
  }
  return port;
}
const composeSchema = Schema.Struct({
  version: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  name: Schema.optional(Schema.String),
  volumes: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  services: Schema.Record({
    key: Schema.String,
    value: Schema.Struct({
      image: Schema.optional(Schema.String),
      build: Schema.optional(
        Schema.Union(
          Schema.String,
          Schema.Struct({
            context: Schema.optional(Schema.String),
            dockerfile: Schema.optional(Schema.String),
          }),
        ),
      ),
      command: Schema.optional(Schema.Array(Schema.String)),
      environment: Schema.optional(strings),
      depends_on: Schema.optional(Schema.Array(Schema.String)),
      ports: Schema.optional(Schema.Array(Schema.String)),
      volumes: Schema.optional(Schema.Array(Schema.String)),
    }),
  }),
});
export function importCompose(contents: string, project: string) {
  const doc = decode(
    composeSchema,
    parse(contents),
    "Compose subset; unsupported fields require an explicit manifest",
  );
  const services: Record<string, Service> = {};
  for (const [name, s] of Object.entries(doc.services)) {
    if (/^(postgres|redis):/.test(s.image ?? ""))
      fail(`Convert ${name} to a managed postgres/redis service explicitly`);
    if (Object.values(s.environment ?? {}).some((v) => v.includes("${")))
      fail("Compose interpolation needs explicit manifest configuration");
    if ((s.ports?.length ?? 0) > 1) fail("Multiple published ports need explicit configuration");
    const portText = s.ports?.[0]?.split(":").at(-1);
    if (portText && !/^\d+(?:\/tcp)?$/.test(portText)) fail("Only TCP port mappings are supported");
    const port = portText ? Number(portText.replace("/tcp", "")) : undefined;
    const build =
      typeof s.build === "string" ? s.build : (s.build?.context ?? (s.build ? "." : undefined));
    const dockerfile =
      typeof s.build === "object" && s.build.dockerfile
        ? join(build ?? ".", s.build.dockerfile)
        : undefined;
    const volumes: Record<string, string> = {};
    for (const mount of s.volumes ?? []) {
      const [volume, target, ...extra] = mount.split(":");
      if (extra.length || !target || !validName.test(volume))
        fail("Compose supports named persistent volumes only");
      volumes[volume] = target;
    }
    services[name] = {
      image: s.image,
      build,
      dockerfile,
      command: s.command,
      environment: s.environment,
      depends_on: s.depends_on,
      volumes,
      port,
      http: !!port,
    };
  }
  return parseManifest(
    stringify({ version: 1, project: doc.name ? slug(doc.name) : project, services }),
  );
}
export function initProject(dir: string, compose?: string) {
  const target = join(dir, ".contremaitre.yaml");
  if (
    !compose &&
    [".contremaitre.yaml", ".contremaitre.yml"].some((name) => existsSync(join(dir, name)))
  ) {
    const path = manifestFile(dir);
    if (!lstatSync(path).isFile()) fail("Manifest must be a regular file");
    const text = readFileSync(path, "utf8");
    if (isCompact(projectDocument(text))) {
      const { lock } = prepareSetup(dir, text);
      if (!lock) fail("Development setup did not resolve a lock");
      saveSetupLock(dir, lock, () => {
        if (readFileSync(path, "utf8") !== text)
          fail("Config changed during setup; retry init", "conflict");
      });
      return path;
    }
  }
  for (const name of [".contremaitre.yaml", ".contremaitre.yml"])
    try {
      lstatSync(join(dir, name));
      fail(`Manifest already exists: ${name}`);
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    }
  let project = slug(basename(dir)),
    services: Record<string, Service> = {};
  const generated: Record<string, string> = {};
  const compact = compose ? undefined : conventionalProject(dir);
  if (compact) {
    const { lock } = prepareSetup(dir, compact);
    if (!lock) fail("Development setup did not resolve a lock");
    saveSetupLock(dir, lock, () => writeFileSync(target, compact, { flag: "wx", mode: 0o644 }));
    return target;
  }
  if (compose) {
    const manifest = importCompose(readFileSync(safePath(dir, compose), "utf8"), project);
    project = manifest.project;
    services = manifest.services;
  } else if (existsSync(join(dir, "Dockerfile")))
    services.web = { build: ".", port: 3000, http: true };
  else {
    if (existsSync(join(dir, "docker")))
      for (const file of readdirSync(join(dir, "docker")).sort()) {
        if (!file.endsWith(".Dockerfile")) continue;
        const path = safePath(dir, join("docker", file));
        if (!lstatSync(path).isFile()) continue;
        const name = slug(file.slice(0, -11));
        if (services[name]) fail("Dockerfile service names collide");
        const port = dockerfilePort(readFileSync(path, "utf8"));
        services[name] = { build: ".", dockerfile: join("docker", file), port, http: !!port };
      }
    if (!Object.keys(services).length) {
      if (!existsSync(join(dir, "package.json")))
        fail("No convention detected; add a Dockerfile or explicit manifest");
      const pkg = Schema.decodeUnknownSync(Schema.Struct({ scripts: Schema.optional(strings) }))(
        JSON.parse(readFileSync(join(dir, "package.json"), "utf8")),
      );
      if (!pkg.scripts?.start)
        fail(
          "No runnable app detected: package.json has no start script; add a Dockerfile, docker/<service>.Dockerfile, or explicit manifest",
        );
      let runner = "npm",
        install = "npm ci";
      if (existsSync(join(dir, "pnpm-lock.yaml"))) {
        runner = "pnpm";
        install = "corepack enable && pnpm install --frozen-lockfile";
      } else if (!existsSync(join(dir, "package-lock.json")))
        fail("Commit a package-lock.json or pnpm-lock.yaml, or supply a Dockerfile");
      generated["Dockerfile.contremaitre"] =
        `FROM node:22-bookworm-slim\nWORKDIR /app\nCOPY . .\nRUN ${install}\n${pkg.scripts.build ? `RUN ${runner} run build\n` : ""}ENV HOST=0.0.0.0 PORT=3000\nEXPOSE 3000\nCMD ["${runner}", "run", "start"]\n`;
      generated["Dockerfile.contremaitre.dockerignore"] =
        ".git\n.jj\nnode_modules\n.env\n.env.*\n*.pem\n*.key\n";
      services.web = { build: ".", dockerfile: "Dockerfile.contremaitre", port: 3000, http: true };
    }
  }
  const manifest = stringify({ version: 1, project, services });
  parseManifest(manifest);
  for (const file of Object.keys(generated))
    if (existsSync(join(dir, file))) fail(`File already exists: ${file}`);
  for (const [file, body] of Object.entries(generated))
    writeFileSync(join(dir, file), body, { flag: "wx", mode: 0o644 });
  writeFileSync(target, manifest, { flag: "wx", mode: 0o644 });
  return target;
}
