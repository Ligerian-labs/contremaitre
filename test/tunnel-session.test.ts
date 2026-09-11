import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "@contremaitre/environments/manager";
import { Store } from "@contremaitre/environments/store";
import { context } from "@contremaitre/execution/context";
import { parseManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";

test("browser URL dependencies resolve locally before sharing without startup dependencies", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-browser-url-"));
  try {
    const manifest = parseManifest(`version: 1
project: example
services:
  api:
    image: app
    http: true
    port: 3000
    ready: ["true"]
    environment: {ORIGIN: '{{web.browser_url}}'}
  web:
    image: app
    http: true
    port: 4200
    ready: ["true"]
    environment: {API_URL: '{{api.browser_url}}'}
`);
    const manager = new Manager(new Store(home), new FakeRuntime(), 443, "https");
    const identity = newIdentity("example", home, "main");
    await manager.deploy(context(), { root: home, identity, manifest, request: {} });
    const env = manager.resolve(identity.ID);
    expect(manager.serviceEnv(env, env.Services.web).API_URL).toBe(`https://${identity.Host}`);
    expect(manager.serviceEnv(env, env.Services.api).ORIGIN).toBe(`https://web.${identity.Host}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

async function configurationFixture(extra = "") {
  const home = mkdtempSync(join(tmpdir(), "cm-tunnel-config-"));
  const runtime = new FakeRuntime();
  const manager = new Manager(new Store(home), runtime, 443, "https");
  const identity = newIdentity("example", home, "main");
  const manifest = parseManifest(`version: 1
project: example
services:
  api: {image: app, http: true, port: 3000, ready: ["true"]}
  worker: {image: app, http: true, port: 3001, ready: ["true"]}
${extra}
  web:
    image: app
    http: true
    port: 3002
    ready: ["true"]
    depends_on: [api]
    environment: {API_URL: '{{api.url}}'}
`);
  await manager.deploy(context(), { root: home, identity, manifest, request: {} });
  const env = manager.resolve(identity.ID);
  return {
    home,
    runtime,
    manager,
    env,
    urls: Object.fromEntries(
      Object.keys(env.Services).map((name) => [name, `https://${name}.test/`]),
    ),
    close: () => rmSync(home, { recursive: true, force: true }),
  };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= deadline) throw Error("Concurrent restart did not begin");
    await Bun.sleep(10);
  }
}

test("tunnel URL changes and restoration restart independent apps together and wait for dependencies", async () => {
  const f = await configurationFixture();
  const run = f.runtime.run.bind(f.runtime);
  try {
    for (const urls of [f.urls, {}]) {
      const gate = Promise.withResolvers<void>();
      const started: string[] = [];
      f.runtime.run = async (ctx, spec) => {
        started.push(spec.name);
        if (spec.name === f.env.Services.api.Container) await gate.promise;
        await run(ctx, spec);
        if (spec.name === f.env.Services.api.Container)
          f.runtime.containers.set(spec.name, { IP: "127.0.0.2", Running: true });
      };
      const configuring = f.manager.configureTunnel(context(), f.env, urls);
      void configuring.catch(() => {});
      try {
        await until(() => started.includes(f.env.Services.worker.Container));
        expect(started).toContain(f.env.Services.api.Container);
        expect(started).not.toContain(f.env.Services.web.Container);
        expect(f.env.tunnel_configuration?.pending).toContain("api");
        gate.resolve();
        await configuring;
        expect(started).toContain(f.env.Services.web.Container);
        expect(f.manager.serviceEnv(f.env, f.env.Services.web).API_URL).toBe(
          "http://127.0.0.2:3000",
        );
      } finally {
        gate.resolve();
        await configuring.catch(() => {});
      }
    }
    expect(f.env.tunnel_configuration).toBeUndefined();
  } finally {
    f.close();
  }
});

test("tunnel configuration limits concurrent container restarts", async () => {
  const f = await configurationFixture(
    ["extraa", "extrab", "extrac"]
      .map((name) => `  ${name}: {image: app, http: true, port: 3000, ready: ["true"]}`)
      .join("\n"),
  );
  const run = f.runtime.run.bind(f.runtime);
  const gate = Promise.withResolvers<void>();
  let active = 0;
  let peak = 0;
  f.runtime.run = async (ctx, spec) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await gate.promise;
      await run(ctx, spec);
    } finally {
      active--;
    }
  };
  const configuring = f.manager.configureTunnel(context(), f.env, f.urls);
  void configuring.catch(() => {});
  try {
    await until(() => active >= 4);
    expect(active).toBe(4);
    gate.resolve();
    await configuring;
    expect(peak).toBe(4);
    expect(Object.values(f.env.Services).every((service) => service.ready)).toBe(true);
  } finally {
    gate.resolve();
    await configuring.catch(() => {});
    f.close();
  }
});

test("failed tunnel configuration cancels and drains sibling restarts before recovery", async () => {
  const f = await configurationFixture();
  const run = f.runtime.run.bind(f.runtime);
  const failure = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  let workerStarted = false;
  let workerAborted = false;
  let finished = false;
  f.runtime.run = async (ctx, spec) => {
    if (spec.name === f.env.Services.api.Container) {
      await failure.promise;
      throw Error("api startup failed");
    }
    if (spec.name === f.env.Services.worker.Container) {
      workerStarted = true;
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener(
          "abort",
          () => {
            workerAborted = true;
            resolve();
          },
          { once: true },
        );
      });
      await drained.promise;
      ctx.signal.throwIfAborted();
    }
    return run(ctx, spec);
  };
  const configuring = f.manager.configureTunnel(context(), f.env, f.urls).finally(() => {
    finished = true;
  });
  void configuring.catch(() => {});
  try {
    await until(() => workerStarted);
    failure.resolve();
    await until(() => workerAborted);
    expect(finished).toBe(false);
    expect(f.env.tunnel_configuration?.pending).toEqual(
      expect.arrayContaining(["api", "worker", "web"]),
    );
    drained.resolve();
    await expect(configuring).rejects.toThrow("api startup failed");
    f.runtime.run = run;
    await f.manager.configureTunnel(context(), f.env, {});
    expect(f.env.tunnel_configuration).toBeUndefined();
    expect(Object.values(f.env.Services).every((service) => service.ready)).toBe(true);
  } finally {
    failure.resolve();
    drained.resolve();
    await configuring.catch(() => {});
    f.close();
  }
});
