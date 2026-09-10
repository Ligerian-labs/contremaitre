import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRoot, normalizeArguments } from "@contremaitre/cli/cli";
import { runCliForTest } from "@structure-ai/cli";
import { Effect } from "effect";

test("preserves exec passthrough and global flag ordering", async () => {
  const parsed = normalizeArguments([
    "--home",
    "/tmp/no-such-contremaitre-home",
    "exec",
    "web",
    "--",
    "node",
    "--help",
  ]);
  expect(parsed.command).toEqual(["node", "--help"]);
  expect(parsed.args[0]).toBe("exec");
  const result = await Effect.runPromise(runCliForTest(makeRoot(parsed.command), parsed.args));
  expect(result.exitCode).not.toBe(0);
  expect(result.errorMessage).toContain("ENOENT");
});

const cliPath = fileURLToPath(new URL("../apps/cli/src/cli.ts", import.meta.url));
const cliDirectory = mkdtempSync(join(tmpdir(), "cm-cli-help-"));
afterAll(() => rmSync(cliDirectory, { recursive: true, force: true }));
async function cli(args: string[], columns = 80) {
  const child = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: cliDirectory,
    env: {
      ...process.env,
      CONTREMAITRE_HOME: join(cliDirectory, "home"),
      NO_COLOR: "1",
      COLUMNS: String(columns),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("plain init requires a terminal and explicit non-AI init works without an agent", async () => {
  const plain = await cli(["init"]);
  expect(plain.code).not.toBe(0);
  expect(plain.stderr).toContain("--no-ai");
  expect(existsSync(join(cliDirectory, ".contremaitre.yaml"))).toBe(false);
  writeFileSync(join(cliDirectory, "Dockerfile"), "FROM scratch\n");
  try {
    const result = await cli(["init", "--no-ai"]);
    expect(result.code).toBe(0);
    expect(existsSync(join(cliDirectory, ".contremaitre.yaml"))).toBe(true);
    const again = await cli(["init", "--no-ai"]);
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain("already exists");
  } finally {
    rmSync(join(cliDirectory, "Dockerfile"), { force: true });
    rmSync(join(cliDirectory, ".contremaitre.yaml"), { force: true });
  }
});

const commandNames = [
  "init",
  "start",
  "serve",
  "deploy",
  "attach",
  "operations",
  "cancel",
  "show",
  "list",
  "status",
  "main",
  "down",
  "prune",
  "stop",
  "exec",
  "logs",
  "proxy",
  "tunnel",
  "version",
  "forward-http",
  "forward-https",
  "https-service",
];

test("tunnel documents SaaS login and explicit workspace selection", async () => {
  const result = await cli(["tunnel", "--help"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("login");
  expect(result.stdout).toContain("--workspace");
  const login = await cli(["tunnel", "login", "--json"]);
  expect(login.code).not.toBe(0);
  expect(JSON.parse(login.stdout).error).toContain("tunnel login interactively");
  expect(login.stderr).toBe("");
});

test("HTTPS service commands validate actions and require a compiled installer before elevation", async () => {
  expect((await cli(["https-service"])).stderr).toContain("requires install, status or uninstall");
  expect((await cli(["https-service", "unknown"])).stderr).toContain(
    "requires install, status or uninstall",
  );
  expect((await cli(["https-service", "install"])).stderr).toContain("compiled CLI");
  expect((await cli(["https-service", "install", "--https-port", "443"])).stderr).toContain(
    "1024..65535",
  );
});

test("root help is a compact overview of every command, also shown without arguments", async () => {
  const help = await cli(["--help"]);
  expect(help.code).toBe(0);
  expect(help.stderr).toBe("");
  expect(help.stdout).toContain("Usage: contremaitre <command> [flags]");
  for (const name of commandNames) expect(help.stdout).toMatch(new RegExp(`\\b${name}\\b`));
  const lines = help.stdout.trimEnd().split("\n");
  expect(lines.length).toBeLessThanOrEqual(35);
  expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(80);
  expect(help.stdout).not.toContain("This setting is optional");
  expect(help.stdout).not.toContain("\u001b[");
  expect(help.stdout.indexOf("  init")).toBeLessThan(250);
  for (const args of [[], ["-h"], ["help"]]) {
    const result = await cli(args);
    expect(result).toEqual(help);
  }
});

test("command help shows examples, relevant flags, defaults and shared flags", async () => {
  const help = await cli(["deploy", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stderr).toBe("");
  expect(help.stdout).toContain("Usage: contremaitre deploy [flags]");
  expect(help.stdout).toContain("Examples:");
  expect(help.stdout).toContain("Flags:");
  expect(help.stdout).toContain("Shared flags:");
  for (const flag of ["--branch", "--main", "--rebuild", "--detach", "--home", "--json"]) {
    expect(help.stdout).toContain(flag);
  }
  expect(help.stdout).toContain("8080");
  for (const flag of ["--compose", "--offset", "--delete-data", "--env"]) {
    expect(help.stdout).not.toContain(flag);
  }
  expect(help.stdout).not.toContain("<arguments>");
  expect(help.stdout).not.toContain("A true or false value");
  for (const args of [
    ["help", "deploy"],
    ["deploy", "-h"],
    ["--help", "deploy"],
  ]) {
    expect(await cli(args)).toEqual(help);
  }
});

test("irrelevant flags and unknown commands fail as usage errors", async () => {
  for (const args of [
    ["version", "--rebuild"],
    ["version", "--compose", "compose.yml"],
    ["list", "--branch", "main"],
    ["unknown", "--help"],
  ]) {
    const result = await cli(args);
    expect(result.code).toBe(64);
    expect(result.stderr).toMatch(/unknown|unexpected|not supported/i);
    expect(result.stdout).toBe("");
  }
});

test("every command has specific help and narrow output wraps cleanly", async () => {
  const results = await Promise.all(commandNames.map((name) => cli([name, "--help"])));
  for (const [index, help] of results.entries()) {
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain(`Usage: contremaitre ${commandNames[index]}`);
    expect(help.stdout).toContain("Examples:");
    expect(help.stdout).not.toContain("<arguments>");
    expect(
      Math.max(
        ...help.stdout
          .trimEnd()
          .split("\n")
          .map((line) => line.length),
      ),
    ).toBeLessThanOrEqual(80);
  }
  const narrow = await cli(["deploy", "--help"], 50);
  expect(
    Math.max(
      ...narrow.stdout
        .trimEnd()
        .split("\n")
        .map((line) => line.length),
    ),
  ).toBeLessThanOrEqual(50);
});

test("shared flag ordering, version output and completion generation still work", async () => {
  for (const args of [
    ["version", "--json"],
    ["--json", "version"],
    ["--json=true", "version"],
  ]) {
    const result = await cli(args);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ version: 1, data: "contremaitre 0.2.0" });
  }
  for (const shell of ["bash", "fish", "zsh"]) {
    const result = await cli(["--completions", shell]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("deploy");
    expect(result.stdout).toContain(shell === "fish" ? "-l rebuild" : "--rebuild");
    if (shell !== "fish") {
      const syntax = Bun.spawn([shell, "-n"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      syntax.stdin.write(result.stdout);
      syntax.stdin.end();
      expect(await new Response(syntax.stderr).text()).toBe("");
      expect(await syntax.exited).toBe(0);
    }
  }
});

test("entrypoint leaves help and unknown flags after -- with the service command", async () => {
  const result = await cli([
    "--home",
    "/tmp/no-such-contremaitre-home",
    "exec",
    "web",
    "--",
    "node",
    "--help",
    "--child-flag",
  ]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("ENOENT");
  expect(result.stderr).not.toContain("Unknown flag");
});
