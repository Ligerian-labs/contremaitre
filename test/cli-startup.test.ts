import { expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { version } from "../apps/cli/src/version.js";

const root = resolve(import.meta.dir, ".."),
  entry = resolve(root, "apps/cli/src/cli.ts"),
  runner = resolve(root, "apps/cli/src/run.ts"),
  scanner = new Bun.Transpiler({ loader: "ts" }),
  builtins = new Set([...builtinModules, "bun"]);

function imports(file: string) {
  return scanner.scanImports(readFileSync(file, "utf8"));
}

function closure(entry: string) {
  const chains = new Map<string, string[]>();
  function visit(file: string, chain: string[]) {
    file = realpathSync(file);
    if (chains.has(file)) return;
    const next = [...chain, relative(root, file)];
    chains.set(file, next);
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    for (const dependency of imports(file)) {
      if (dependency.kind !== "import-statement") continue;
      if (dependency.path.startsWith("node:") || builtins.has(dependency.path)) continue;
      visit(Bun.resolveSync(dependency.path, dirname(file)), next);
    }
  }
  visit(entry, []);
  return chains;
}

function assertClosure(entry: string, allowed: (file: string) => boolean) {
  const modules = closure(entry);
  const offending = [...modules].filter(([file]) => !allowed(relative(root, file)));
  expect(
    offending.map(([, chain]) => chain.join(" -> ")),
    "Unexpected eager modules and their import chains",
  ).toEqual([]);
  return modules;
}

test("CLI entry has only its explicit framework-free static closure", () => {
  const allowed = new Set(
    ["cli.ts", "help.ts", "version.ts", "list.ts"].map((name) => `apps/cli/src/${name}`),
  );
  assertClosure(entry, (file) => allowed.has(file));
});

test("runner does not eagerly load command implementations", () => {
  const forbidden =
    /^(?:packages\/(?:hub|environments|projects|routing)\/|apps\/cli\/src\/(?:agents|init|install|install-agents|agent-assets|saas[^/]*|tunnel|tunnel-logs|update|deploy)\.ts$)/;
  assertClosure(runner, (file) => !forbidden.test(file));
});

test("runner retains literal dynamic imports for each command implementation", () => {
  const dynamic = imports(runner)
    .filter((dependency) => dependency.kind === "dynamic-import")
    .map((dependency) => dependency.path);
  expect(dynamic.sort()).toEqual(
    [
      "@contremaitre/hub/server",
      "@contremaitre/environments/apple",
      "@contremaitre/environments/driver",
      "@contremaitre/environments/runtimes",
      "@contremaitre/environments/model",
      "@contremaitre/projects/model",
      "@contremaitre/routing/proxy",
      "@contremaitre/routing/proxy",
      "@contremaitre/routing/proxy",
      "./agents.js",
      "./deploy.js",
      "./https-service.js",
      "./init.js",
      "./install.js",
      "./install-agents.js",
      "./saas.js",
      "./tunnel.js",
      "./tunnel-logs.js",
      "./update.js",
    ].sort(),
  );
});

test("source version preserves exact framework output", () => {
  const command = Bun.spawnSync([process.execPath, entry, "--version"]);
  expect(command.exitCode).toBe(0);
  expect(command.stdout.toString()).toBe(`${version}\n\n`);
  expect(command.stderr.toString()).toBe("");
});
