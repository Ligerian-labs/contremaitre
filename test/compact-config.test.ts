import { expect, test } from "bun:test";
import {
  cpSync,
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
import { context } from "@contremaitre/execution/context";
import { assistedInit } from "@contremaitre/projects/assisted-init";
import { loadManifest } from "@contremaitre/projects/config";
import { initProject } from "@contremaitre/projects/init";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cm-compact-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "demo",
      packageManager: "bun@1.3.4",
      scripts: { dev: "bun --watch server.ts --port 3000" },
    }),
  );
  writeFileSync(join(root, "bun.lock"), "{}");
  return { root, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test("setup records Bun development conventions in a portable lock and leaves a compact config", () => {
  const f = fixture();
  try {
    const path = initProject(f.root);
    const config = readFileSync(path, "utf8");
    expect(config).toContain("apps:");
    expect(config).not.toContain("image:");
    expect(config).not.toContain("install:");
    expect(existsSync(join(f.root, "Dockerfile.contremaitre"))).toBe(false);
    const manifest = loadManifest(f.root);
    expect(manifest.services.app.image).toBe("oven/bun:1.3.4");
    expect(manifest.services.app.command).toEqual(["bun", "run", "dev"]);
    expect(manifest.services.app.dev?.install).toEqual(["bun", "install", "--frozen-lockfile"]);
    expect(readFileSync(join(f.root, ".contremaitre.lock"), "utf8")).not.toContain(f.root);
  } finally {
    f.clean();
  }
});

test("deploy refreshes explicit overrides without rediscovery and preserves the lock on failure", () => {
  const f = fixture();
  try {
    const path = initProject(f.root);
    const original = loadManifest(f.root);
    writeFileSync(join(f.root, "package.json"), "not json anymore");
    writeFileSync(
      path,
      "project: demo\napps:\n  app:\n    memory: 3G\n    environment: {LABEL: changed}\n",
    );
    const events: string[] = [];
    const updated = loadManifest(f.root, { refresh: true, log: (event) => events.push(event) });
    expect(updated.services.app.memory).toBe("3G");
    expect(updated.services.app.image).toBe(original.services.app.image);
    expect(updated.services.app.environment?.LABEL).toBe("changed");
    expect(events.join("\n")).toContain(".contremaitre.lock");
    const lock = readFileSync(join(f.root, ".contremaitre.lock"), "utf8");
    writeFileSync(path, "project: demo\napps: {app: {memory: wrong}}\n");
    expect(() => loadManifest(f.root, { refresh: true })).toThrow();
    expect(readFileSync(join(f.root, ".contremaitre.lock"), "utf8")).toBe(lock);
  } finally {
    f.clean();
  }
});

test("new unresolved apps require setup and env file secrets never enter the lock", () => {
  const f = fixture();
  try {
    const path = initProject(f.root);
    writeFileSync(join(f.root, ".env"), "TOKEN=never-in-lock\n");
    writeFileSync(path, "project: demo\napps: {app: {env_file: .env}}\n");
    loadManifest(f.root, { refresh: true });
    const lock = readFileSync(join(f.root, ".contremaitre.lock"), "utf8");
    expect(lock).not.toContain("never-in-lock");
    writeFileSync(path, "project: demo\napps: {app: {}, worker: {path: apps/worker}}\n");
    expect(() => loadManifest(f.root, { refresh: true })).toThrow("contremaitre init");
    expect(readFileSync(join(f.root, ".contremaitre.lock"), "utf8")).toBe(lock);
  } finally {
    f.clean();
  }
});

test("the committed pair works in another checkout without setup or installed package manifests", () => {
  const f = fixture(),
    copy = mkdtempSync(join(tmpdir(), "cm-portable-"));
  try {
    initProject(f.root);
    for (const file of [".contremaitre.yaml", ".contremaitre.lock"])
      cpSync(join(f.root, file), join(copy, file));
    const before = readFileSync(join(copy, ".contremaitre.lock"), "utf8");
    expect(loadManifest(copy).services.app.image).toBe("oven/bun:1.3.4");
    expect(readFileSync(join(copy, ".contremaitre.lock"), "utf8")).toBe(before);
  } finally {
    f.clean();
    rmSync(copy, { recursive: true, force: true });
  }
});

test("monorepo setup uses its existing runner once and detects named workspace ports", () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.root, "package.json"),
      JSON.stringify({
        name: "demo",
        packageManager: "bun@1.3.4",
        engines: { node: "^24.15.0 || >=26.0.0" },
        workspaces: ["apps/*"],
        scripts: { dev: "turbo run dev" },
      }),
    );
    for (const [name, port] of [
      ["api", 8000],
      ["viewer", 4200],
      ["admin", 4300],
    ] as const) {
      mkdirSync(join(f.root, "apps", name), { recursive: true });
      writeFileSync(
        join(f.root, "apps", name, "package.json"),
        JSON.stringify({ scripts: { dev: `serve --host 0.0.0.0 --port ${port}` } }),
      );
    }
    initProject(f.root);
    const manifest = loadManifest(f.root);
    expect(Object.keys(manifest.services)).toEqual(["app"]);
    expect(manifest.services.app.image).toBe("node:24.15.0");
    expect(manifest.services.app.command).toEqual(["npx", "--yes", "bun@1.3.4", "run", "dev"]);
    expect(manifest.services.app.endpoints).toEqual({ admin: 4300, api: 8000, viewer: 4200 });
  } finally {
    f.clean();
  }
});

