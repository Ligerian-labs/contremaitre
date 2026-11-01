import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "@contremaitre/environments/manager";
import type { RunSpec } from "@contremaitre/environments/runtimes";
import { runtimeRegistry } from "@contremaitre/environments/runtimes";
import { Store } from "@contremaitre/environments/store";
import type { Context } from "@contremaitre/execution/context";
import { context } from "@contremaitre/execution/context";
import { parseManifest, prepareManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";

class RecordingRuntime extends FakeRuntime {
  runs: { spec: RunSpec; env: string }[] = [];
  async run(ctx: Context, spec: RunSpec) {
    this.runs.push({ spec, env: readFileSync(spec.envFile, "utf8") });
    await super.run(ctx, spec);
    if (!spec.task)
      this.containers.set(spec.name, { Host: `127.0.0.${this.runs.length + 1}`, Running: true });
  }
}

class HostRuntime extends RecordingRuntime {
  readonly capabilities = {
    network: "host" as const,
    development: "mount" as const,
    clone: "files" as const,
  };
  async preflight() {}
  async build() {
    return { digest: "component", image: "web.wasm" };
  }
  async ready() {
    return true;
  }
  async run(ctx: Context, spec: RunSpec) {
    await super.run(ctx, spec);
    this.containers.set(spec.name, { Host: "127.0.0.1", Running: true });
  }
}

function fixture(wasm = false) {
  const base = process.env.CONTREMAITRE_HOME ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const home = mkdtempSync(join(base, "redeploy-")),
    root = join(home, "project"),
    runtime = wasm ? new HostRuntime() : new RecordingRuntime(),
    registry = runtimeRegistry({ home, apple: runtime }),
    manager = new Manager(
      new Store(home),
      runtime,
      49099,
      "http",
      wasm
        ? {
            apple: registry.apple,
            docker: registry.docker,
            wasm: { app: runtime as HostRuntime, postgres: runtime as HostRuntime },
          }
        : registry,
    );
  mkdirSync(root);
  const prepare = (value = "first", services?: string) => ({
    root,
    identity: newIdentity("redeploy", root, "main"),
    manifest: prepareManifest(
      root,
      parseManifest(`version: 1
project: redeploy
services:
${
  services ??
  `  db: {kind: postgres${wasm ? ", runtime: wasm" : ""}}
  web:
${wasm ? "    runtime: wasm\n    wasm: {component: web.wasm}\n" : '    image: nginx\n    ready: ["true"]\n'}    port: 8000
    depends_on: [db]
    environment: {DATABASE_URL: '{{db.url}}', VALUE: '${value}'}
`
}`),
    ),
    request: {},
  });
  return {
    runtime,
    manager,
    prepare,
    clean: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

for (const wasm of [false, true]) {
  test(`${wasm ? "WASM" : "Apple"} stopped services redeploy with the current Postgres URL`, async () => {
    const f = fixture(wasm);
    try {
      const p = f.prepare();
      await f.manager.deploy(context(), p);
      const env = f.manager.resolve(p.identity.ID),
        oldHost = env.Services.db.Host,
        volumes = [...env.Volumes],
        password = env.credentials?.db;
      await f.manager.down(context(), env);
      expect(env.Status).toBe("stopped");
      expect(env.Services.db.Host).toBe("");
      expect(env.Services.web.Host).toBe("");
      await f.manager.deploy(context(), p);
      expect(env.Status).toBe("running");
      expect(env.Volumes).toEqual(volumes);
      expect(env.credentials?.db).toBe(password);
      for (const name of ["db", "web"])
        expect(
          f.runtime.runs.filter((r) => r.spec.name === env.Services[name].Container),
        ).toHaveLength(2);
      const db = env.Services.db,
        port = wasm ? db.Ports?.["5432"] : 5432;
      if (wasm) {
        expect(db.Host).toBe("127.0.0.1");
        expect(typeof port).toBe("number");
        expect(port).toBeGreaterThan(0);
      } else expect(db.Host).not.toBe(oldHost);
      const expected = `postgresql://app:${password}@${db.Host}:${port}/app?sslmode=disable`;
      expect(f.runtime.runs.at(-1)?.env.split("\n")).toContain(`DATABASE_URL=${expected}`);
    } finally {
      f.clean();
    }
  });
}

test("running services with a Postgres URL retain unchanged dependencies", async () => {
  const f = fixture();
  try {
    const p = f.prepare();
    await f.manager.deploy(context(), p);
    const env = f.manager.resolve(p.identity.ID);
    f.runtime.calls = [];
    await f.manager.deploy(context(), p);
    expect(f.runtime.calls.filter((c) => /^(run|stop) /.test(c))).toEqual([]);
    await f.manager.deploy(context(), f.prepare("changed"));
    expect(f.runtime.calls.filter((c) => /^(run|stop) /.test(c))).toEqual([
      `stop ${env.Services.web.Container}`,
      `run ${env.Services.web.Container}`,
    ]);
    expect(f.runtime.runs.filter((r) => r.spec.name === env.Services.db.Container)).toHaveLength(1);
  } finally {
    f.clean();
  }
});

test("redeploy restarts a running dependent after recovery clears its dead dependency's Host", async () => {
  const f = fixture();
  try {
    const p = f.prepare();
    await f.manager.deploy(context(), p);
    const env = f.manager.resolve(p.identity.ID),
      oldDBHost = env.Services.db.Host,
      webHost = env.Services.web.Host;
    // Recovery produces and persists the partial-address state after db dies.
    await f.runtime.stop(context(), env.Services.db.Container);
    await f.manager.recover(context());
    expect(env.Status).toBe("failed");
    expect(env.Services.db.Host).toBe("");
    expect(env.Services.web.Host).toBe(webHost);
    expect(webHost).not.toBe("");
    f.runtime.calls = [];
    await f.manager.deploy(context(), p);
    expect(env.Status).toBe("running");
    expect(env.Services.db.Host).not.toBe(oldDBHost);
    expect(f.runtime.calls.filter((c) => c.startsWith("run "))).toEqual([
      `run ${env.Services.db.Container}`,
      `run ${env.Services.web.Container}`,
    ]);
    for (const name of ["db", "web"])
      expect(
        f.runtime.runs.filter((r) => r.spec.name === env.Services[name].Container),
      ).toHaveLength(2);
    const expected = `postgresql://app:${env.credentials?.db}@${env.Services.db.Host}:5432/app?sslmode=disable`;
    expect(f.runtime.runs.at(-1)?.env.split("\n")).toContain(`DATABASE_URL=${expected}`);
  } finally {
    f.clean();
  }
});

const shared = `  db: {kind: postgres}
  web:
    image: nginx
    port: 8000
    http: true
    ready: ["true"]
    depends_on: [db]
    environment: {DATABASE_URL: '{{db.url}}', ORIGIN: '{{web.browser_url}}'}
`;

for (const leftover of [false, true]) {
  test(`a failed tunnel recovery does not block redeploy after down${leftover ? " with a configuration left by an older hub" : ""}`, async () => {
    const f = fixture();
    try {
      const p = f.prepare("first", shared);
      await f.manager.deploy(context(), p);
      const env = f.manager.resolve(p.identity.ID),
        local = f.manager.localURL(env, "web");
      // A hub that stopped while sharing journals the public URLs for recovery.
      env.tunnel_configuration = { urls: { web: "https://web.example.test" }, pending: [] };
      const run = f.runtime.run.bind(f.runtime);
      f.runtime.run = async (ctx, spec) => {
        if (spec.name === env.Services.web.Container) throw Error("simulated restart failure");
        return run(ctx, spec);
      };
      await f.manager.recover(context());
      expect(env.Status).toBe("failed");
      expect(env.Error).toStartWith("Tunnel configuration recovery failed");
      f.runtime.run = run;
      await f.manager.down(context(), env);
      expect(env.Status).toBe("stopped");
      expect(env.tunnel_configuration).toBeUndefined();
      if (leftover) env.tunnel_configuration = { urls: {}, pending: ["web"] };
      await f.manager.recover(context());
      expect(env.Status).toBe("stopped");
      expect(env.Error).toBe("");
      expect(env.tunnel_configuration).toBeUndefined();
      await f.manager.deploy(context(), p);
      expect(env.Status).toBe("running");
      const values = f.runtime.runs.at(-1)?.env.split("\n");
      expect(values).toContain(
        `DATABASE_URL=postgresql://app:${env.credentials?.db}@${env.Services.db.Host}:5432/app?sslmode=disable`,
      );
      expect(values).toContain(`ORIGIN=${local}`);
    } finally {
      f.clean();
    }
  });
}

const chain = `  db: {kind: postgres}
  api:
    image: nginx
    port: 8000
    ready: ["true"]
    depends_on: [db]
    environment: {DATABASE_URL: '{{db.url}}'}
  web:
    image: nginx
    port: 8000
    ready: ["true"]
    depends_on: [api]
    environment: {DATABASE_URL: '{{db.url}}', API_URL: '{{api.url}}'}
`;

for (const webDies of [false, true]) {
  test(`transitive dependency recovery restarts the chain with web ${webDies ? "dead" : "alive"}`, async () => {
    const f = fixture();
    try {
      const p = f.prepare("first", chain);
      await f.manager.deploy(context(), p);
      const env = f.manager.resolve(p.identity.ID),
        oldDBHost = env.Services.db.Host,
        apiHost = env.Services.api.Host,
        webHost = env.Services.web.Host;
      await f.runtime.stop(context(), env.Services.db.Container);
      if (webDies) await f.runtime.stop(context(), env.Services.web.Container);
      await f.manager.recover(context());
      expect(env.Status).toBe("failed");
      expect(env.Services.db.Host).toBe("");
      expect(env.Services.api.Host).toBe(apiHost);
      expect(env.Services.web.Host).toBe(webDies ? "" : webHost);
      f.runtime.calls = [];
      await f.manager.deploy(context(), p);
      expect(env.Status).toBe("running");
      expect(env.Services.db.Host).not.toBe(oldDBHost);
      expect(f.runtime.calls.filter((c) => c.startsWith("run "))).toEqual(
        ["db", "api", "web"].map((name) => `run ${env.Services[name].Container}`),
      );
      const expected = `postgresql://app:${env.credentials?.db}@${env.Services.db.Host}:5432/app?sslmode=disable`;
      expect(f.runtime.runs.at(-1)?.env.split("\n")).toContain(`DATABASE_URL=${expected}`);
    } finally {
      f.clean();
    }
  });
}

test("one missing Host among multiple dependencies restarts web with both current URLs", async () => {
  const f = fixture();
  try {
    const p = f.prepare(
      "first",
      `  db: {kind: postgres}
  cache: {kind: redis}
  web:
    image: nginx
    port: 8000
    ready: ["true"]
    depends_on: [db, cache]
    environment: {DATABASE_URL: '{{db.url}}', CACHE_URL: '{{cache.url}}'}
`,
    );
    await f.manager.deploy(context(), p);
    const env = f.manager.resolve(p.identity.ID),
      dbHost = env.Services.db.Host,
      oldCacheHost = env.Services.cache.Host,
      webHost = env.Services.web.Host;
    await f.runtime.stop(context(), env.Services.cache.Container);
    await f.manager.recover(context());
    expect(env.Status).toBe("failed");
    expect(env.Services.db.Host).toBe(dbHost);
    expect(env.Services.cache.Host).toBe("");
    expect(env.Services.web.Host).toBe(webHost);
    f.runtime.calls = [];
    await f.manager.deploy(context(), p);
    expect(env.Status).toBe("running");
    expect(env.Services.cache.Host).not.toBe(oldCacheHost);
    expect(f.runtime.calls.filter((c) => c.startsWith("run "))).toEqual([
      `run ${env.Services.cache.Container}`,
      `run ${env.Services.web.Container}`,
    ]);
    const values = f.runtime.runs.at(-1)?.env.split("\n");
    expect(values).toContain(
      `DATABASE_URL=postgresql://app:${env.credentials?.db}@${dbHost}:5432/app?sslmode=disable`,
    );
    expect(values).toContain(`CACHE_URL=redis://${env.Services.cache.Host}:6379/0`);
  } finally {
    f.clean();
  }
});

test("a live dependency whose Host moved restarts web with its new URL", async () => {
  const f = fixture();
  try {
    const p = f.prepare();
    await f.manager.deploy(context(), p);
    const env = f.manager.resolve(p.identity.ID),
      oldHost = env.Services.db.Host;
    f.runtime.containers.set(env.Services.db.Container, { Host: "127.0.9.9", Running: true });
    expect(env.Services.db.Host).toBe(oldHost);
    f.runtime.calls = [];
    await f.manager.deploy(context(), p);
    expect(env.Status).toBe("running");
    expect(env.Services.db.Host).not.toBe(oldHost);
    expect(f.runtime.calls.filter((c) => c.startsWith("run "))).toEqual([
      `run ${env.Services.db.Container}`,
      `run ${env.Services.web.Container}`,
    ]);
    const expected = `postgresql://app:${env.credentials?.db}@${env.Services.db.Host}:5432/app?sslmode=disable`;
    expect(f.runtime.runs.at(-1)?.env.split("\n")).toContain(`DATABASE_URL=${expected}`);
  } finally {
    f.clean();
  }
});

test("recovery redeploy resolves a Postgres URL through four dependency edges", async () => {
  const f = fixture();
  try {
    const p = f.prepare(
      "first",
      `  db: {kind: postgres}
  a: {image: nginx, port: 8001, ready: ["true"], depends_on: [db]}
  b: {image: nginx, port: 8002, ready: ["true"], depends_on: [a]}
  c: {image: nginx, port: 8003, ready: ["true"], depends_on: [b]}
  web: {image: nginx, port: 8000, ready: ["true"], depends_on: [c], environment: {DB: '{{db.url}}'}}
`,
    );
    await f.manager.deploy(context(), p);
    const env = f.manager.resolve(p.identity.ID),
      oldDBHost = env.Services.db.Host,
      names = ["db", "a", "b", "c", "web"];
    await f.runtime.stop(context(), env.Services.db.Container);
    await f.manager.recover(context());
    expect(env.Status).toBe("failed");
    expect(env.Services.db.Host).toBe("");
    for (const name of names.slice(1)) expect(env.Services[name].Host).not.toBe("");
    f.runtime.calls = [];
    await f.manager.deploy(context(), p);
    expect(env.Status).toBe("running");
    expect(env.Services.db.Host).not.toBe(oldDBHost);
    expect(f.runtime.calls.filter((c) => c.startsWith("run "))).toEqual(
      names.map((name) => `run ${env.Services[name].Container}`),
    );
    const expected = `postgresql://app:${env.credentials?.db}@${env.Services.db.Host}:5432/app?sslmode=disable`;
    expect(f.runtime.runs.at(-1)?.env.split("\n")).toContain(`DB=${expected}`);
  } finally {
    f.clean();
  }
});
