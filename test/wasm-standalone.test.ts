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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@contremaitre/cli/client";
import { Apple } from "@contremaitre/environments/apple";
import { Manager } from "@contremaitre/environments/manager";
import type { Environment } from "@contremaitre/environments/model";
import {
  type CloneSide,
  type Inspection,
  type RunSpec,
  type RuntimeRegistry,
  runtimeRegistry,
  type ServiceRuntime,
} from "@contremaitre/environments/runtimes";
import { Store } from "@contremaitre/environments/store";
import { context } from "@contremaitre/execution/context";
import { startServer } from "@contremaitre/hub/server";
import { parseManifest, prepareManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";

/** A host-process runtime that never touches the container system. */
class HostRuntime implements ServiceRuntime {
  readonly capabilities = {
    network: "host" as const,
    development: "mount" as const,
    clone: "files" as const,
  };
  running = new Set<string>();
  calls: string[] = [];
  async preflight() {}
  async build(_ctx: unknown, request: { name: string; root: string }) {
    return { digest: "component", image: join(request.root, `${request.name}.wasm`) };
  }
  async run(_ctx: unknown, spec: RunSpec) {
    this.calls.push(`run ${spec.name}`);
    this.running.add(spec.name);
  }
  async inspect(_ctx: unknown, name: string): Promise<Inspection | undefined> {
    return this.running.has(name) ? { Host: "127.0.0.1", Running: true } : undefined;
  }
  async start(_ctx: unknown, name: string) {
    this.running.add(name);
  }
  async stop(_ctx: unknown, name: string) {
    this.calls.push(`stop ${name}`);
    this.running.delete(name);
  }
  async remove(_ctx: unknown, name: string) {
    this.running.delete(name);
  }
  async logs() {}
  async ready() {
    return true;
  }
  async clone(_ctx: unknown, from: CloneSide, to: CloneSide) {
    this.calls.push(`clone ${from.service.Name}`);
    mkdirSync(to.data, { recursive: true });
  }
}

/**
 * A fake `container` binary. It appends every invocation to `calls`. With `fail-all`
 * present every call fails; with `fail-start` only `system start` fails. With
 * `slow-start`, `system start` waits for `release`.
 */
function containerBinary(dir: string) {
  const binary = join(dir, "container"),
    state = join(dir, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(dir, "calls"), "");
  writeFileSync(
    binary,
    `#!${process.execPath}
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = ${JSON.stringify(dir)}, state = ${JSON.stringify(state)}, args = process.argv.slice(2);
appendFileSync(join(dir, 'calls'), args.join(' ') + '\\n');
const fatal = text => { console.error(text); process.exit(1); };
if (existsSync(join(dir, 'fail-all'))) fatal('container system is unavailable');
const file = (kind, name) => join(state, kind + '-' + name);
const missing = (kind, name) => { if (!existsSync(file(kind, name))) fatal(name + ' not found'); };
const [verb, sub] = args;
if (verb === 'system') {
  while (existsSync(join(dir, 'slow-start')) && !existsSync(join(dir, 'release'))) await Bun.sleep(5);
  if (existsSync(join(dir, 'fail-start'))) fatal('container system start failed: kernel unavailable');
} else if (['network', 'volume', 'image'].includes(verb)) {
  const name = args[args.length - 1];
  if (sub === 'inspect') missing(verb, name);
  else if (sub === 'create') writeFileSync(file(verb, name), '');
  else if (sub === 'delete') { missing(verb, name); rmSync(file(verb, name)); }
} else if (verb === 'run') {
  writeFileSync(file('container', args[args.indexOf('--name') + 1]), 'running');
} else if (verb === 'inspect') {
  missing('container', sub);
  console.log(JSON.stringify([{ status: 'running', networks: [{ ipv4Address: '192.168.64.9/24' }] }]));
} else if (verb === 'delete') {
  const name = args[args.length - 1];
  missing('container', name);
  rmSync(file('container', name));
} else if (!['stop', 'start', 'exec'].includes(verb)) fatal('unexpected command ' + args.join(' '));
`,
    { mode: 0o700 },
  );
  return {
    binary,
    calls: () => readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean),
  };
}

const wasmOnly = `version: 1
project: wasm
services:
  db: {kind: postgres, runtime: wasm}
  web:
    runtime: wasm
    wasm: {build: [make, web], component: web.wasm}
    port: 8080
    http: true
    depends_on: [db]
`;
const appleOnly = (project: string) =>
  `version: 1\nproject: ${project}\nservices:\n  web: {image: nginx, port: 80, ready: ["true"]}\n`;

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cm-wasm-standalone-"))),
    container = containerBinary(join(home, "fake")),
    apple = new Apple(container.binary, { startSystem: true }),
    host = new HostRuntime(),
    base = runtimeRegistry({ home, apple }),
    runtimes: RuntimeRegistry = { apple: base.apple, wasm: { app: host, postgres: host } };
  const start = () => startServer({ home, port: 0, runtime: apple, runtimes });
  const project = (name: string, manifest: string) => {
    const root = join(home, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".contremaitre.yaml"), manifest);
    return root;
  };
  return { home, container, apple, host, start, project };
}

