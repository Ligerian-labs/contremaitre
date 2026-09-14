import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { call } from "@contremaitre/cli/client";
import { requestSchema } from "@contremaitre/environments/model";
import { context, decode, message } from "@contremaitre/execution/context";
import { startServer } from "@contremaitre/hub/server";
import { newIdentity } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";

const cliPath = fileURLToPath(new URL("../apps/cli/src/cli.ts", import.meta.url));
async function prune(home: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cliPath, "prune", "--home", home, ...args], {
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

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cm-prune-"));
  const runtime = new FakeRuntime();
  const hub = await startServer({ home, port: 0, runtime, skipSystemStart: true });
  const envs = ["first", "second", "third", "fourth"].map((branch) => {
    const root = join(home, branch);
    const env = hub.manager.fresh(newIdentity("example", root, branch), root);
    env.Status = "running";
    env.Images = [`old-${branch}`, `current-${branch}`];
    env.builds = { web: { image: `current-${branch}`, digest: branch } };
    env.Volumes = [`volume-${branch}`];
    hub.manager.state.Environments[env.Identity.ID] = env;
    mkdirSync(join(home, "data", env.Identity.ID), { recursive: true });
    writeFileSync(join(home, "data", env.Identity.ID, "sentinel"), "retained");
    return env;
  });
  return {
    home,
    runtime,
    hub,
    envs,
    close: async () => {
      await hub.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("prune resolves every selector before cleanup and prunes each selected environment once", async () => {
  const f = await fixture();
  try {
    const help = await prune(f.home, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("[ENV...]");
    expect(help.stdout).toContain("contremaitre prune id1 id2 id3");
    const before = JSON.stringify(f.hub.manager.state);
    for (const invalid of ["missing", "example"]) {
      const result = await prune(f.home, [f.envs[0].Identity.ID, invalid, "--delete-data"]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/not found|Ambiguous/);
      expect(f.runtime.calls).toEqual([]);
      expect(f.hub.operations.list()).toEqual([]);
      expect(JSON.stringify(f.hub.manager.state)).toBe(before);
    }
    const result = await prune(f.home, [
      ...f.envs.slice(0, 3).map((env) => env.Identity.ID),
      f.envs[0].Identity.Name,
      "--json",
    ]);
    expect(result).toEqual({
      code: 0,
      stderr: "",
      stdout: '{"version":1,"data":"Prune complete"}\n',
    });
    expect(f.runtime.calls.sort()).toEqual([
      "remove image old-first",
      "remove image old-second",
      "remove image old-third",
    ]);
    expect(f.envs.map((env) => env.Images)).toEqual([
      ["current-first"],
      ["current-second"],
      ["current-third"],
      ["old-fourth", "current-fourth"],
    ]);
    expect(f.hub.operations.list()).toHaveLength(3);
    expect(Object.keys(f.hub.manager.state.Environments)).toHaveLength(4);
    expect((await prune(f.home, [f.envs[3].Identity.ID])).code).toBe(0);
    expect(f.envs[3].Images).toEqual(["current-fourth"]);
  } finally {
    await f.close();
  }
});

test("selected prune delete-data preserves unselected, running and tunnel-reserved environments", async () => {
  const f = await fixture();
  try {
    f.envs[0].Status = f.envs[1].Status = f.envs[3].Status = "stopped";
    f.envs[3].tunnels = {
      web: {
        Provider: "test",
        ID: "reserved",
        URL: "https://example.test",
        Desired: false,
        Connected: false,
      },
    };
    const result = await prune(f.home, [
      f.envs[0].Identity.ID,
      f.envs[2].Identity.ID,
      f.envs[3].Identity.ID,
      "--delete-data",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(f.envs.map((env) => !!f.hub.manager.state.Environments[env.Identity.ID])).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(
      f.envs.map((env) => existsSync(join(f.home, "data", env.Identity.ID, "sentinel"))),
    ).toEqual([false, true, true, true]);
    expect(f.envs[1].Images).toEqual(["old-second", "current-second"]);
    expect(f.runtime.calls.filter((c) => c.startsWith("remove volume"))).toEqual([
      "remove volume volume-first",
    ]);
    expect((await prune(f.home, ["--delete-data"])).code).toBe(0);
    expect(f.envs.map((env) => !!f.hub.manager.state.Environments[env.Identity.ID])).toEqual([
      false,
      false,
      true,
      true,
    ]);
  } finally {
    await f.close();
  }
});

test("unqualified prune still removes old images globally and preserves data", async () => {
  const f = await fixture();
  try {
    expect((await prune(f.home, [])).code).toBe(0);
    expect(f.runtime.calls.sort()).toEqual([
      "remove image old-first",
      "remove image old-fourth",
      "remove image old-second",
      "remove image old-third",
    ]);
    expect(Object.keys(f.hub.manager.state.Environments)).toHaveLength(4);
    expect(
      f.envs.every((env) => existsSync(join(f.home, "data", env.Identity.ID, "sentinel"))),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("prune rejects empty and malformed selection payloads without pruning globally", async () => {
  const f = await fixture();
  try {
    for (const envs of [[], [""], "first", [23]]) {
      await expect(call(context(), f.home, "prune", { envs, delete_data: true })).rejects.toThrow();
      expect(f.runtime.calls).toEqual([]);
      expect(f.hub.operations.list()).toEqual([]);
    }
  } finally {
    await f.close();
  }
});

test("selected prune skips busy environments and still cleans the other selections", async () => {
  const f = await fixture();
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const busy = f.hub.operations.submit(
    f.envs[0].Identity.ID,
    "hold",
    [f.envs[0].Identity.ID],
    () => pending,
  );
  try {
    const result = await prune(f.home, [f.envs[0].Identity.ID, f.envs[1].Identity.ID]);
    expect(result.code, result.stderr).toBe(0);
    expect(f.runtime.calls).toEqual(["remove image old-second"]);
    expect(f.envs[0].Images).toEqual(["old-first", "current-first"]);
  } finally {
    release();
    await f.hub.operations.wait(busy.id);
    await f.close();
  }
});

test("selected prune does not fall back to global cleanup on an older hub", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-old-prune-"));
  const paths: string[] = [];
  let globalPrunes = 0;
  const server = Bun.serve({
    unix: join(home, "hub.sock"),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      try {
        // Older hubs validate prune with the shared request schema, which rejects envs.
        decode(requestSchema, await request.json(), "request");
        globalPrunes++;
        return Response.json({ version: 1, data: "Prune complete" });
      } catch (error) {
        return Response.json({ version: 1, error: message(error) });
      }
    },
  });
  try {
    const result = await prune(home, ["id1", "id2", "id3", "--delete-data"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Invalid request");
    expect(paths).toEqual(["/v1/prune"]);
    expect(globalPrunes).toBe(0);
  } finally {
    await server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});
