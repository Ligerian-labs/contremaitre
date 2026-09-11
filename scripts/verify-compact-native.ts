import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Apple } from "@contremaitre/environments/apple";
import { Manager } from "@contremaitre/environments/manager";
import { Store } from "@contremaitre/environments/store";
import { context } from "@contremaitre/execution/context";
import { routes } from "@contremaitre/hub/server";
import { closeServer, listen, proxyServer } from "@contremaitre/routing/proxy";

// Explicit native smoke test. Owns a temporary project, state, network and
// containers; it never starts, stops or reconfigures the user's hub.
const directory = mkdtempSync(join(tmpdir(), "cm-compact-native-"));
const root = join(directory, "project");
cpSync(join(import.meta.dir, "..", "examples", "development"), root, { recursive: true });
let manager: Manager;
const proxy = proxyServer((host) => routes(manager, host));
const port = await listen(proxy, 0);
manager = new Manager(new Store(join(directory, "state")), new Apple(), port);
const ctx = context(AbortSignal.timeout(240_000), (data) => process.stdout.write(data));
try {
  const prepared = await manager.prepare(ctx, { root, branch: "smoke" });
  await manager.deploy(ctx, prepared);
  const env = manager.resolve(prepared.identity.ID);
  assert.equal(Object.keys(env.Services).length, 1);
  const request = async (name: string) => {
    const response = await fetch(`http://127.0.0.1:${port}`, {
      headers: { host: new URL(manager.localURL(env, name)).hostname },
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  assert.match(await request("api"), /API running in the shared application container/);
  assert.match(await request("web"), /One container, two endpoints/);
  assert((await request("web")).includes(manager.localURL(env, "api")));

  const source = join(root, "server.ts");
  writeFileSync(
    source,
    readFileSync(source, "utf8").replace("API running", "Reloaded API running"),
  );
  const deadline = Date.now() + 15_000;
  let reloaded = false;
  while (Date.now() < deadline) {
    await Bun.sleep(300);
    try {
      reloaded = (await request("api")).includes("Reloaded API running");
    } catch {}
    if (reloaded) break;
  }
  assert(reloaded, "Source edits must reload the grouped application");

  const config = join(root, ".contremaitre.yaml");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace("  app:\n", "  app:\n    memory: 3G\n"),
  );
  const next = await manager.prepare(ctx, { root, branch: "smoke" });
  assert.equal(next.manifest.services.app.memory, "3G");
  assert(next.configurationLog?.some((line) => line.includes("Refreshed .contremaitre.lock")));
  await manager.deploy(ctx, next);
  const saved = JSON.parse(readFileSync(join(root, ".contremaitre.lock"), "utf8"));
  assert.equal(saved.apps.app.resolved.memory, "3G");
  assert.match(await request("api"), /Reloaded API running/);
  assert.match(await request("web"), /One container, two endpoints/);
  console.log(
    "Native compact config verified: one container, two HTTP routes, source reload and automatic lock refresh.",
  );
} finally {
  await manager.stopDevelopment();
  try {
    for (const env of Object.values(manager.state.Environments))
      await manager.down(context(AbortSignal.timeout(90_000)), env, true);
    rmSync(directory, { recursive: true, force: true });
  } finally {
    await closeServer(proxy);
  }
}
