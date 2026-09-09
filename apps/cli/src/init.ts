import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type Context, decode, fail, hash } from "@contremaitre/execution/context";
import { atomicWrite } from "@contremaitre/execution/files";
import { run } from "@contremaitre/execution/process";
import { assistedInit, type InitUI } from "@contremaitre/projects/assisted-init";
import { initProject } from "@contremaitre/projects/init";
import { Schema } from "effect";

export const providers = ["codex", "claude", "pi", "opencode"] as const;
export type Provider = (typeof providers)[number];
const providerSchema = Schema.Literal(...providers);
const agentSchema = Schema.Struct({
  provider: providerSchema,
  executable: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  model: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
});
const configSchema = Schema.Struct({
  agent: Schema.optional(agentSchema),
  timeout_seconds: Schema.optional(Schema.Int.pipe(Schema.between(10, 1800))),
  max_turns: Schema.optional(Schema.Int.pipe(Schema.between(1, 100))),
});
type Agent = Schema.Schema.Type<typeof agentSchema>;

export function terminalUI(
  ctx: Context,
  cancel: () => void = () => {},
): InitUI & { close(): void } {
  const lines = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: !!process.stdin.isTTY,
  });
  const input = lines[Symbol.asyncIterator]();
  lines.on("SIGINT", () => {
    cancel();
    lines.close();
  });
  lines.on("close", cancel);
  const abort = () => lines.close();
  ctx.signal.addEventListener("abort", abort, { once: true });
  const clean = (s: string) =>
    Array.from(s, (c) =>
      c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159) ? " " : c,
    ).join("");
  return {
    note: (s) => process.stderr.write(`${clean(s)}\n`),
    async ask(question, options) {
      process.stderr.write(`\n${clean(question)}\n`);
      options.forEach((option, i) => {
        process.stderr.write(`${i + 1}. ${clean(option)}\n`);
      });
      while (true) {
        ctx.signal.throwIfAborted();
        process.stderr.write("> ");
        const line = await input.next();
        if (line.done) fail("Init cancelled; manifest was preserved");
        const answer = line.value.trim();
        if (!answer) continue;
        if (/^\d+$/.test(answer) && options.length) {
          if (!options[Number(answer) - 1]) {
            process.stderr.write("Choose a listed number or enter your own answer.\n");
            continue;
          }
          return options[Number(answer) - 1];
        }
        return answer;
      }
    },
    close() {
      ctx.signal.removeEventListener("abort", abort);
      lines.close();
    },
  };
}

export async function selectAgent(
  override: string | undefined,
  configured: Agent | undefined,
  ui: InitUI,
  available: (name: string) => boolean = (name) => !!Bun.which(name),
): Promise<{ agent: Agent; remember: boolean }> {
  if (override || configured) {
    const provider = override
      ? decode(providerSchema, override, "agent; choose codex, claude, pi or opencode")
      : configured?.provider;
    if (!provider) fail("No agent selected");
    const agent = configured?.provider === provider ? configured : { provider };
    if (!available(agent.executable ?? provider))
      fail(
        `Agent ${provider} is unavailable. Install it or set agent.executable in init.json. For conventional detection run contremaitre init --no-ai.`,
      );
    return { agent, remember: false };
  }
  const installed = providers.filter(available);
  if (!installed.length)
    fail(
      "No coding agent found. Install Codex, Claude Code, Pi or OpenCode, or configure agent in <home>/init.json. For conventional detection run contremaitre init --no-ai.",
    );
  if (installed.length === 1) return { agent: { provider: installed[0] }, remember: true };
  while (true) {
    const answer = await ui.ask("Which coding agent should init use?", installed);
    if (installed.includes(answer as Provider))
      return { agent: { provider: answer as Provider }, remember: true };
    ui.note("Choose one of the installed agents.");
  }
}

