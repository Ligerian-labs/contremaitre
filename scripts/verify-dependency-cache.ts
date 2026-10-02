// Opt-in native proof: bun scripts/verify-dependency-cache.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Apple, type RunSpec } from "@contremaitre/environments/apple";
import { Manager } from "@contremaitre/environments/manager";
import { Store } from "@contremaitre/environments/store";
import { type Context, context } from "@contremaitre/execution/context";
import { parseManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";

const home = mkdtempSync(join(tmpdir(), "cm-native-cache-"));
const root = join(home, "project");
mkdirSync(root);
const caches = new Set<string>();
class Runtime extends Apple {
  override async run(ctx: Context, spec: RunSpec) {
    for (const [volume, target] of Object.entries(spec.volumes))
      if (target === "/tmp/contremaitre-cache") caches.add(volume);
    await super.run(ctx, spec);
  }
}
const runtime = new Runtime();
const manager = new Manager(new Store(join(home, "state")), runtime);
const manifest = parseManifest(`version: 1
project: download-proof
services:
  api:
    image: node:24-bookworm-slim
    working_dir: /app
    command: [node, main.cjs]
    environment: {FAIL_ONCE: 'true'}
    ready: ["true"]
    dev: {source: '.', target: /app, install: [corepack, pnpm, install]}
`);
writeFileSync(
  join(root, "package.json"),
  JSON.stringify({
    name: "download-proof",
    private: true,
    packageManager: "pnpm@10.34.4",
    dependencies: { "is-number": "7.0.0" },
    scripts: { postinstall: "node install.cjs" },
  }),
);
writeFileSync(
  join(root, "install.cjs"),
  `const fs=require('node:fs');if(process.env.FAIL_ONCE==='true'&&!fs.existsSync('.install-attempt')){fs.writeFileSync('.install-attempt','partial install retained');process.exit(17)}`,
);
writeFileSync(
  join(root, "main.cjs"),
  "if(!require('is-number')(42))process.exit(1);setInterval(()=>{},1000)",
);
const timings: Record<string, number> = {};
let attempt = 0;
const logs: string[] = [];
const ctx = context(AbortSignal.timeout(600_000), (chunk) => {
  const text = chunk.toString();
  logs.push(text);
  process.stderr.write(text);
});
const deploy = async (branch: string) => {
  const started = performance.now();
  try {
    await manager.deploy(ctx, {
      root,
      identity: newIdentity(manifest.project, root, branch),
      manifest,
      request: {},
    });
  } finally {
    timings[`${branch}-${++attempt}`] = (performance.now() - started) / 1000;
  }
};
try {
  await assert.rejects(deploy("failed"), /exit 17|ELIFECYCLE/);
  await deploy("failed");
  const first = manager.resolve(newIdentity(manifest.project, root, "failed").ID);
  assert.equal(
    (await runtime.exec(ctx, first.Services.api.Container, ["cat", "/app/.install-attempt"]))
      .toString()
      .trim(),
    "partial install retained",
  );
  await runtime.exec(ctx, first.Services.api.Container, [
    "sh",
    "-c",
    "echo local > /app/isolation-sentinel",
  ]);
  await manager.stopDevelopment();
  const dev = manifest.services.api.dev;
  assert(dev);
  manifest.services.api = {
    ...manifest.services.api,
    environment: { FAIL_ONCE: "false" },
    dev: { ...dev, install: ["corepack", "pnpm", "install", "--offline"] },
  };
  const offset = logs.length;
  await deploy("warm-offline");
  const warm = manager.resolve(newIdentity(manifest.project, root, "warm-offline").ID);
  await runtime.exec(ctx, warm.Services.api.Container, [
    "test",
    "!",
    "-e",
    "/app/isolation-sentinel",
  ]);
  await runtime.exec(ctx, warm.Services.api.Container, [
    "sh",
    "-c",
    "COREPACK_ENABLE_NETWORK=0 corepack pnpm --version",
  ]);
  await runtime.exec(ctx, warm.Services.api.Container, [
    "node",
    "-e",
    "if(!require('is-number')(42))process.exit(1)",
  ]);
  assert.match(logs.slice(offset).join(""), /reused 1, downloaded 0/);
  assert.equal(caches.size, 1);
  await manager.stopDevelopment();
  await runtime.exec(ctx, warm.Services.api.Container, [
    "sh",
    "-c",
    "echo reset > /app/rebuild-sentinel",
  ]);
  const rebuildStarted = performance.now();
  await manager.deploy(ctx, {
    root,
    identity: warm.Identity,
    manifest,
    request: { rebuild: true },
  });
  timings.rebuild = (performance.now() - rebuildStarted) / 1000;
  await runtime.exec(ctx, warm.Services.api.Container, [
    "test",
    "!",
    "-e",
    "/app/rebuild-sentinel",
  ]);
  // Simulate a successful pre-cache deployment, whose modules reference a
  // source-local pnpm store and whose persisted state has no source identity.
  await runtime.exec(ctx, warm.Services.api.Container, [
    "sh",
    "-eu",
    "-c",
    "rm -rf /app/node_modules; corepack pnpm install --store-dir /app/legacy-store",
  ]);
  delete warm.Services.api.development_source;
  manager.save();
  await manager.stopDevelopment();
  const legacyStarted = performance.now();
  await manager.deploy(ctx, { root, identity: warm.Identity, manifest, request: {} });
  timings.legacy_upgrade = (performance.now() - legacyStarted) / 1000;
  await runtime.exec(ctx, warm.Services.api.Container, ["test", "!", "-e", "/app/legacy-store"]);
  await runtime.exec(ctx, warm.Services.api.Container, [
    "node",
    "-e",
    "if(!require('is-number')(42))process.exit(1)",
  ]);
  console.log(
    JSON.stringify({
      proof: "native dependency retry and offline cache reuse",
      home,
      environment_ids: [first.Identity.ID, warm.Identity.ID],
      timings_s: timings,
      shared_cache_volumes: [...caches],
      retry_source_retained: true,
      offline_reuse: true,
      corepack_startup_offline: true,
      source_isolation: true,
      rebuild_refreshes_source: true,
      legacy_store_upgrade: true,
    }),
  );
} finally {
  await manager.stopDevelopment();
  for (const env of manager.list())
    await manager.down(context(AbortSignal.timeout(60_000)), env, true);
  for (const volume of caches)
    await runtime.removeVolume(context(AbortSignal.timeout(30_000)), volume);
  rmSync(home, { recursive: true, force: true });
}
