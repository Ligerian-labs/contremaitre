import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevelopmentSource } from "@contremaitre/environments/development";
import { Manager } from "@contremaitre/environments/manager";
import { Store } from "@contremaitre/environments/store";
import { context } from "@contremaitre/execution/context";
import { parseManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";

test("development apps describe source, container working directory and install without a Dockerfile", () => {
  const manifest = parseManifest(`version: 1
project: monorepo
services:
  api:
    image: oven/bun:1.3.14
    working_dir: /app/apps/server
    command: [bun, --watch, src/main.ts]
    dev:
      source: .
      target: /app
      install: [bun, install, --frozen-lockfile]
`);
  expect(manifest.services.api.dev?.source).toBe(".");
  expect(manifest.services.api.working_dir).toBe("/app/apps/server");
  expect(manifest.services.api.memory).toBe("2G");
});

test("memory defaults preserve explicit limits and lightweight non-development services", () => {
  const manifest = parseManifest(`version: 1
project: resources
services:
  web:
    image: oven/bun:1.3.14
    memory: 3G
    working_dir: /app
    command: [bun, --watch, main.ts]
    dev: {source: '.', target: /app}
  mail: {image: axllent/mailpit}
  db: {kind: postgres}
`);
  expect(manifest.services.web.memory).toBe("3G");
  expect(manifest.services.mail.memory).toBe("512M");
  expect(manifest.services.db.memory).toBe("512M");
});

test("source sync propagates edits and deletes, freezes dependencies, and retains pending changes across restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-source-")),
    root = join(home, "project"),
    state = join(home, "state");
  mkdirSync(root);
  const dev = { source: ".", target: "/app" };
  try {
    writeFileSync(join(root, "main.ts"), "one");
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "host"), "host");
    writeFileSync(join(root, ".env.dev"), "SECRET=hidden");
    let source = new DevelopmentSource(root, state, dev);
    await source.refresh(context(), true);
    source.acknowledge();
    expect(existsSync(join(source.directory, "node_modules"))).toBe(false);
    expect(existsSync(join(source.directory, ".env.dev"))).toBe(false);
    writeFileSync(join(root, "main.ts"), "two");
    writeFileSync(join(root, "package.json"), '{"changed":true}');
    let changes = await source.refresh(context());
    expect(changes.changed).toEqual(["main.ts"]);
    expect(changes.dependenciesChanged).toBe(true);
    expect(readFileSync(join(source.directory, "package.json"), "utf8")).toBe("{}");
    source = new DevelopmentSource(root, state, dev);
    await source.load();
    changes = await source.refresh(context());
    expect(changes.changed).toContain("main.ts");
    source.acknowledge();
    rmSync(join(root, "main.ts"));
    expect((await source.refresh(context())).removed).toEqual(["main.ts"]);
    await source.refresh(context(), true);
    expect(readFileSync(join(source.directory, "package.json"), "utf8")).toBe('{"changed":true}');
    symlinkSync(join(home, "outside"), join(root, "escape"));
    writeFileSync(join(home, "outside"), "secret");
    await expect(source.refresh(context())).rejects.toThrow("escapes");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("development deployment installs before startup, resumes sync and stops it on down", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-dev-manager-")),
    root = join(home, "project");
  mkdirSync(root);
  writeFileSync(join(root, "main.ts"), "one");
  const runtime = new FakeRuntime();
  let manager = new Manager(new Store(join(home, "state")), runtime);
  const manifest = parseManifest(
    `version: 1\nproject: dev\nservices:\n  api:\n    image: oven/bun:1.3.14\n    working_dir: /app\n    command: [bun, --watch, main.ts]\n    dev: {source: '.', target: /app, install: [bun, install]}\n`,
  );
  const identity = newIdentity("dev", root, "main");
  const allocations: string[] = [];
  const run = runtime.run.bind(runtime);
  runtime.run = async (ctx, spec) => {
    allocations.push(spec.service.memory ?? "missing");
    await run(ctx, spec);
  };
  try {
    await manager.deploy(context(), { root, identity, manifest, request: {} });
    expect(allocations).toEqual(["2G", "2G"]);
    const env = manager.resolve(identity.ID);
    expect(runtime.calls.some((c) => c.includes("initial main.ts"))).toBe(true);
    expect(runtime.calls.indexOf(`run ${env.Services.api.Container}-task`)).toBeLessThan(
      runtime.calls.indexOf(`run ${env.Services.api.Container}`),
    );
    const installed = runtime.calls.filter(
      (c) => c === `run ${env.Services.api.Container}-task`,
    ).length;
    await manager.deploy(context(), { root, identity, manifest, request: {} });
    expect(runtime.calls.filter((c) => c === `run ${env.Services.api.Container}-task`).length).toBe(
      installed + 1,
    );
    await manager.stopDevelopment();
    manager = new Manager(new Store(join(home, "state")), runtime);
    await manager.recover(context());
    writeFileSync(join(root, "main.ts"), "two");
    await Bun.sleep(1400);
    expect(runtime.calls.some((c) => c.includes("live main.ts"))).toBe(true);
    await manager.down(context(), manager.resolve(identity.ID));
    const calls = runtime.calls.length;
    writeFileSync(join(root, "main.ts"), "three");
    await Bun.sleep(1200);
    expect(runtime.calls.length).toBe(calls);
    await manager.down(context(), manager.resolve(identity.ID), true);
    expect(existsSync(join(home, "state", "sources", identity.ID))).toBe(false);
  } finally {
    await manager.stopDevelopment();
    rmSync(home, { recursive: true, force: true });
  }
});

test("development validation rejects escaped paths, database dev and volume overlaps", () => {
  const wrap = (service: string) => `version: 1\nproject: dev\nservices:\n  api: ${service}\n`;
  expect(() =>
    parseManifest(
      wrap(
        "{image: node:22, working_dir: /app, command: [node], dev: {source: '../escape', target: /app}}",
      ),
    ),
  ).toThrow("dev.source");
  expect(() => parseManifest(wrap("{kind: postgres, dev: {source: '.', target: /app}}"))).toThrow(
    "only supported for apps",
  );
  expect(() =>
    parseManifest(
      wrap(
        "{image: node:22, working_dir: /app, command: [node], volumes: {data: /app/data}, dev: {source: '.', target: /app}}",
      ),
    ),
  ).toThrow("overlap");
});

test("source shape changes and a failed scan do not lose pending edits", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-source-shape-")),
    root = join(home, "project");
  mkdirSync(root);
  const source = new DevelopmentSource(root, join(home, "state"), { source: ".", target: "/app" });
  try {
    writeFileSync(join(root, "shape"), "one");
    await source.refresh(context(), true);
    source.acknowledge();
    rmSync(join(root, "shape"));
    mkdirSync(join(root, "shape"));
    writeFileSync(join(root, "shape", "child"), "two");
    let changes = await source.refresh(context());
    expect(changes.changed).toContain("shape/child");
    expect(changes.removed).toContain("shape");
    source.acknowledge();
    rmSync(join(root, "shape"), { recursive: true });
    writeFileSync(join(root, "shape"), "three");
    changes = await source.refresh(context());
    expect(changes.changed).toContain("shape");
    source.acknowledge();
    writeFileSync(join(root, "shape"), "four");
    writeFileSync(join(home, "outside"), "outside");
    symlinkSync(join(home, "outside"), join(root, "z-escape"));
    await expect(source.refresh(context())).rejects.toThrow("escapes");
    rmSync(join(root, "z-escape"));
    expect((await source.refresh(context())).changed).toContain("shape");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