// Run in an empty directory with tools/customizations disabled. Only the protocol
// can request repository reads, and only Contremaitre writes the manifest.
export function agentCommand(agent: Agent) {
  const model = agent.model ? ["--model", agent.model] : [];
  switch (agent.provider) {
    case "codex":
      return [
        agent.executable ?? "codex",
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--disable",
        "shell_tool",
        "--disable",
        "multi_agent",
        "--json",
        ...model,
        "-",
      ];
    case "claude":
      return [
        agent.executable ?? "claude",
        "--print",
        "--safe-mode",
        "--tools",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--output-format",
        "json",
        ...model,
      ];
    case "pi":
      return [
        agent.executable ?? "pi",
        "--print",
        "--mode",
        "json",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-session",
        ...model,
      ];
    case "opencode":
      return [
        agent.executable ?? "opencode",
        "run",
        "--pure",
        "--agent",
        "contremaitre-init",
        "--format",
        "json",
        ...model,
      ];
  }
}
interface AgentEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  error?: unknown;
  item?: { type?: string; text?: string };
  part?: { text?: string };
  message?: { role?: string; content?: { type?: string; text?: string }[]; stopReason?: string };
}
export function agentText(provider: Provider, output: string): string {
  let result = "";
  for (const line of output.split("\n").filter((line) => line.trim())) {
    let event: AgentEvent;
    try {
      event = JSON.parse(line);
    } catch {
      fail(`${provider} returned invalid JSON events; check the installed CLI version`);
    }
    if (
      event.is_error ||
      event.type === "error" ||
      event.type === "turn.failed" ||
      event.message?.stopReason === "error"
    )
      fail(`${provider} failed; run it directly to check authentication and model availability`);
    if (provider === "claude" && event.type === "result") result = event.result ?? "";
    if (
      provider === "codex" &&
      event.type === "item.completed" &&
      event.item?.type === "agent_message"
    )
      result = event.item.text ?? "";
    if (provider === "pi" && event.type === "message_end" && event.message?.role === "assistant")
      result =
        event.message.content
          ?.filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("") ?? "";
    if (provider === "opencode" && event.type === "text") result += event.part?.text ?? "";
  }
  if (!result.trim())
    fail(`${provider} returned no answer; check authentication and model availability`);
  return result;
}
export async function invokeInitAgent(
  ctx: Context,
  agent: Agent,
  prompt: string,
  timeout = 300_000,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "contremaitre-init-"));
  try {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    if (agent.provider === "opencode") {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        share: "disabled",
        agent: {
          "contremaitre-init": {
            mode: "primary",
            permission: { "*": "deny" },
            tools: { "*": false },
          },
        },
        permission: { "*": "deny" },
      });
      env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
    }
    const output = await run(ctx, agentCommand(agent), {
      cwd: dir,
      env,
      stdin: Buffer.from(prompt),
      timeout,
      maxOutput: 4 * 1024 * 1024,
      strictOutput: true,
    });
    return agentText(agent.provider, output.toString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
export async function initialize(
  ctx: Context,
  root: string,
  home: string,
  options: { noAI: boolean; agent?: string; compose?: string; json?: boolean },
) {
  if (options.noAI) {
    if (options.agent) fail("--agent cannot be combined with --no-ai");
    return initProject(root, options.compose);
  }
  if (!process.stdin.isTTY)
    fail(
      "Agent-assisted init requires an interactive terminal. For scripts use contremaitre init --no-ai.",
    );
  const path = join(home, "init.json");
  const config = existsSync(path)
    ? decode(configSchema, JSON.parse(readFileSync(path, "utf8")), "init.json configuration")
    : {};
  const cancelled = new AbortController();
  const initContext = { ...ctx, signal: AbortSignal.any([ctx.signal, cancelled.signal]) };
  const ui = terminalUI(initContext, () => cancelled.abort());
  try {
    const selected = await selectAgent(options.agent, config.agent, ui);
    if (selected.remember)
      atomicWrite(path, JSON.stringify({ ...config, agent: selected.agent }, null, 2));
    ui.note(`Using ${selected.agent.provider}. Reading the development stack…`);
    const executable = Bun.which(selected.agent.executable ?? selected.agent.provider);
    if (!executable) fail(`Agent ${selected.agent.provider} disappeared from PATH`);
    return await assistedInit(
      initContext,
      root,
      (ctx, prompt) =>
        invokeInitAgent(
          ctx,
          { ...selected.agent, executable },
          prompt,
          (config.timeout_seconds ?? 300) * 1000,
        ),
      ui,
      {
        compose: options.compose,
        maxTurns: config.max_turns,
        lockDirectory: join(home, "init-locks", hash(root)),
      },
    );
  } finally {
    ui.close();
  }
}
