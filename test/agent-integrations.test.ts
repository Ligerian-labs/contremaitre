import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentAssets } from "../apps/cli/src/agent-assets.js";
import { installAgents } from "../apps/cli/src/install-agents.js";
import { ContremaitrePlugin } from "../integrations/contremaitre/extensions/opencode.js";
import piPlugin from "../integrations/contremaitre/extensions/pi.js";

test("all four installations share one skill, preserve edits and resolve their native adapters", () => {
  const root = mkdtempSync(join(tmpdir(), "cm-agents-install-"));
  try {
    expect(installAgents(root, "all").agents).toEqual(["claude", "codex", "opencode", "pi"]);
    expect(realpathSync(join(root, ".claude/skills/contremaitre"))).toBe(
      realpathSync(join(root, ".agents/skills/contremaitre")),
    );
    expect(existsSync(join(root, ".opencode/plugins/contremaitre.ts"))).toBe(true);
    expect(existsSync(join(root, ".opencode/contremaitre/common.ts"))).toBe(true);
    expect(existsSync(join(root, ".pi/extensions/contremaitre/index.ts"))).toBe(true);
    expect(existsSync(join(root, ".pi/extensions/contremaitre/common.ts"))).toBe(true);
    expect(() => installAgents(root, "all")).not.toThrow();
    const skill = join(root, ".agents/skills/contremaitre/SKILL.md");
    writeFileSync(skill, "user modification");
    expect(() => installAgents(root, "codex")).toThrow("different content");
    expect(readFileSync(skill, "utf8")).toBe("user modification");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("embedded plugin files match source and keep discovery and instructions bounded", () => {
  const root = new URL("../integrations/contremaitre/", import.meta.url).pathname;
  for (const [path, text] of Object.entries(agentAssets))
    expect(readFileSync(join(root, path), "utf8")).toBe(text);
  const text = agentAssets["skills/contremaitre/SKILL.md"];
  expect(text.split("---")[1].length).toBeLessThan(400);
  expect(Buffer.byteLength(text)).toBeLessThan(3000);
  expect(JSON.parse(agentAssets[".codex-plugin/plugin.json"]).skills).toBe("./skills/");
  expect(JSON.parse(agentAssets[".claude-plugin/plugin.json"]).skills).toBe("./skills/");
  expect(JSON.parse(agentAssets["package.json"]).pi.extensions).toEqual(["./extensions/pi.ts"]);
});

test("OpenCode and Pi display verification state without adding model messages", async () => {
  const root = mkdtempSync(join(tmpdir(), "cm-agents-ui-"));
  const before = process.env.PATH;
  try {
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, ".contremaitre.yaml"), "version: 1\n");
    const state = join(root, "state.json");
    writeFileSync(
      state,
      JSON.stringify({
        version: 1,
        data: {
          ready: true,
          source_current: true,
          stale: false,
          verification: "passed",
          review_url: "http://127.0.0.1:9000/review",
        },
      }),
    );
    writeFileSync(
      join(root, "bin/contremaitre"),
      `#!${process.execPath}\nif(process.argv.slice(2).join(' ')!=='report --json')process.exit(1);process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(state)},'utf8'));`,
      { mode: 0o700 },
    );
    process.env.PATH = `${root}/bin:${before}`;
    const messages: string[] = [];
    const open = await ContremaitrePlugin({
      directory: root,
      client: { tui: { showToast: async (input) => messages.push(input.body.title) } },
    });
    await open.event({ event: { type: "file.edited" } });
    expect(messages).toEqual([]);
    await open.event({ event: { type: "session.idle" } });
    await open.event({ event: { type: "session.idle" } });
    expect(messages).toEqual(["Contremaitre: passed"]);
    type Handler = Parameters<Parameters<typeof piPlugin>[0]["on"]>[1];
    let handler: Handler | undefined;
    const notices: string[] = [];
    piPlugin({
      on: (_event, fn) => {
        handler = fn;
      },
      registerCommand: () => {},
    });
    const ui = {
      setStatus: (_key: string, text: string | undefined) => {
        if (text) notices.push(text);
      },
      notify: () => {},
    };
    await handler?.({}, { cwd: root, ui });
    expect(notices).toEqual(["Contremaitre: passed"]);
    writeFileSync(
      state,
      JSON.stringify({
        version: 1,
        data: {
          ready: true,
          source_current: false,
          stale: true,
          verification: "passed",
          review_url: "http://127.0.0.1:9000/review",
        },
      }),
    );
    await open.event({ event: { type: "session.idle" } });
    await handler?.({}, { cwd: root, ui });
    expect(messages.at(-1)).toBe("Contremaitre: stale evidence");
    expect(notices.at(-1)).toBe("Contremaitre: stale evidence");
  } finally {
    process.env.PATH = before;
    rmSync(root, { recursive: true, force: true });
  }
});
