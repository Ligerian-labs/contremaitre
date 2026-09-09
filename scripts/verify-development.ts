// Opt-in native smoke test: bun scripts/verify-development.ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Apple } from "@contremaitre/environments/apple";
import { Manager } from "@contremaitre/environments/manager";
import { Store } from "@contremaitre/environments/store";
import { context } from "@contremaitre/execution/context";
import { parseManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";

const home = mkdtempSync(join(tmpdir(), "cm-native-dev-")),
  root = join(home, "project");
mkdirSync(root);
const ctx = context(AbortSignal.timeout(180_000), (data) => process.stderr.write(data));
const runtime = new Apple(),
  manager = new Manager(new Store(join(home, "state")), runtime);
const identity = newIdentity("dev-smoke", root, "main");
const source = (value: string) =>
  `console.log("${value}"); await Bun.write("generated.txt", "container"); setInterval(() => {}, 1000);`;
writeFileSync(join(root, "main.ts"), source("LIVE_ONE"));
writeFileSync(join(root, "delete-me.ts"), "delete me");
writeFileSync(join(root, "package.json"), '{"name":"smoke","version":"1.0.0"}');
const manifest = parseManifest(`version: 1
project: dev-smoke
services:
  api:
    image: oven/bun:1.3.4
    command: [bun, --watch, main.ts]
    working_dir: /app
    ready: ["true"]
    dev: {source: '.', target: /app, install: [bun, install]}
`);
try {
  await manager.deploy(ctx, { root, identity, manifest, request: {} });
  const container = manager.resolve(identity.ID).Services.api.Container;
  const waitLog = async (text: string) => {
    for (let i = 0; i < 20; i++) {
      const logs = (await runtime.output(ctx, ["logs", container])).toString();
      if (logs.includes(text)) return;
      await Bun.sleep(500);
    }
    throw Error(`Native watcher did not emit ${text}`);
  };
  await waitLog("LIVE_ONE");
  writeFileSync(join(root, "main.ts"), source("LIVE_TWO"));
  writeFileSync(join(root, "package.json"), '{"name":"changed"}');
  rmSync(join(root, "delete-me.ts"));
  await waitLog("LIVE_TWO");
  await runtime.exec(ctx, container, ["test", "!", "-e", "/app/delete-me.ts"]);
  const pkg = (await runtime.exec(ctx, container, ["cat", "/app/package.json"])).toString();
  if (pkg.includes("changed")) throw Error("Dependency manifest changed without redeploy");
  if (existsSync(join(root, "generated.txt"))) throw Error("Container wrote into checkout");
  await manager.stopDevelopment();
  await manager.recover(ctx);
  writeFileSync(join(root, "main.ts"), source("LIVE_THREE"));
  await waitLog("LIVE_THREE");
  await manager.deploy(ctx, { root, identity, manifest, request: {} });
  const redeployed = (await runtime.exec(ctx, container, ["cat", "/app/package.json"])).toString();
  if (!redeployed.includes("changed")) throw Error("Redeploy did not refresh dependency manifests");
  console.log(
    "Native Bun hot reload, deletion, dependency redeploy, checkout isolation and sync recovery passed.",
  );
} finally {
  await manager.stopDevelopment();
  const env = manager.state.Environments[identity.ID];
  if (env) await manager.down(context(AbortSignal.timeout(60_000)), env, true);
  rmSync(home, { recursive: true, force: true });
}
