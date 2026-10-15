import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager, type PreparedDeploy } from "@contremaitre/environments/manager";
import {
  addressURL,
  type Environment,
  type ServiceState,
  serviceAddress,
} from "@contremaitre/environments/model";
import {
  type CloneSide,
  type Inspection,
  type RunSpec,
  type RuntimeRegistry,
  runtimeRegistry,
  type ServiceRuntime,
} from "@contremaitre/environments/runtimes";
import { Store } from "@contremaitre/environments/store";
import { type Context, context, hash } from "@contremaitre/execution/context";
import { routes } from "@contremaitre/hub/server";
import { parseManifest, prepareManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";

/** A host-process runtime that listens on its reserved loopback ports. */
class FakeHostRuntime implements ServiceRuntime {
  readonly capabilities = {
    network: "host" as const,
    development: "mount" as const,
    clone: "files" as const,
  };
  calls: string[] = [];
  specs = new Map<string, RunSpec>();
  servers = new Map<string, Server[]>();
  clones: [CloneSide, CloneSide][] = [];
  readyChecks: string[] = [];
  digest = "component";
  failBuilds = new Set<string>();
  failRuns = new Set<string>();
  started: string[] = [];
  async preflight() {
    this.calls.push("preflight");
  }
  async build(_ctx: Context, request: { name: string; root: string }) {
    this.calls.push(`build ${request.name}`);
    if (this.failBuilds.has(request.name)) throw Error(`${request.name} build failed`);
    return { digest: this.digest, image: join(request.root, `${request.name}.wasm`) };
  }
  async run(_ctx: Context, spec: RunSpec) {
    this.calls.push(`run ${spec.name}`);
    if (this.failRuns.has(spec.name)) throw Error("process failed to start");
    this.specs.set(spec.name, {
      ...spec,
      environment: readFileSync(spec.envFile, "utf8"),
    } as never);
    const servers: Server[] = [];
    for (const port of Object.values(spec.ports ?? {}))
      servers.push(
        await new Promise<Server>((resolve) => {
          const server = createServer((socket) => socket.end());
          server.listen(port, "127.0.0.1", () => resolve(server));
        }),
      );
    this.servers.set(spec.name, servers);
    this.started.push(spec.name);
  }
  async inspect(_ctx: Context, name: string): Promise<Inspection | undefined> {
    return this.servers.has(name) ? { Host: "127.0.0.1", Running: true } : undefined;
  }
  async start() {
    throw Error("host processes restart through run");
  }
  async stop(_ctx: Context, name: string) {
    this.calls.push(`stop ${name}`);
    await this.close(name);
  }
  async remove(_ctx: Context, name: string) {
    await this.close(name);
  }
  async logs() {}
  async ready(_ctx: Context, service: ServiceState, address: { host: string; port: number }) {
    this.readyChecks.push(`${service.Name} ${address.host}:${address.port}`);
    return true;
  }
  async clone(_ctx: Context, from: CloneSide, to: CloneSide) {
    this.calls.push(`clone ${from.service.Name}`);
    this.clones.push([from, to]);
    writeFileSync(join(to.data, "copied"), readFileSync(join(from.data, "marker")));
  }
  async close(name: string) {
    for (const server of this.servers.get(name) ?? [])
      await new Promise<void>((resolve) => server.close(() => resolve()));
    this.servers.delete(name);
  }
  async closeAll() {
    for (const name of [...this.servers.keys()]) await this.close(name);
  }
}
const mixed = `version: 1
project: example
services:
  cache: {kind: redis}
  db: {kind: postgres, runtime: wasm}
  web:
    runtime: wasm
    wasm: {build: [make, web], component: web.wasm}
    port: 8080
    http: true
    depends_on: [db, cache]
    environment: {DATABASE_URL: '{{db.url}}', DB_PORT: '{{db.port}}', REDIS_URL: '{{cache.url}}'}
    dev: {source: src}
`;
function fixture(text = mixed) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cm-runtimes-"))),
    root = join(home, "project");
  mkdirSync(join(root, "src"), { recursive: true });
  const apple = new FakeRuntime(),
    host = new FakeHostRuntime(),
    store = new Store(home),
    base = runtimeRegistry({ home: store.home, apple }),
    registry: RuntimeRegistry = { apple: base.apple, wasm: { app: host, postgres: host } },
    manager = new Manager(store, apple, 8080, "http", registry);
  let manifest = text;
  const prepare = (branch = "main"): PreparedDeploy => ({
    root,
    identity: newIdentity("example", root, branch),
    manifest: prepareManifest(root, parseManifest(manifest)),
    request: {},
    sourceId: manager.state.Main.example,
  });
  return {
    home,
    root,
    apple,
    host,
    manager,
    prepare,
    setManifest: (next: string) => {
      manifest = next;
    },
    clean: async () => {
      await host.closeAll();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
const invalid = (text: string) => () => parseManifest(`version: 1\nproject: example\n${text}`);
test("manifests default to Apple and validate WASM services", () => {
  const apple = parseManifest(
    "version: 1\nproject: example\nservices:\n  db: {kind: postgres}\n  web: {image: nginx, port: 80}\n",
  );
  expect(apple.services.web.runtime).toBeUndefined();
  expect(apple.services.db.image).toBe("postgres:17");
  const wasm = parseManifest(mixed);
  expect(wasm.services.db.image).toBe("");
  expect(wasm.services.web.wasm?.component).toBe("web.wasm");
  expect(invalid("services:\n  c: {kind: redis, runtime: wasm}")).toThrow(
    "c: kind redis does not support runtime: wasm",
  );
  expect(invalid("services:\n  db: {kind: postgres, runtime: wasm, image: postgres:17}")).toThrow(
    "db: runtime: wasm does not use image",
  );
  expect(invalid("services:\n  web: {runtime: wasm, port: 80}")).toThrow(
    "web: runtime: wasm requires wasm.component",
  );
  expect(invalid("services:\n  web: {runtime: wasm, wasm: {component: a.wasm}}")).toThrow(
    "web: runtime: wasm requires a port",
  );
  expect(
    invalid("services:\n  web: {runtime: wasm, build: ., wasm: {component: a.wasm}, port: 80}"),
  ).toThrow("web: build is not supported with runtime: wasm");
  expect(
    invalid("services:\n  web: {runtime: wasm, wasm: {component: a.wasm}, port: 80, migrate: [x]}"),
  ).toThrow("web: migrate is not supported with runtime: wasm");
  expect(
    invalid("services:\n  web: {runtime: wasm, wasm: {component: ../a.wasm}, port: 80}"),
  ).toThrow("web: wasm paths must stay within project");
  expect(invalid("services:\n  web: {image: nginx, wasm: {component: a.wasm}}")).toThrow(
    "web: wasm requires runtime: wasm",
  );
  expect(
    invalid(
      "services:\n  db: {kind: postgres, runtime: wasm}\n  web: {image: nginx, depends_on: [db]}",
    ),
  ).toThrow("web: Apple container services cannot reach WASM service db");
  expect(
    invalid(
      "services:\n  web: {runtime: wasm, wasm: {component: a.wasm}, port: 80}\nverification:\n  profiles:\n    smoke: [{name: t, command: [x], service: web}]",
    ),
  ).toThrow("t: service checks run inside a container");
  expect(
    invalid("services:\n  web: {image: nginx, command: [x], dev: {source: .}, working_dir: /a}"),
  ).toThrow("web: invalid dev.target");
});
test("an older state file upgrades to Apple runtimes with its address", () => {
  const home = mkdtempSync(join(tmpdir(), "cm-runtimes-state-")),
    identity = newIdentity("example", home, "main");
  try {
    const store = new Store(home);
    const service = {
      Name: "web",
      Container: "c",
      Image: "nginx",
      IP: "192.168.64.5",
      Volume: "",
      Port: 80,
      HTTP: true,
      Initialized: true,
      Spec: { kind: "app", image: "nginx", port: 80, http: true },
    };
    writeFileSync(
      join(home, "state.json"),
      JSON.stringify({
        Version: 1,
        Environments: {
          [identity.ID]: {
            Identity: identity,
            Root: home,
            Status: "running",
            Error: "",
            Network: `${store.namespace()}-${identity.ID}`,
            Services: { web: service },
            Images: [],
            Volumes: [],
            CloneComplete: true,
            CreatedAt: "2026-09-08T00:00:00Z",
            UpdatedAt: "2026-09-08T00:00:00Z",
          },
        },
        Main: {},
      }),
    );
    const loaded = store.load().Environments[identity.ID].Services.web;
    expect(loaded.Host).toBe("192.168.64.5");
    expect(loaded.Runtime).toBe("apple");
    expect("IP" in loaded).toBe(false);
    expect(serviceAddress(loaded, 80)).toEqual({ host: "192.168.64.5", port: 80 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test("mixed environments address host runtimes by reserved loopback ports", async () => {
  const f = fixture();
  try {
    const p = f.prepare();
    await f.manager.deploy(context(), p);
    const env = f.manager.resolve(p.identity.ID);
    expect(env.Status).toBe("running");
    const { db, web, cache } = env.Services;
    expect([db.Runtime, web.Runtime, cache.Runtime]).toEqual(["wasm", "wasm", "apple"]);
    expect(db.Host).toBe("127.0.0.1");
    expect(cache.Host).toBe("127.0.0.1");
    const dbPort = db.Ports?.["5432"] ?? 0,
      webPort = web.Ports?.["8080"] ?? 0;
    expect(dbPort).toBeGreaterThan(0);
    expect(dbPort).not.toBe(5432);
    expect(webPort).not.toBe(dbPort);
    expect(f.host.calls).toContain("preflight");
    expect(f.host.calls).toContain("build web");
    expect(web.Image).toBe(join(f.root, "web.wasm"));
    expect(env.Images).toEqual([]);
    expect(f.host.readyChecks).toContain(`db 127.0.0.1:${dbPort}`);
    const run = f.host.specs.get(web.Container) as RunSpec & { environment: string };
    expect(run.ports).toEqual({ "8080": webPort });
    expect(run.source).toBe(join(f.root, "src"));
    expect(run.data).toBe(join(f.home, "data", env.Identity.ID, ".services", "web"));
    expect(existsSync(run.data ?? "")).toBe(true);
    expect(run.environment).toContain(
      `DATABASE_URL=postgresql://app:${env.credentials?.db}@127.0.0.1:${dbPort}/app?sslmode=disable`,
    );
    expect(run.environment).toContain(`DB_PORT=${dbPort}`);
    expect(run.environment).toContain("REDIS_URL=redis://127.0.0.1:6379/0");
    // Host runtimes neither sync dev source nor use the container Postgres volume.
    expect(f.apple.calls.some((c) => c.startsWith("sync "))).toBe(false);
    expect(env.Volumes).toEqual([]);
    const route = routes(f.manager, new URL(f.manager.localURL(env, "web")).hostname);
    expect(route?.upstream).toBe(`http://127.0.0.1:${webPort}`);
    expect(addressURL(serviceAddress(web, 8080) ?? { host: "", port: 0 })).toBe(
      `http://127.0.0.1:${webPort}`,
    );
    // A redeploy keeps reservations and retained services.
    f.host.calls = [];
    await f.manager.deploy(context(), p);
    expect(env.Services.db.Ports).toEqual({ "5432": dbPort });
  } finally {
    await f.clean();
  }
});
test("changing a recorded runtime fails before any mutation", async () => {
  const f = fixture();
  try {
    const p = f.prepare();
    await f.manager.deploy(context(), p);
    const env = f.manager.resolve(p.identity.ID);
    f.setManifest(mixed.replace("db: {kind: postgres, runtime: wasm}", "db: {kind: postgres}"));
    f.host.calls = [];
    f.apple.calls = [];
    await expect(f.manager.deploy(context(), f.prepare())).rejects.toThrow(
      "db: runtime changed from wasm to apple; Contremaitre does not convert services",
    );
    expect(env.Status).toBe("running");
    expect(env.Services.db.Runtime).toBe("wasm");
    expect([...f.host.calls, ...f.apple.calls].filter((c) => /^(stop|run|build)/.test(c))).toEqual(
      [],
    );
  } finally {
    await f.clean();
  }
});
test("placeholder WASM runtimes fail clearly and leave the environment deletable", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-runtimes-placeholder-")),
    root = join(home, "project");
  mkdirSync(join(root, "src"), { recursive: true });
  const manager = new Manager(new Store(home), new FakeRuntime());
  try {
    const identity = newIdentity("example", root, "main");
    await expect(
      manager.deploy(context(), {
        root,
        identity,
        manifest: prepareManifest(root, parseManifest(mixed)),
        request: {},
      }),
    ).rejects.toThrow("WASM app runtime not available yet");
    const env = manager.resolve(identity.ID);
    expect(env.Error).toContain("WASM postgres runtime not available yet");
    await manager.down(context(), env, true);
    expect(manager.list()).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test("file-level Postgres clone quiesces main and restarts both servers", async () => {
  const f = fixture();
  try {
    const main = f.prepare();
    await f.manager.deploy(context(), main);
    const source = f.manager.resolve(main.identity.ID);
    writeFileSync(join(f.manager.dataDirectory(source, source.Services.db), "marker"), "main");
    f.host.calls = [];
    const feature = f.prepare("feature");
    await f.manager.deploy(context(), feature);
    const target = f.manager.resolve(feature.identity.ID);
    expect(target.CloneComplete).toBe(true);
    const [from, to] = f.host.clones[0];
    expect(from.data).toBe(join(f.home, "data", source.Identity.ID, ".services", "db"));
    expect(to.data).toBe(join(f.home, "data", target.Identity.ID, ".services", "db"));
    expect(readFileSync(join(to.data, "copied"), "utf8")).toBe("main");
    const stopped = f.host.calls.indexOf(`stop ${source.Services.db.Container}`),
      cloned = f.host.calls.indexOf("clone db");
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(f.host.calls.indexOf(`stop ${target.Services.db.Container}`)).toBeLessThan(cloned);
    expect(stopped).toBeLessThan(cloned);
    expect(f.host.calls.lastIndexOf(`run ${source.Services.db.Container}`)).toBeGreaterThan(cloned);
    expect(f.host.calls.lastIndexOf(`run ${target.Services.db.Container}`)).toBeGreaterThan(cloned);
    expect(source.Services.db.Host).toBe("127.0.0.1");
    expect(target.Status).toBe("running");
    expect(existsSync(join(f.home, "recovery", `${target.Identity.ID}.json`))).toBe(false);
  } finally {
    await f.clean();
  }
});
test("cloning between different Postgres runtimes fails clearly", async () => {
  const f = fixture(
    'version: 1\nproject: example\nservices:\n  db: {kind: postgres}\n  web: {image: nginx, port: 80, ready: ["true"], depends_on: [db]}\n',
  );
  try {
    await f.manager.deploy(context(), f.prepare());
    f.setManifest(mixed);
    await expect(f.manager.deploy(context(), f.prepare("feature"))).rejects.toThrow(
      "Clone db: main uses runtime apple and this environment uses wasm",
    );
  } finally {
    await f.clean();
  }
});
test("a rebuilt WASM artifact at the same path replaces the running service", async () => {
  const f = fixture(mixed.replace("    dev: {source: src}\n", ""));
  try {
    const p = f.prepare();
    await f.manager.deploy(context(), p);
    const env = f.manager.resolve(p.identity.ID);
    f.host.calls = [];
    await f.manager.deploy(context(), p);
    expect(f.host.calls.filter((c) => /^(stop|run) /.test(c))).toEqual([]);
    f.host.digest = "rebuilt";
    await f.manager.deploy(context(), p);
    expect(env.builds?.web.digest).toBe("rebuilt");
    expect(f.host.calls).toContain(`run ${env.Services.web.Container}`);
    expect(f.host.calls).not.toContain(`run ${env.Services.db.Container}`);
  } finally {
    await f.clean();
  }
});
test("Apple deployment fingerprints keep their pre-runtime shape", async () => {
  const f = fixture(
    'version: 1\nproject: example\nservices:\n  db: {kind: postgres}\n  web: {image: nginx, port: 80, ready: ["true"], depends_on: [db]}\n',
  );
  try {
    const p = f.prepare();
    await f.manager.deploy(context(), p);
    const env = f.manager.resolve(p.identity.ID),
      { db, web } = env.Services;
    // The formula used before per-service runtimes, with the container IP as host.
    expect(web.deployment).toBe(
      hash(
        JSON.stringify([
          web.Image,
          web.Spec,
          f.manager.serviceEnv(env, web),
          [["db", db.Host, db.Port]],
        ]),
      ),
    );
  } finally {
    await f.clean();
  }
});
interface RecoveryCase {
  name: string;
  manifest: string;
  /** Leave the environment as a crashed hub would, after a successful deployment. */
  crash: (
    f: ReturnType<typeof fixture>,
    env: Environment,
    occupy: (port: number) => Promise<void>,
  ) => Promise<void>;
  status: string;
  error?: string;
  /** Host services started by recovery, in order. */
  restarted: string[];
  /** Expected environment text per service after recovery; PORT is db's current port. */
  environment?: Record<string, string>;
  /** A second recovery and a redeploy start nothing. */
  retained?: boolean;
}
const pair = `version: 1
project: example
services:
  db: {kind: postgres, runtime: wasm}
  web: {runtime: wasm, wasm: {component: web.wasm}, port: 8080, depends_on: [db], environment: {DATABASE_URL: '{{db.url}}'}}
`;
const chain = `version: 1
project: example
services:
  db: {kind: postgres, runtime: wasm}
  relay: {runtime: wasm, wasm: {component: relay.wasm}, port: 8080, depends_on: [db]}
  web: {runtime: wasm, wasm: {component: web.wasm}, port: 8081, depends_on: [relay], environment: {DATABASE_URL: '{{db.url}}'}}
`;
const moveService = async (
  f: ReturnType<typeof fixture>,
  env: Environment,
  occupy: (port: number) => Promise<void>,
  name = "db",
) => {
  await f.host.close(env.Services[name].Container);
  await occupy(env.Services[name].Ports?.["5432"] ?? 0);
};
const recoveryCases: RecoveryCase[] = [
  {
    name: "stopped host services restart in dependency order",
    manifest: mixed,
    crash: (f) => f.host.closeAll(),
    status: "running",
    restarted: ["db", "web"],
  },
  {
    name: "a dependency back on its port leaves consumers running",
    manifest: pair,
    crash: (f, env) => f.host.close(env.Services.db.Container),
    status: "running",
    restarted: ["db"],
    retained: true,
  },
  {
    name: "a moved dependency restarts its direct consumer with the new address",
    manifest: pair,
    crash: moveService,
    status: "running",
    restarted: ["db", "web"],
    environment: { web: "@127.0.0.1:PORT/app" },
    retained: true,
  },
  {
    name: "a moved dependency reaches transitive address consumers",
    manifest: chain,
    crash: moveService,
    status: "running",
    restarted: ["db", "relay", "web"],
    environment: { web: "@127.0.0.1:PORT/app" },
    retained: true,
  },
  {
    name: "built-in URL tokens do not reference a service named contremaitre",
    manifest: `version: 1
project: example
services:
  contremaitre: {kind: postgres, runtime: wasm}
  web: {runtime: wasm, wasm: {component: web.wasm}, port: 8080, http: true, environment: {SELF: '{{contremaitre.url}}'}}
  site: {image: nginx, port: 80, http: true, ready: ["true"], environment: {SELF: '{{contremaitre.url}}'}}
`,
    crash: (f, env, occupy) => moveService(f, env, occupy, "contremaitre"),
    status: "running",
    restarted: ["contremaitre"],
    retained: true,
  },
  {
    name: "an artifact recorded by a failed deployment stays inactive",
    manifest: `version: 1
project: example
services:
  db: {kind: postgres, runtime: wasm}
  one: {runtime: wasm, wasm: {component: one.wasm}, port: 8080}
  two: {runtime: wasm, wasm: {component: two.wasm}, port: 8081, depends_on: [db], environment: {DATABASE_URL: '{{db.url}}'}}
`,
    crash: async (f, env) => {
      f.host.digest = "v2";
      f.host.failBuilds.add("two");
      await expect(f.manager.deploy(context(), f.prepare())).rejects.toThrow("two build failed");
      await f.host.close(env.Services.db.Container);
    },
    status: "running",
    // The failed deployment's error stays recorded; recovery doesn't clear it.
    error: "two: two build failed",
    restarted: ["db"],
  },
  {
    name: "a missing Apple dependency fails the environment without aborting recovery",
    manifest: `version: 1
project: example
services:
  apple-db: {kind: postgres}
  db: {kind: postgres, runtime: wasm}
  web:
    runtime: wasm
    wasm: {component: web.wasm}
    port: 8080
    depends_on: [apple-db, db]
    environment: {APPLE_URL: '{{apple-db.url}}', DATABASE_URL: '{{db.url}}'}
`,
    crash: async (f, env) => {
      await f.apple.remove(context(), env.Services["apple-db"].Container);
      await f.host.close(env.Services.db.Container);
    },
    status: "failed",
    error: "apple-db is not running",
    restarted: ["db"],
  },
  {
    name: "a failed host restart fails the environment and stops recovery",
    manifest: pair,
    crash: async (f, env) => {
      await f.host.closeAll();
      f.host.failRuns.add(env.Services.db.Container);
    },
    status: "failed",
    error: "db is not running: process failed to start",
    restarted: [],
  },
  {
    name: "an interrupted deployment fails without restarting",
    manifest: pair,
    crash: async (f, env) => {
      await f.host.closeAll();
      env.Status = "deploying";
    },
    status: "failed",
    error: "Interrupted operation",
    restarted: [],
  },
  {
    name: "a stopped environment stays stopped",
    manifest: pair,
    crash: (f, env) => f.manager.down(context(), env),
    status: "stopped",
    restarted: [],
  },
];
for (const c of recoveryCases)
  test(`hub recovery: ${c.name}`, async () => {
    const f = fixture(c.manifest);
    const blockers: Server[] = [];
    const occupy = async (port: number) => {
      blockers.push(
        await new Promise<Server>((resolve) => {
          const server = createServer();
          server.listen(port, "127.0.0.1", () => resolve(server));
        }),
      );
    };
    try {
      const p = f.prepare();
      await f.manager.deploy(context(), p);
      const env = f.manager.resolve(p.identity.ID);
      const container = (name: string) => env.Services[name].Container;
      await c.crash(f, env, occupy);
      f.host.started = [];
      f.apple.calls = [];
      await f.manager.recover(context());
      expect(env.Status).toBe(c.status);
      if (c.error) expect(env.Error).toContain(c.error);
      else expect(env.Error).toBe("");
      expect(f.host.started).toEqual(c.restarted.map(container));
      // Recovery never replaces Apple processes.
      expect(f.apple.calls.filter((call) => /^(stop|run|remove) /.test(call))).toEqual([]);
      for (const [name, text] of Object.entries(c.environment ?? {})) {
        const port = String(env.Services.db.Ports?.["5432"]);
        const run = f.host.specs.get(container(name)) as RunSpec & { environment: string };
        expect(run.environment).toContain(text.replace("PORT", port));
      }
      if (c.retained) {
        f.host.started = [];
        await f.manager.recover(context());
        await f.manager.deploy(context(), p);
        expect(f.host.started).toEqual([]);
      }
    } finally {
      for (const server of blockers)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.clean();
    }
  });
