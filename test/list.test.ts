import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "@contremaitre/execution/context";
import { startServer } from "@contremaitre/hub/server";
import { FakeRuntime } from "./fake-runtime.js";

const cliPath = fileURLToPath(new URL("../apps/cli/src/cli.ts", import.meta.url));
async function list(home: string, args: string[] = []) {
  const child = Bun.spawn([process.execPath, cliPath, "list", "--home", home, ...args], {
    cwd: home,
    env: { ...process.env, NO_COLOR: "1" },
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

test("list filters and orders the same environments in text and JSON without changing state", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-list-"));
  const runtime = new FakeRuntime();
  const hub = await startServer({ home, port: 0, runtime, skipSystemStart: true });
  try {
    const fixtures = [
      ["shop", "old", "stopped"],
      ["shop", "broken", "failed"],
      ["shop", "main", "running"],
      ["admin", "main", "running"],
      ["shop", "new", "pending"],
      ["shop", "build", "deploying"],
      ["shop", "pause", "stopping"],
      ["shop", "remove", "deleting"],
      ["shop", "feature/login", "running"],
    ];
    for (const [project, branch, status] of fixtures) {
      const root = join(home, project);
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, ".contremaitre.yaml"),
        `version: 1\nproject: ${project}\nservices:\n  web: {image: app}\n`,
      );
      const prepared = await hub.manager.prepare(context(), { root, branch });
      const env = hub.manager.fresh(prepared.identity, root);
      env.Status = status;
      hub.manager.state.Environments[env.Identity.ID] = env;
    }
    const before = JSON.stringify(hub.manager.state);
    const calls = [...runtime.calls];
    const cases: [string[], string[]][] = [
      [
        [],
        [
          "admin/main",
          "shop/feature/login",
          "shop/main",
          "shop/build",
          "shop/new",
          "shop/pause",
          "shop/remove",
          "shop/broken",
          "shop/old",
        ],
      ],
      [
        ["--status", "running"],
        ["admin/main", "shop/feature/login", "shop/main"],
      ],
      [["--project", "admin"], ["admin/main"]],
      [
        ["--branch", "main"],
        ["admin/main", "shop/main"],
      ],
      [["--branch=feature/login"], ["shop/feature/login"]],
      [
        ["--status", "stopped", "--status", "running", "--project", "shop", "--branch", "main"],
        ["shop/main"],
      ],
      [
        ["--status=stopped", "--status=failed"],
        ["shop/broken", "shop/old"],
      ],
      [["--status", "running", "--status", "running", "--project", "admin"], ["admin/main"]],
      [["--project", "sho"], []],
      [["--branch", "mai"], []],
      [["--status", "failed", "--project", "admin"], []],
    ];
    for (const [args, expected] of cases) {
      const plain = await list(home, args);
      expect(plain.code, `${args.join(" ")}: ${plain.stderr}`).toBe(0);
      expect(plain.stderr).toBe("");
      const json = await list(home, [...args, "--json"]);
      expect(json.code).toBe(0);
      expect(json.stderr).toBe("");
      const reply = JSON.parse(json.stdout);
      expect(reply.version).toBe(1);
      expect(
        reply.data.map(
          (env: { Identity: { Project: string; Branch: string } }) =>
            `${env.Identity.Project}/${env.Identity.Branch}`,
        ),
      ).toEqual(expected);
      expect(plain.stdout).toBe(
        reply.data
          .map(
            (env: { Identity: { ID: string; Name: string }; Status: string }) =>
              `${env.Identity.ID}\t${env.Status}\t${env.Identity.Name}\n`,
          )
          .join(""),
      );
    }
    expect(JSON.stringify(hub.manager.state)).toBe(before);
    expect(runtime.calls).toEqual(calls);
  } finally {
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);

test("list documents filters and rejects invalid statuses before contacting a hub", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-list-help-"));
  try {
    const help = await list(home, ["--help"]);
    expect(help.code).toBe(0);
    for (const flag of ["--status", "--project", "--branch"]) expect(help.stdout).toContain(flag);
    for (const args of [
      ["--status", "unknown"],
      ["--status", "running", "--status", "unknown"],
      ["--status"],
      ["--status", "--json"],
      ["--status="],
    ]) {
      const invalid = await list(home, args);
      expect(invalid.code).toBe(64);
      expect(invalid.stderr).not.toContain("ENOENT");
      if (args.includes("--json")) {
        expect(JSON.parse(invalid.stdout)).toEqual({
          version: 1,
          error: "--status requires a value. Run contremaitre list --help.",
        });
      } else expect(invalid.stdout).toBe("");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
