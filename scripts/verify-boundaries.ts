import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

interface Workspace {
  name: string;
  directory: string;
  exports: Record<string, string>;
  dependencies: Record<string, string>;
}

const root = resolve(import.meta.dir, "..");
const workspaces = new Map<string, Workspace>();
for (const group of ["apps", "packages"]) {
  for (const directory of readdirSync(join(root, group))) {
    const path = join(root, group, directory);
    const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    assert(!workspaces.has(manifest.name), `Duplicate workspace ${manifest.name}`);
    workspaces.set(manifest.name, { ...manifest, directory: path });
  }
}

const inside = (directory: string, path: string) => {
  const rel = relative(directory, path);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
};
function* files(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}
function checkImport(workspace: Workspace, file: string, specifier: string) {
  const label = `${relative(root, file)}: ${specifier}`;
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return;
  if (specifier.startsWith(".")) {
    assert(
      inside(join(workspace.directory, "src"), resolve(dirname(file), specifier)),
      `${label} crosses a package boundary; use a declared workspace export`,
    );
    return;
  }
  assert(!isAbsolute(specifier), `${label} uses an absolute import`);
  const parts = specifier.split("/");
  const name = parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
  assert(name in workspace.dependencies, `${label} has no declared runtime dependency`);
  const target = workspaces.get(name);
  if (!target) return;
  assert(workspace.dependencies[name] === "workspace:*", `${label} must use workspace:*`);
  assert(!inside(join(root, "apps"), target.directory), `${label} imports an application`);
  const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
  assert(subpath in target.exports, `${label} is not a public export`);
}

for (const workspace of workspaces.values()) {
  for (const target of Object.values(workspace.exports)) {
    const path = resolve(workspace.directory, target);
    assert(
      inside(join(workspace.directory, "src"), path) && existsSync(path),
      `${workspace.name}: invalid export ${target}`,
    );
  }
  for (const file of files(join(workspace.directory, "src"))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        assert(ts.isStringLiteral(node.moduleSpecifier));
        checkImport(workspace, file, node.moduleSpecifier.text);
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        checkImport(workspace, file, node.argument.literal.text);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const specifier = node.arguments[0];
        assert(
          specifier && ts.isStringLiteral(specifier),
          `${file}: imports must use literal paths`,
        );
        checkImport(workspace, file, specifier.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

const checked = new Set<string>();
function checkCycles(name: string, ancestors: string[]) {
  assert(!ancestors.includes(name), `Workspace cycle: ${[...ancestors, name].join(" -> ")}`);
  if (checked.has(name)) return;
  const workspace = workspaces.get(name);
  assert(workspace);
  for (const dependency of Object.keys(workspace.dependencies)) {
    if (workspaces.has(dependency)) checkCycles(dependency, [...ancestors, name]);
  }
  checked.add(name);
}
for (const name of workspaces.keys()) checkCycles(name, []);
console.log(`Package boundaries verified for ${workspaces.size} workspaces`);
