import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCommand, agentText, selectAgent } from "@contremaitre/cli/init";
import { context } from "@contremaitre/execution/context";
import {
  assistedInit,
  readInitFile,
  repositoryInventory,
} from "@contremaitre/projects/assisted-init";

const manifest = "version: 1\nproject: turbo\nservices:\n  web: {image: node:22}\n";
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cm-init-test-")),
    root = join(home, "project");
  mkdirSync(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { dev: "turbo run dev" } }));
  return {
    home,
    root,
    options: { lockDirectory: join(home, "lock") },
    clean: () => rmSync(home, { recursive: true, force: true }),
  };
}
test("assisted init reads requested scripts and asks one question before writing only a manifest", async () => {
  const f = fixture(),
    questions: string[] = [],
    prompts: string[] = [];
  writeFileSync(join(f.root, "dev.ts"), 'const compose = "docker-compose.dev.yml";');
  const replies = [
    { type: "read", paths: ["dev.ts"] },
    { type: "question", question: "Which stack?", options: ["bun dev", "Production"] },
    { type: "manifest", manifest },
  ];
  try {
    const target = await assistedInit(
      context(),
      f.root,
      async (_ctx, prompt) => {
        prompts.push(prompt);
        return JSON.stringify(replies.shift());
      },
      {
        ask: async (q) => {
          questions.push(q);
          return "bun dev";
        },
        note() {},
      },
      f.options,
    );
    expect(questions).toEqual(["Which stack?"]);
    expect(prompts[1]).toContain("docker-compose.dev.yml");
    expect(prompts[2]).toContain('"answer":"bun dev"');
    expect(readFileSync(target, "utf8")).toBe(manifest);
    expect(readdirSync(f.root).sort()).toEqual([".contremaitre.yaml", "dev.ts", "package.json"]);
  } finally {
    f.clean();
  }
});
test("existing yml enters update discussion and concurrent edits are preserved", async () => {
  const f = fixture(),
    path = join(f.root, ".contremaitre.yml");
  writeFileSync(path, manifest);
  try {
    let question = "";
    await expect(
      assistedInit(
        context(),
        f.root,
        async () => {
          writeFileSync(path, `${manifest}# user edit\n`);
          return JSON.stringify({ type: "manifest", manifest });
        },
        {
          ask: async (q) => {
            question = q;
            return "Add a worker";
          },
          note() {},
        },
        f.options,
      ),
    ).rejects.toThrow("changed during init");
    expect(question).toContain("existing manifest");
    expect(readFileSync(path, "utf8")).toContain("# user edit");
  } finally {
    f.clean();
  }
});
test("invalid output is bounded and cancellation leaves the existing manifest intact", async () => {
  const f = fixture(),
    path = join(f.root, ".contremaitre.yaml");
  writeFileSync(path, manifest);
  const ui = { ask: async () => "Keep choices", note() {} };
  try {
    let calls = 0;
    await expect(
      assistedInit(
        context(),
        f.root,
        async () => {
          calls++;
          return "not json";
        },
        ui,
        f.options,
      ),
    ).rejects.toThrow("three times");
    expect(calls).toBe(3);
    const controller = new AbortController();
    await expect(
      assistedInit(
        context(controller.signal),
        f.root,
        async () => {
          controller.abort();
          return JSON.stringify({ type: "manifest", manifest });
        },
        ui,
        f.options,
      ),
    ).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe(manifest);
  } finally {
    f.clean();
  }
});
test("inventory excludes dependencies, refuses escaped paths and redacts env values", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "node_modules"));
    writeFileSync(join(f.root, "node_modules", "hidden.ts"), "secret");
    writeFileSync(join(f.root, ".env.dev"), "PASSWORD=never-send-this\nPORT=3000\n");
    writeFileSync(join(f.home, "outside"), "outside");
    symlinkSync(join(f.home, "outside"), join(f.root, "escape"));
    expect(repositoryInventory(f.root)).not.toContain("node_modules/hidden.ts");
    expect(repositoryInventory(f.root)).not.toContain("escape");
    expect(readInitFile(f.root, ".env.dev")).toBe("PASSWORD=<redacted>\nPORT=<redacted>");
    expect(() => readInitFile(f.root, "escape")).toThrow("escapes");
  } finally {
    f.clean();
  }
});
test("agent selection honors override, configuration and remembered discovery", async () => {
  const ui = { ask: async () => "pi", note() {} };
  expect((await selectAgent("codex", { provider: "claude" }, ui, () => true)).agent.provider).toBe(
    "codex",
  );
  expect(
    (
      await selectAgent(
        undefined,
        { provider: "claude", executable: "/custom/claude" },
        ui,
        (p) => p === "/custom/claude",
      )
    ).agent.executable,
  ).toBe("/custom/claude");
  expect(await selectAgent(undefined, undefined, ui, () => true)).toEqual({
    agent: { provider: "pi" },
    remember: true,
  });
  await expect(selectAgent(undefined, undefined, ui, () => false)).rejects.toThrow("--no-ai");
  await expect(selectAgent("pi", undefined, ui, () => false)).rejects.toThrow("unavailable");
});
test("agent adapters extract final text and reject provider errors", () => {
  const text = JSON.stringify({ type: "question", question: "Which stack?", options: [] });
  expect(
    agentText(
      "codex",
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
    ),
  ).toBe(text);
  expect(agentText("claude", JSON.stringify({ type: "result", result: text }))).toBe(text);
  expect(
    agentText(
      "pi",
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      }),
    ),
  ).toBe(text);
  expect(agentText("opencode", JSON.stringify({ type: "text", part: { text } }))).toBe(text);
  expect(() =>
    agentText("claude", JSON.stringify({ type: "result", is_error: true, result: "secret" })),
  ).toThrow("authentication");
  expect(agentCommand({ provider: "codex" })).toContain("read-only");
  expect(agentCommand({ provider: "pi" })).toContain("--no-tools");
});
