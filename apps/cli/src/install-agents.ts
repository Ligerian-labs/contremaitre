import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fail } from "@contremaitre/execution/context";
import { inside } from "@contremaitre/projects/config";
import { agentAssets } from "./agent-assets.js";

export function installAgents(directory: string, agent: string, global = false) {
  const agents = agent === "all" ? ["claude", "codex", "opencode", "pi"] : [agent];
  if (!agents.every((a) => ["claude", "codex", "opencode", "pi"].includes(a)))
    fail("Choose --agent claude, codex, opencode, pi or all");
  const root = realpathSync(global ? homedir() : directory);
  const files = new Map<string, string>();
  for (const [name, data] of Object.entries(agentAssets))
    if (name.startsWith("skills/")) files.set(join(root, ".agents", name), data);
  if (agents.includes("opencode")) {
    const base = join(root, global ? ".config/opencode" : ".opencode");
    files.set(join(base, "contremaitre/common.ts"), agentAssets["common.ts"]);
    files.set(
      join(base, "plugins/contremaitre.ts"),
      agentAssets["extensions/opencode.ts"].replace(
        '"../common.ts"',
        '"../contremaitre/common.ts"',
      ),
    );
  }
  if (agents.includes("pi")) {
    const base = join(
      root,
      global ? ".pi/agent/extensions/contremaitre" : ".pi/extensions/contremaitre",
    );
    files.set(join(base, "common.ts"), agentAssets["common.ts"]);
    files.set(
      join(base, "index.ts"),
      agentAssets["extensions/pi.ts"].replace('"../common.ts"', '"./common.ts"'),
    );
  }
  const links = new Map<string, string>();
  const skills = Object.keys(agentAssets)
    .filter((name) => /^skills\/[^/]+\/SKILL\.md$/.test(name))
    .map((name) => join(root, ".agents", dirname(name)));
  if (agents.includes("claude"))
    for (const target of skills)
      links.set(
        join(root, ".claude/skills", relative(join(root, ".agents/skills"), target)),
        target,
      );
  writeAssets(root, files, links);
  return {
    agents,
    scope: global ? "global" : "project",
    directory: root,
    skill: join(root, ".agents/skills/contremaitre"),
    skills,
    next: "Reload skills or restart your agent. Use contremaitre-setup to configure a project, or contremaitre to verify it.",
  };
}

export function exportAgents(directory: string) {
  const root = realpathSync(directory),
    plugin = join(root, "contremaitre");
  writeAssets(
    root,
    new Map(Object.entries(agentAssets).map(([name, data]) => [join(plugin, name), data])),
  );
  return {
    directory: plugin,
    next: "Load this directory as a Claude Code plugin or Pi package, or install its skills with contremaitre agents install.",
  };
}

function writeAssets(root: string, files: Map<string, string>, links = new Map<string, string>()) {
  const entry = (path: string) => lstatSync(path, { throwIfNoEntry: false });
  const confined = (path: string) => {
    for (let p = path; ; p = dirname(p)) {
      if (entry(p) && (!existsSync(p) || !inside(root, realpathSync(p))))
        fail(`Agent installation path escapes destination: ${relative(root, path)}`);
      if (p !== path && entry(p) && !lstatSync(realpathSync(p)).isDirectory())
        fail(`Agent installation parent is not a directory: ${relative(root, p)}`);
      if (p === root) break;
      if (dirname(p) === p) fail("Invalid agent installation destination");
    }
  };
  for (const [path, data] of files) {
    confined(path);
    if (
      entry(path) &&
      (lstatSync(path).isSymbolicLink() ||
        !lstatSync(path).isFile() ||
        readFileSync(path, "utf8") !== data)
    )
      fail(
        `Agent file already exists with different content: ${path}. Review it before replacing it.`,
      );
  }
  for (const [path, target] of links) {
    confined(path);
    if (existsSync(path) && realpathSync(path) !== resolve(target))
      fail(`Claude skill already exists: ${path}`);
  }
  for (const [path, data] of files) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, data, { flag: "wx", mode: 0o644 });
  }
  for (const [path, target] of links)
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(relative(dirname(path), target), path, "dir");
    }
}