test("a WASM-only environment never calls a failing container system", async () => {
  const f = await fixture();
  writeFileSync(join(f.home, "fake", "fail-all"), "");
  let hub = await f.start();
  try {
    const root = f.project("wasm", wasmOnly);
    const deploy = async (branch: string) => {
      await hub.manager.deploy(context(), await hub.manager.prepare(context(), { root, branch }));
      return Object.values(hub.manager.state.Environments).find(
        (e) => e.Identity.Branch === branch,
      ) as Environment;
    };
    const main = await deploy("main");
    expect(main.Status).toBe("running");
    // A feature environment clones main's Postgres.
    const feature = await deploy("feature");
    expect(feature.CloneComplete).toBe(true);
    expect(f.host.calls).toContain("clone db");
    await hub.manager.down(context(), feature);
    expect(feature.Status).toBe("stopped");
    await deploy("feature");
    expect(feature.Status).toBe("running");
    expect(await hub.manager.pruneImages(context(), main)).toEqual([]);
    // Recovery after a restart inspects host services only.
    await hub.close();
    hub = await f.start();
    const recovered = hub.manager.resolve(main.Identity.ID);
    expect(recovered.Status).toBe("running");
    expect(await call(context(), f.home, "health")).toBeDefined();
    for (const env of Object.values(hub.manager.state.Environments))
      await hub.manager.down(context(), env, true);
    expect(hub.manager.list()).toEqual([]);
    expect(existsSync(join(f.home, "data", main.Identity.ID))).toBe(false);
    expect(f.container.calls()).toEqual([]);
  } finally {
    await hub.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("the hub starts the container system once, when an Apple service first needs it", async () => {
  const f = await fixture();
  const hub = await f.start();
  try {
    expect(f.container.calls()).toEqual([]);
    for (const name of ["first", "second"]) {
      const root = f.project(name, appleOnly(name));
      await hub.manager.deploy(
        context(),
        await hub.manager.prepare(context(), { root, branch: "main" }),
      );
    }
    const calls = f.container.calls();
    expect(calls.filter((c) => c.startsWith("system "))).toEqual([
      "system start --enable-kernel-install",
    ]);
    expect(calls[0]).toBe("system start --enable-kernel-install");
    for (const env of Object.values(hub.manager.state.Environments))
      expect(env.Status).toBe("running");
  } finally {
    await hub.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("a failed container system start fails that deployment and is retried by the next", async () => {
  const f = await fixture();
  writeFileSync(join(f.home, "fake", "fail-start"), "");
  const hub = await f.start();
  try {
    const apple = f.project("apple", appleOnly("apple"));
    const prepared = await hub.manager.prepare(context(), { root: apple, branch: "main" });
    await expect(hub.manager.deploy(context(), prepared)).rejects.toThrow(
      "container system start failed: kernel unavailable",
    );
    expect(f.container.calls()).toEqual(["system start --enable-kernel-install"]);
    // The hub keeps serving, and WASM-only work proceeds without the container system.
    expect(await call(context(), f.home, "health")).toBeDefined();
    const wasm = f.project("wasm", wasmOnly);
    await hub.manager.deploy(
      context(),
      await hub.manager.prepare(context(), { root: wasm, branch: "main" }),
    );
    expect(f.container.calls()).toEqual(["system start --enable-kernel-install"]);
    rmSync(join(f.home, "fake", "fail-start"));
    await hub.manager.deploy(
      context(),
      await hub.manager.prepare(context(), { root: apple, branch: "main" }),
    );
    expect(f.container.calls().filter((c) => c.startsWith("system "))).toHaveLength(2);
    expect(hub.manager.resolve(prepared.identity.ID).Status).toBe("running");
  } finally {
    await hub.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("concurrent container calls share one system start", async () => {
  const f = await fixture();
  try {
    await Promise.all([
      f.apple.network(context(), "one"),
      f.apple.network(context(), "two"),
      f.apple.inspect(context(), "absent"),
    ]);
    const calls = f.container.calls();
    expect(calls.filter((c) => c.startsWith("system "))).toHaveLength(1);
    expect(calls[0]).toBe("system start --enable-kernel-install");
    // Without the option, Apple never starts the system itself.
    await new Apple(f.container.binary).network(context(), "three");
    expect(f.container.calls().filter((c) => c.startsWith("system "))).toHaveLength(1);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("Apple and mixed environments keep their network, and the last Apple service removes it", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cm-wasm-networks-"))),
    apple = new FakeRuntime(),
    host = new HostRuntime(),
    store = new Store(home),
    base = runtimeRegistry({ home, apple }),
    manager = new Manager(store, apple, 8080, "http", {
      apple: base.apple,
      wasm: { app: host, postgres: host },
    });
  const deploy = async (project: string, manifest: string) => {
    const root = join(home, project);
    mkdirSync(root, { recursive: true });
    const identity = newIdentity(project, root, "main");
    await manager.deploy(context(), {
      root,
      identity,
      manifest: prepareManifest(root, parseManifest(manifest)),
      request: {},
    });
    return manager.resolve(identity.ID);
  };
  const network = (env: Environment) =>
    apple.calls.filter(
      (c) => c === `network ${env.Network}` || c === `remove network ${env.Network}`,
    );
  const mixed = `${wasmOnly.replace("project: wasm", "project: mixed")}  cache: {kind: redis}\n`;
  try {
    const only = await deploy("apple", appleOnly("apple"));
    await manager.down(context(), only, true);
    expect(network(only)).toEqual([`network ${only.Network}`, `remove network ${only.Network}`]);
    const env = await deploy("mixed", mixed);
    expect(env.Services.cache.Host).toBe("127.0.0.1");
    expect(network(env)).toEqual([`network ${env.Network}`]);
    // Removing the only Apple service deletes the network it no longer needs.
    await deploy("mixed", wasmOnly.replace("project: wasm", "project: mixed"));
    expect(network(env)).toEqual([`network ${env.Network}`, `remove network ${env.Network}`]);
    apple.calls = [];
    await manager.down(context(), env, true);
    expect(apple.calls).toEqual([]);
    const again = await deploy("mixed", mixed);
    await manager.down(context(), again, true);
    expect(network(again)).toEqual([`network ${again.Network}`, `remove network ${again.Network}`]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("recovery fails an Apple environment, not the hub, when the container system is unavailable", async () => {
  const f = await fixture();
  let hub = await f.start();
  try {
    const deploy = async (name: string, manifest: string) => {
      const prepared = await hub.manager.prepare(context(), {
        root: f.project(name, manifest),
        branch: "main",
      });
      await hub.manager.deploy(context(), prepared);
      return prepared.identity.ID;
    };
    const apple = await deploy("apple", appleOnly("apple")),
      wasm = await deploy("wasm", wasmOnly);
    await hub.close();
    writeFileSync(join(f.home, "fake", "fail-all"), "");
    hub = await f.start();
    expect(await call(context(), f.home, "health")).toBeDefined();
    const failed = hub.manager.resolve(apple);
    expect(failed.Status).toBe("failed");
    expect(failed.Error).toContain("container system is unavailable");
    expect(failed.Services.web.Host).toBe("");
    expect(hub.manager.resolve(wasm).Status).toBe("running");
  } finally {
    await hub.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("a cancelled caller stops waiting for a shared system start, and others still get one", async () => {
  const f = await fixture(),
    fake = join(f.home, "fake"),
    starts = () => f.container.calls().filter((c) => c.startsWith("system ")).length;
  writeFileSync(join(fake, "slow-start"), "");
  const started = async (count: number) => {
    while (starts() < count) await Bun.sleep(5);
  };
  try {
    // A waiter's cancellation rejects only that waiter.
    const owner = f.apple.startSystem(context());
    await started(1);
    const cancel = new AbortController(),
      waiter = f.apple.startSystem(context(cancel.signal));
    cancel.abort();
    await expect(waiter).rejects.toThrow();
    writeFileSync(join(fake, "release"), "");
    await owner;
    expect(starts()).toBe(1);
    // The owner's cancellation makes a waiting caller start the system again.
    rmSync(join(fake, "release"));
    const apple = new Apple(f.container.binary, { startSystem: true }),
      stop = new AbortController(),
      first = apple.startSystem(context(stop.signal));
    await started(2);
    const second = apple.startSystem(context());
    stop.abort();
    await expect(first).rejects.toThrow();
    await started(3);
    writeFileSync(join(fake, "release"), "");
    await second;
    await apple.startSystem(context());
    expect(starts()).toBe(3);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("the default hub runtime starts the container system on demand", async () => {
  const f = await fixture(),
    path = process.env.PATH;
  // The hub's own Apple runtime resolves `container` through PATH.
  process.env.PATH = `${join(f.home, "fake")}:${path}`;
  let hub = await startServer({ home: f.home, port: 0 });
  try {
    expect(f.container.calls()).toEqual([]);
    const prepared = await hub.manager.prepare(context(), {
      root: f.project("apple", appleOnly("apple")),
      branch: "main",
    });
    await hub.manager.deploy(context(), prepared);
    expect(f.container.calls()[0]).toBe("system start --enable-kernel-install");
    await hub.close();
    writeFileSync(join(f.home, "fake", "calls"), "");
    // Recovery of a running Apple environment is the first use after a restart.
    hub = await startServer({ home: f.home, port: 0 });
    expect(f.container.calls()[0]).toBe("system start --enable-kernel-install");
    expect(f.container.calls().filter((c) => c.startsWith("system "))).toHaveLength(1);
    expect(hub.manager.resolve(prepared.identity.ID).Status).toBe("running");
  } finally {
    process.env.PATH = path;
    await hub.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});