test("assisted setup saves inferred launch settings separately and preserves distinct container mappings", async () => {
  const f = fixture();
  const manifest = `project: demo
apps:
  api:
    environment: {PORT: '8000', DATABASE_URL: '{{db.url}}', WEB_URL: '{{web.browser_url}}'}
  web:
    environment: {PORT: '4200'}
services:
  db: {kind: postgres}
`;
  const resolved = Object.fromEntries(
    ["api", "web"].map((name, index) => [
      name,
      {
        image: "oven/bun:1.3.4",
        command: ["bun", "run", "dev"],
        working_dir: "/app",
        dev: { source: ".", target: "/app", install: ["bun", "install", "--frozen-lockfile"] },
        endpoints: { [name]: index ? 4200 : 8000 },
      },
    ]),
  );
  try {
    await assistedInit(
      context(),
      f.root,
      async () => JSON.stringify({ type: "manifest", manifest, resolved }),
      { ask: async () => "Use these settings", note() {} },
      { lockDirectory: join(f.root, "init-lock") },
    );
    expect(readFileSync(join(f.root, ".contremaitre.yaml"), "utf8")).toBe(manifest);
    const loaded = loadManifest(f.root);
    expect(loaded.services.api.environment?.PORT).toBe("8000");
    expect(loaded.services.web.environment?.PORT).toBe("4200");
    expect(loaded.services.api.depends_on).toEqual(["db"]);
    expect(readFileSync(join(f.root, ".contremaitre.lock"), "utf8")).not.toContain("DATABASE_URL");
  } finally {
    f.clean();
  }
});

test("invalid or missing locks fail without overwriting state and queries never refresh a changed config", () => {
  const f = fixture();
  try {
    const path = initProject(f.root),
      lock = join(f.root, ".contremaitre.lock");
    const original = readFileSync(lock, "utf8");
    writeFileSync(path, "project: demo\napps: {app: {memory: 4G}}\n");
    expect(() => loadManifest(f.root)).toThrow("deploy");
    expect(readFileSync(lock, "utf8")).toBe(original);
    writeFileSync(lock, "broken");
    expect(() => loadManifest(f.root, { refresh: true })).toThrow("init");
    expect(readFileSync(lock, "utf8")).toBe("broken");
    rmSync(lock);
    expect(() => loadManifest(f.root, { refresh: true })).toThrow("Missing");
    expect(existsSync(lock)).toBe(false);
    writeFileSync(join(f.root, "foreign"), original);
    symlinkSync(join(f.root, "foreign"), lock);
    expect(() => loadManifest(f.root, { refresh: true })).toThrow("regular file");
    expect(readFileSync(join(f.root, "foreign"), "utf8")).toBe(original);
  } finally {
    f.clean();
  }
});

test("explicit endpoint overrides replace detection and deleting an override restores setup defaults", () => {
  const f = fixture();
  try {
    const path = initProject(f.root);
    writeFileSync(
      path,
      "project: demo\napps: {app: {image: 'oven/bun:1.4.2', endpoints: {api: 8000, web: 4200}}}\n",
    );
    expect(loadManifest(f.root, { refresh: true }).services.app.endpoints).toEqual({
      api: 8000,
      web: 4200,
    });
    writeFileSync(path, "project: demo\napps: {app: .}\n");
    const restored = loadManifest(f.root, { refresh: true });
    expect(restored.services.app.image).toBe("oven/bun:1.3.4");
    expect(restored.services.app.endpoints).toEqual({ app: 3000 });
  } finally {
    f.clean();
  }
});

test("explicit setup refreshes runtime detection while deploy only applies config changes", () => {
  const f = fixture();
  try {
    const path = initProject(f.root),
      original = readFileSync(path, "utf8");
    const packagePath = join(f.root, "package.json");
    writeFileSync(packagePath, readFileSync(packagePath, "utf8").replace("bun@1.3.4", "bun@1.4.2"));
    expect(loadManifest(f.root, { refresh: true }).services.app.image).toBe("oven/bun:1.3.4");
    initProject(f.root);
    expect(loadManifest(f.root).services.app.image).toBe("oven/bun:1.4.2");
    expect(readFileSync(path, "utf8")).toBe(original);
  } finally {
    f.clean();
  }
});

test("fully explicit new containers resolve without inspecting repository files", () => {
  const f = fixture();
  try {
    const path = initProject(f.root);
    writeFileSync(
      path,
      `project: demo
apps:
  app: .
  worker:
    image: oven/bun:1.3.4
    command: [bun, run, worker]
    working_dir: /app
    dev: {source: '.', target: /app}
    endpoints: {}
`,
    );
    rmSync(join(f.root, "package.json"));
    const resolved = loadManifest(f.root, { refresh: true });
    expect(resolved.services.worker.memory).toBe("2G");
    expect(loadManifest(f.root)).toEqual(resolved);
  } finally {
    f.clean();
  }
});

test("failed env resolution and inconsistent saved launch settings preserve the lock", () => {
  const f = fixture();
  try {
    const path = initProject(f.root),
      config = readFileSync(path, "utf8"),
      lockPath = join(f.root, ".contremaitre.lock");
    const original = readFileSync(lockPath, "utf8");
    writeFileSync(path, "project: demo\napps: {app: {env_file: .env.missing}}\n");
    expect(() => loadManifest(f.root, { refresh: true })).toThrow();
    expect(readFileSync(lockPath, "utf8")).toBe(original);
    writeFileSync(path, config);
    const edited = JSON.parse(original);
    edited.apps.app.resolved.image = "different-image";
    writeFileSync(lockPath, JSON.stringify(edited));
    expect(() => loadManifest(f.root)).toThrow("Inconsistent");
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(edited);
  } finally {
    f.clean();
  }
});
