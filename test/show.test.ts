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

test("show selects the current directory, supports overrides and prints only HTTP URLs", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-show-"));
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
    expect(plain).toEqual({
      code: 0,
      stderr: "",
      stdout: `admin\thttp://${current.Identity.Host}:9080\nweb\thttp://web.${current.Identity.Host}:9080\n`,
    });
    const json = await show(home, root, ["--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ version: 1, data: urls(current.Identity.Host) });
    const branch = await show(home, nested, ["--branch", "feature", "--json"]);
    expect(branch.code).toBe(0);
    expect(JSON.parse(branch.stdout).data).toEqual(urls(feature.Identity.Host));
    const explicit = await show(home, home, ["--env", feature.Identity.ID, "--json"]);
    expect(explicit.code).toBe(0);
    expect(JSON.parse(explicit.stdout).data).toEqual(urls(feature.Identity.Host));
    const missing = await show(home, root, ["--branch", "missing"]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("not found");
    expect(runtime.calls).toEqual(before);
    const env = hub.manager.resolve(current.Identity.ID);
    env.Services.admin.HTTP = false;
    env.Services.web.HTTP = false;
    expect((await show(home, nested)).stdout).toBe("No HTTP service URLs for this environment.\n");
    expect(JSON.parse((await show(home, nested, ["--json"])).stdout).data).toEqual({});
  } finally {
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);
