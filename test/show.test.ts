import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "@contremaitre/execution/context";
import { startServer } from "@contremaitre/hub/server";
import { FakeRuntime } from "./fake-runtime.js";

const cliPath = fileURLToPath(new URL("../apps/cli/src/cli.ts", import.meta.url));
async function show(home: string, cwd: string, args: string[] = []) {
  const child = Bun.spawn([process.execPath, cliPath, "show", "--home", home, ...args], {
    cwd,
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

test("show exposes deployment paths and log commands while preserving the JSON URL map", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-show-' space-"));
  const root = join(home, "project"),
    nested = join(root, "src");
  mkdirSync(nested, { recursive: true });
  writeFileSync(
    join(root, ".contremaitre.yaml"),
    `version: 1
project: example
services:
  admin: {image: app, http: true, port: 3000, ready: ["true"]}
  web: {image: app, http: true, port: 4200, ready: ["true"]}
  worker: {image: app, ready: ["true"], environment: {SECRET: hidden}}
`,
  );
  const runtime = new FakeRuntime();
  const hub = await startServer({
    home,
    port: 0,
    publicPort: 9080,
    runtime,
    skipSystemStart: true,
  });
  try {
    for (const branch of ["workspace", "feature"]) {
      await hub.manager.deploy(context(), await hub.manager.prepare(context(), { root, branch }));
    }
    const current = hub.manager.list().find((env) => env.Identity.Branch === "workspace");
    const feature = hub.manager.list().find((env) => env.Identity.Branch === "feature");
    if (!current || !feature) throw Error("Missing deployed test environments");
    const urls = (host: string) => ({
      admin: `http://${host}:9080`,
      web: `http://web.${host}:9080`,
    });
    const before = [...runtime.calls];
    const plain = await show(home, nested);
    expect(plain.code).toBe(0);
    expect(plain.stderr).toBe("");
    expect(plain.stdout).toContain(`Workspace: ${current.Root}\n`);
    expect(plain.stdout).toContain(`Hub data: ${home}\n`);
    expect(plain.stdout).toContain(
      `admin\thttp://${current.Identity.Host}:9080\nweb\thttp://web.${current.Identity.Host}:9080\n`,
    );
    expect(plain.stdout).not.toContain("hidden");
    expect(plain.stdout).not.toContain("Driver directory:");
    const logCommands = plain.stdout.split("\n").filter((line) => line.startsWith("contremaitre "));
    expect(logCommands).toHaveLength(4);
    for (const [index, command] of logCommands.entries()) {
      const parsed = Bun.spawn(["/bin/sh", "-c", `printf '%s\\n' ${command}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect((await new Response(parsed.stdout).text()).trimEnd().split("\n")).toEqual([
        "contremaitre",
        ...(index < 3 ? ["logs", ["admin", "web", "worker"][index]] : ["deploy", "logs"]),
        "--env",
        current.Identity.ID,
        "--home",
        home,
      ]);
      expect(await parsed.exited).toBe(0);
    }
    const json = await show(home, root, ["--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ version: 1, data: urls(current.Identity.Host) });
    const branch = await show(home, nested, ["--branch", "feature", "--json"]);
    expect(branch.code).toBe(0);
    expect(JSON.parse(branch.stdout).data).toEqual(urls(feature.Identity.Host));
    const explicit = await show(home, home, ["--env", feature.Identity.ID, "--json"]);
    expect(explicit.code).toBe(0);
    expect(JSON.parse(explicit.stdout).data).toEqual(urls(feature.Identity.Host));
    const selected = hub.manager.resolve(feature.Identity.ID);
    selected.driver_directory = join(home, "drivers", feature.Identity.ID);
    const selectedPlain = await show(home, home, ["--env", feature.Identity.ID]);
    expect(selectedPlain.code).toBe(0);
    expect(selectedPlain.stdout).toContain(`Workspace: ${feature.Root}\n`);
    expect(selectedPlain.stdout).toContain(`Driver directory: ${selected.driver_directory}\n`);
    expect(selectedPlain.stdout).toContain(`--env ${feature.Identity.ID}`);
    expect(selectedPlain.stdout).not.toContain(current.Identity.ID);
    expect((await show(home, nested, ["--branch", "feature"])).stdout).toBe(selectedPlain.stdout);
    const missing = await show(home, root, ["--branch", "missing"]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("not found");
    expect(runtime.calls).toEqual(before);
    const env = hub.manager.resolve(current.Identity.ID);
    env.Services.admin.HTTP = false;
    env.Services.web.HTTP = false;
    const noHTTP = await show(home, nested);
    expect(noHTTP.stdout).toContain("No HTTP service URLs for this environment.\n");
    expect(noHTTP.stdout).toContain(`Workspace: ${current.Root}\n`);
    expect(noHTTP.stdout).toContain("contremaitre logs worker");
    expect(JSON.parse((await show(home, nested, ["--json"])).stdout).data).toEqual({});
  } finally {
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);
