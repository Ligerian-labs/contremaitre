import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCacheEnvironment, packageInstaller } from "@contremaitre/environments/development";
import { Manager } from "@contremaitre/environments/manager";
import { Store } from "@contremaitre/environments/store";
import { context } from "@contremaitre/execution/context";
import { parseManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cm-cache-"));
  const root = join(home, "project");
  mkdirSync(root);
  writeFileSync(join(root, "package.json"), "{}");
  const runtime = new FakeRuntime();
  const manager = new Manager(new Store(join(home, "state")), runtime);
  const manifest = parseManifest(`version: 1
project: cache
services:
  api:
    image: node:24-bookworm-slim
    working_dir: /app
    command: [node, main.js]
    ready: ["true"]
    dev: {source: '.', target: /app, install: [corepack, pnpm, install]}
`);
  return {
    home,
    root,
    runtime,
    manager,
    manifest,
    deploy: (branch: string, signal?: AbortSignal) =>
      manager.deploy(context(signal), {
        root,
        identity: newIdentity("cache", root, branch),
        manifest,
        request: {},
      }),
    clean: async () => {
      await manager.stopDevelopment();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("package cache detection preserves custom commands, flags and explicit settings", () => {
  expect(
    installCacheEnvironment(["pnpm", "install"], { XDG_CACHE_HOME: "/explicit" })?.values
      .XDG_CACHE_HOME,
  ).toBe("/explicit");
  expect(packageInstaller(["sh", "-c", "pnpm install"])).toBeUndefined();
  expect(packageInstaller(["corepack", "pnpm", "exec", "install"])).toBeUndefined();
  expect(installCacheEnvironment(["pnpm", "install", "--store-dir=/own"], {})).toBeUndefined();
  expect(
    installCacheEnvironment(["pnpm", "install"], { NPM_CONFIG_STORE_DIR: "/own" }),
  ).toBeUndefined();
  expect(
    installCacheEnvironment(["pnpm", "install"], { pnpm_config_store_dir: "/own" }),
  ).toBeUndefined();
  expect(installCacheEnvironment(["npm", "ci"], {})?.values).toEqual({
    npm_config_cache: "/tmp/contremaitre-cache/npm",
  });
  expect(installCacheEnvironment(["bun", "install"], {})?.values).toEqual({
    BUN_INSTALL_CACHE_DIR: "/tmp/contremaitre-cache/bun",
  });
});

test("explicit project cache configuration and Corepack home remain authoritative", async () => {
  const f = fixture();
  writeFileSync(join(f.root, ".npmrc"), "store-dir=/app/my-store\n");
  f.manifest.services.api = {
    ...f.manifest.services.api,
    environment: { COREPACK_HOME: "/app/custom-corepack" },
  };
  const start = f.runtime.run.bind(f.runtime);
  f.runtime.run = async (ctx, spec) => {
    if (spec.task) {
      expect(Object.values(spec.volumes)).not.toContain("/tmp/contremaitre-cache");
      expect(readFileSync(spec.envFile, "utf8")).toContain("COREPACK_HOME=/app/custom-corepack");
      expect(spec.timeout).toBe(1_800_000);
    }
    await start(ctx, spec);
  };
  try {
    await f.deploy("main");
  } finally {
    await f.clean();
  }
});

test("cache lock serializes installs and waits for cancelled guest cleanup before retry", async () => {
  const f = fixture();
  const controller = new AbortController();
  let entered!: () => void;
  const firstEntered = new Promise<void>((r) => {
    entered = r;
  });
  let releaseCleanup!: () => void;
  const cleanupReleased = new Promise<void>((r) => {
    releaseCleanup = r;
  });
  let cleanupEntered!: () => void;
  const cleanupStarted = new Promise<void>((r) => {
    cleanupEntered = r;
  });
  let firstTask = "",
    installCount = 0;
  const start = f.runtime.run.bind(f.runtime),
    remove = f.runtime.remove.bind(f.runtime);
  f.runtime.run = async (ctx, spec) => {
    if (spec.task) {
      installCount++;
      if (installCount === 1) {
        firstTask = spec.name;
        entered();
        await new Promise<void>((_, reject) =>
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true }),
        );
      }
    }
    await start(ctx, spec);
  };
  f.runtime.remove = async (ctx, name) => {
    if (name === firstTask && controller.signal.aborted) {
      cleanupEntered();
      await cleanupReleased;
    }
    await remove(ctx, name);
  };
  const first = f.deploy("main", controller.signal).catch((e) => e);
  let second: Promise<void> | undefined;
  try {
    await firstEntered;
    second = f.deploy("branch");
    await Bun.sleep(50);
    expect(installCount).toBe(1);
    controller.abort(Error("cancel install"));
    await cleanupStarted;
    await Bun.sleep(50);
    expect(installCount).toBe(1);
    releaseCleanup();
    expect((await first).message).toContain("cancel install");
    await second;
    expect(installCount).toBe(2);
  } finally {
    controller.abort();
    releaseCleanup();
    await first;
    await second?.catch(() => {});
    await f.clean();
  }
});

test("failed cleanup blocks reuse of a possibly mounted cache", async () => {
  const f = fixture();
  let task = "";
  const start = f.runtime.run.bind(f.runtime),
    remove = f.runtime.remove.bind(f.runtime);
  f.runtime.run = async (ctx, spec) => {
    if (spec.task) {
      task = spec.name;
      throw Error("installation failed");
    }
    await start(ctx, spec);
  };
  f.runtime.remove = async (ctx, name) => {
    if (name === task) throw Error("cannot remove guest");
    await remove(ctx, name);
  };
  try {
    await expect(f.deploy("first")).rejects.toThrow("cannot remove guest");
    await expect(f.deploy("second")).rejects.toThrow("Dependency cache task cleanup failed");
  } finally {
    await f.clean();
  }
});

test("Structure development/install-retry scenario exercises deployment through hub commands", async () => {
  const { dependencyRetryFixture } = await import("./dependency-fixture.js");
  const proof = await dependencyRetryFixture();
  expect(proof.scenario).toBe("development/install-retry");
  expect(proof.environment).toMatch(/^[a-f0-9]{16}$/);
});

test("hub recovery removes a persisted installer lease before another environment can use its cache", async () => {
  const f = fixture();
  let leased = "";
  const start = f.runtime.run.bind(f.runtime);
  f.runtime.run = async (ctx, spec) => {
    if (spec.task) {
      const env = Object.values(f.manager.state.Environments).find(
        (e) => `${e.Services.api?.Container}-task` === spec.name,
      );
      expect(env?.Services.api.dependency_cache).toBeString();
      leased = env?.Services.api.dependency_cache ?? "";
    }
    await start(ctx, spec);
  };
  let recovered: Manager | undefined;
  try {
    await f.deploy("main");
    await f.manager.stopDevelopment();
    const env = f.manager.list()[0];
    if (!env) throw Error("Missing fixture environment");
    const stored = f.manager.resolve(env.Identity.ID);
    expect(stored.Services.api.dependency_cache).toBeUndefined();
    stored.Services.api.dependency_cache = leased;
    stored.Status = "deploying";
    f.manager.save();
    recovered = new Manager(new Store(join(f.home, "state")), f.runtime);
    const before = f.runtime.calls.length;
    await recovered.recover(context());
    expect(f.runtime.calls.slice(before)).toContain(`remove ${stored.Services.api.Container}-task`);
    expect(recovered.resolve(env.Identity.ID).Services.api.dependency_cache).toBeUndefined();
  } finally {
    await recovered?.stopDevelopment();
    await f.clean();
  }
});
