import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "@contremaitre/environments/manager";
import { Store } from "@contremaitre/environments/store";
import { context } from "@contremaitre/execution/context";
import { routes } from "@contremaitre/hub/server";
import { newIdentity } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";
import { namingFixture } from "./naming-fixture.js";

test("Structure readable-names scenario exposes independent routes", async () => {
  const proof = await namingFixture();
  expect(proof.environment_ids).toHaveLength(2);
  expect(Object.values(proof.observations)).toEqual(["first", "first", "second", "second"]);
});

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cm-naming-")));
  const runtime = new FakeRuntime();
  const manager = new Manager(new Store(home), runtime);
  const root = (parent: string, project = "example") => {
    const path = join(home, parent, "app");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, ".contremaitre.yaml"),
      `version: 1\nproject: ${project}\nservices:\n  web: {image: app, http: true, port: 3000, ready: ["true"]}\n`,
    );
    return path;
  };
  return {
    home,
    runtime,
    manager,
    root,
    clean: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("new deployments use readable names and queued collisions keep distinct routes", async () => {
  const f = fixture();
  try {
    const first = await f.manager.prepare(context(), {
      root: f.root("first"),
      branch: "feature/a",
    });
    const second = await f.manager.prepare(context(), {
      root: f.root("second"),
      branch: "feature-a",
    });
    await Promise.all([f.manager.deploy(context(), first), f.manager.deploy(context(), second)]);
    const a = f.manager.resolve(first.identity.ID),
      b = f.manager.resolve(second.identity.ID);
    expect(a.Identity.Name).toBe("example/feature-a-app");
    expect(a.Identity.Host).toBe("feature-a-app.example.localhost");
    expect(b.Identity.Host).toBe(`feature-a-app-${b.Identity.ID.slice(0, 8)}.example.localhost`);
    expect(a.Network).not.toBe(b.Network);
    a.Services.web.IP = "127.0.0.2";
    b.Services.web.IP = "127.0.0.3";
    expect(routes(f.manager, a.Identity.Host)?.upstream).toBe("http://127.0.0.2:3000");
    expect(routes(f.manager, b.Identity.Host)?.upstream).toBe("http://127.0.0.3:3000");
    expect(f.manager.resolve(b.Identity.Name)).toBe(b);
    const saved = { ...b.Identity };
    await f.manager.down(context(), a, true);
    const restarted = new Manager(new Store(f.home), f.runtime);
    const current = await restarted.current(context(), second.root, "feature-a");
    expect(current).toEqual(saved);
    await restarted.deploy(
      context(),
      await restarted.prepare(context(), { root: second.root, branch: "feature-a" }),
    );
    expect(restarted.resolve(saved.ID).Identity).toEqual(saved);
  } finally {
    f.clean();
  }
});

test("legacy deployed names survive prepare and redeploy", async () => {
  const f = fixture();
  try {
    const root = f.root("legacy");
    const identity = newIdentity("example", root, "main");
    identity.Name = `example/main-app-${identity.ID.slice(0, 8)}`;
    identity.Host = `main-app-${identity.ID.slice(0, 8)}.example.localhost`;
    const env = f.manager.fresh(identity, root);
    // A legacy state is loaded as it was persisted by an earlier release.
    env.Identity = identity;
    f.manager.state.Environments[identity.ID] = env;
    f.manager.save();
    const restarted = new Manager(new Store(f.home), f.runtime);
    expect(await restarted.current(context(), root, "main")).toEqual(identity);
    const prepared = await restarted.prepare(context(), { root, branch: "main" });
    expect(prepared.identity).toEqual(identity);
    await restarted.deploy(context(), prepared);
    expect(restarted.resolve(identity.ID).Identity).toEqual(identity);
    expect(routes(restarted, identity.Host)?.upstream).toBe("http://127.0.0.1:3000");
    expect(routes(restarted, "main.example.localhost")?.upstream).toBe("http://127.0.0.1:3000");
  } finally {
    f.clean();
  }
});

test("driver preflight reserves a name and releases it on failure", async () => {
  const f = fixture();
  try {
    const root = f.root("driver");
    writeFileSync(
      join(root, ".contremaitre.yaml"),
      "version: 1\nproject: example\ndriver: {executable: driver, timeout_seconds: 5}\nservices: {}\n",
    );
    writeFileSync(
      join(root, "driver"),
      `#!${process.execPath}\nconsole.error('preflight ready'); while (!await Bun.file(${JSON.stringify(join(root, "release"))}).exists()) await Bun.sleep(5); process.exit(1);`,
      { mode: 0o700 },
    );
    const prepared = await f.manager.prepare(context(), { root, branch: "feature" });
    const entered = Promise.withResolvers<void>();
    const deployment = f.manager.deploy(
      context(undefined, (data) => {
        if (Buffer.from(data).toString().includes("preflight ready")) entered.resolve();
      }),
      prepared,
    );
    const failure = deployment.then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    const second = await f.manager.prepare(context(), {
      root: f.root("native"),
      branch: "feature",
    });
    await f.manager.deploy(context(), second);
    const env = f.manager.resolve(second.identity.ID);
    writeFileSync(join(root, "release"), "");
    expect(env.Identity.Host).toBe(`feature-app-${env.Identity.ID.slice(0, 8)}.example.localhost`);
    expect(await failure).toBeDefined();
    const third = await f.manager.prepare(context(), { root: f.root("third"), branch: "feature" });
    await f.manager.deploy(context(), third);
    expect(f.manager.resolve(third.identity.ID).Identity.Host).toBe(
      "feature-app.example.localhost",
    );
  } finally {
    f.clean();
  }
});
