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
    if (name.startsWith("skills/contremaitre/")) files.set(join(root, ".agents", name), data);
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
  const confined = (path: string) => {
    for (let p = path; ; p = dirname(p)) {
      if (existsSync(p) && !inside(root, realpathSync(p)))
        fail(`Agent installation path escapes destination: ${relative(root, path)}`);
      if (p === root) break;
      if (dirname(p) === p) fail("Invalid agent installation destination");
    }
  };
  for (const [path, data] of files) {
    confined(path);
    if (
      existsSync(path) &&
      (lstatSync(path).isSymbolicLink() ||
        !lstatSync(path).isFile() ||
        readFileSync(path, "utf8") !== data)
    )
      fail(
        `Agent file already exists with different content: ${path}. Review it before replacing it.`,
      );
  }
  const claude = join(root, ".claude/skills/contremaitre"),
    target = join(root, ".agents/skills/contremaitre");
  if (agents.includes("claude")) {
    confined(claude);
    if (existsSync(claude) && realpathSync(claude) !== resolve(target))
      fail(`Claude skill already exists: ${claude}`);
  }
  for (const [path, data] of files) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, data, { flag: "wx", mode: 0o644 });
  }
  if (agents.includes("claude") && !existsSync(claude)) {
    mkdirSync(dirname(claude), { recursive: true });
    symlinkSync(relative(dirname(claude), target), claude, "dir");
  }
  return {
    agents,
    scope: global ? "global" : "project",
    directory: root,
    skill: target,
    next: "Reload skills or restart your agent. Run contremaitre ensure --json in the application workspace.",
  };
}
