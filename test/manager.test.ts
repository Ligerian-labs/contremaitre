import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager, type PreparedDeploy } from "@contremaitre/environments/manager";
import { Store } from "@contremaitre/environments/store";
import { context } from "@contremaitre/execution/context";
import { parseManifest, prepareManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";

const spec =
  `version: 1\nproject: example\nservices:\n  db: {kind: postgres}\n  web: {build: '.', ready: [true], depends_on: [db], environment: {DATABASE_URL: '{{db.url}}'}}\n`.replace(
    "[true]",
    '["true"]',
  );
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cm-manager-")),
    root = join(home, "project");
  mkdirSync(root);
  writeFileSync(join(root, "Dockerfile"), "FROM scratch");
  const runtime = new FakeRuntime(),
    manager = new Manager(new Store(home), runtime);
  const prepare = (branch = "main"): PreparedDeploy => ({
    root,
    identity: newIdentity("example", root, branch),
    manifest: prepareManifest(root, parseManifest(spec)),
    request: {},
    sourceId: manager.state.Main.example,
  });
  return {
    home,
    root,
    runtime,
    manager,
    prepare,
    clean: () => rmSync(home, { recursive: true, force: true }),
  };
}
test("failed build leaves running services, cache survives and down retains data", async () => {
  const f = fixture();
  try {
    const p = f.prepare();
    await f.manager.deploy(context(), p);
    const env = f.manager.resolve(p.identity.ID),
      password = env.credentials?.db;
    expect(env.Status).toBe("running");
    const image = env.Services.web.Image;
    await f.manager.deploy(context(), p);
    expect(env.Services.web.Image).toBe(image);
    f.runtime.failBuild = true;
    const before = f.runtime.calls.length;
    await expect(f.manager.deploy(context(), p)).rejects.toThrow("build failed");
    expect(env.Status).toBe("running");
    expect(f.runtime.calls.slice(before).some((c) => c.startsWith("stop"))).toBe(false);
    expect(new Store(f.home).load().Environments[env.Identity.ID].credentials?.db).toBe(password);
    await f.manager.down(context(), env);
    expect(env.Status).toBe("stopped");
    expect(env.Volumes.length).toBe(1);
    await f.manager.down(context(), env, true);
    expect(f.manager.list()).toEqual([]);
  } finally {
    f.clean();
  }
});
test("cloning restores main writers and copies data before target initialization", async () => {
  const f = fixture();
  try {
    const main = f.prepare();
    await f.manager.deploy(context(), main);
    const source = f.manager.resolve(main.identity.ID),
      target = f.prepare("feature");
    await f.manager.deploy(context(), target);
    expect(f.manager.resolve(target.identity.ID).CloneComplete).toBe(true);
    expect(f.runtime.containers.get(source.Services.web.Container)?.Running).toBe(true);
    expect(existsSync(join(f.home, "recovery", `${target.identity.ID}.json`))).toBe(false);
    expect(f.manager.resolve(target.identity.ID).credentials?.db).not.toBe(source.credentials?.db);
  } finally {
    f.clean();
  }
});
test("restart resumes a recorded main writer before admission", async () => {
  const f = fixture();
  try {
    const p = f.prepare();
    await f.manager.deploy(context(), p);
    const env = f.manager.resolve(p.identity.ID);
    await f.runtime.stop(context(), env.Services.web.Container);
    mkdirSync(join(f.home, "recovery"));
    writeFileSync(
      join(f.home, "recovery", "0123456789abcdef.json"),
      JSON.stringify({
        version: 1,
        source: env.Identity.ID,
        target: "0123456789abcdef",
        driver: false,
        writers: ["web"],
        temporary: [],
      }),
    );
    await f.manager.recover(context());
    expect(f.runtime.containers.get(env.Services.web.Container)?.Running).toBe(true);
    expect(existsSync(join(f.home, "recovery", "0123456789abcdef.json"))).toBe(false);
  } finally {
    f.clean();
  }
});

test("uploaded files fork independently and cancellation resumes main", async () => {
  const f = fixture();
  try {
    const p = f.prepare();
    p.manifest.services.web = { ...p.manifest.services.web, volumes: { uploads: "/uploads" } };
    await f.manager.deploy(context(), p);
    const source = f.manager.resolve(p.identity.ID);
    const sourcePath = join(f.home, "data", source.Identity.ID, "uploads", "file.txt");
    writeFileSync(sourcePath, "original");
    const target = f.prepare("files");
    target.manifest.services.web = {
      ...target.manifest.services.web,
      volumes: { uploads: "/uploads" },
    };
    await f.manager.deploy(context(), target);
    const targetPath = join(f.home, "data", target.identity.ID, "uploads", "file.txt");
    expect(readFileSync(targetPath, "utf8")).toBe("original");
    writeFileSync(targetPath, "changed");
    expect(readFileSync(sourcePath, "utf8")).toBe("original");
    const cancelled = f.prepare("cancelled"),
      controller = new AbortController(),
      original = f.runtime.exec.bind(f.runtime);
    f.runtime.exec = async (ctx, name, args, options) => {
      if (args[0] === "pg_restore") {
        controller.abort();
        ctx.signal.throwIfAborted();
      }
      return original(ctx, name, args, options);
    };
    await expect(f.manager.deploy(context(controller.signal), cancelled)).rejects.toThrow();
    expect(f.runtime.containers.get(source.Services.web.Container)?.Running).toBe(true);
    expect(existsSync(join(f.home, "recovery", `${cancelled.identity.ID}.json`))).toBe(false);
  } finally {
    f.clean();
  }
});

test("unchanged ready services skip restart and migration; rebuild forces both", async () => {
  const f = fixture();
  try {
    const p = f.prepare();
    p.manifest.services.web = { ...p.manifest.services.web, migrate: ["migrate"] };
    await f.manager.deploy(context(), p);
    f.runtime.calls = [];
    await f.manager.deploy(context(), p);
    expect(f.runtime.calls.filter((c) => /^(run|stop|remove network) /.test(c))).toEqual([]);
    p.request = { rebuild: true };
    await f.manager.deploy(context(), p);
    expect(f.runtime.calls.some((c) => c.startsWith("run ") && c.endsWith("-task"))).toBe(true);
  } finally {
    f.clean();
  }
});

test("redeploy inspects reusable services concurrently with a bounded number of runtime calls", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  let deploying: Promise<void> | undefined;
  try {
    const p = f.prepare();
    for (const name of ["extraa", "extrab", "extrac", "extrad"])
      p.manifest.services[name] = { kind: "app", image: "app", ready: ["true"] };
    await f.manager.deploy(context(), p);
    f.runtime.calls = [];
    const inspect = f.runtime.inspect.bind(f.runtime);
    let active = 0;
    let peak = 0;
    f.runtime.inspect = async (ctx, name) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await gate.promise;
        return await inspect(ctx, name);
      } finally {
        active--;
      }
    };
    deploying = f.manager.deploy(context(), p);
    void deploying.catch(() => {});
    const deadline = Date.now() + 2000;
    while (active < 4 && Date.now() < deadline) await Bun.sleep(10);
    expect(active).toBe(4);
    expect(f.runtime.calls.some((call) => /^(stop|run|remove) /.test(call))).toBe(false);
    f.runtime.inspect = inspect;
    gate.resolve();
    await deploying;
    expect(peak).toBeLessThanOrEqual(4);
    expect(f.runtime.calls.some((call) => /^(stop|run|remove) /.test(call))).toBe(false);
  } finally {
    gate.resolve();
    await deploying?.catch(() => {});
    f.clean();
  }
});

test("builds overlap and all finish before a failed build can replace running services", async () => {
  const f = fixture();
  try {
    const p = f.prepare();
    await f.manager.deploy(context(), p);
    p.manifest.services.worker = { kind: "app", build: ".", ready: ["true"] };
    let active = 0,
      peak = 0,
      finished = 0;
    f.runtime.build = async (_ctx, _root, _file, tag) => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(tag.includes("worker") ? 40 : 10);
      active--;
      finished++;
      if (tag.includes("web")) throw Error("broken web build");
      return { digest: "new", image: tag };
    };
    f.runtime.calls = [];
    await expect(f.manager.deploy(context(), p)).rejects.toThrow("broken web build");
    expect(peak).toBe(2);
    expect(finished).toBe(2);
    expect(f.runtime.calls.some((c) => c.startsWith("stop "))).toBe(false);
  } finally {
    f.clean();
  }
});

test("startup failure lets independent apps finish but blocks dependents", async () => {
  const f = fixture();
  try {
    const p = f.prepare();
    p.manifest.services.web = {
      kind: "app",
      image: "web",
      migrate: ["migrate"],
      depends_on: ["db"],
    };
    p.manifest.services.worker = { kind: "app", image: "worker", ready: ["true"] };
    p.manifest.services.child = { kind: "app", image: "child", depends_on: ["web"] };
    f.runtime.failTask = true;
    await expect(f.manager.deploy(context(), p)).rejects.toThrow("task failed");
    expect(f.runtime.calls.some((c) => c.startsWith("run ") && c.endsWith("-worker"))).toBe(true);
    expect(f.runtime.calls.some((c) => c.startsWith("run ") && c.endsWith("-child"))).toBe(false);
  } finally {
    f.clean();
  }
});

test("configuration changes replace only affected services and dependency changes restart dependents", async () => {
  const f = fixture();
  try {
    const p = f.prepare();
    p.manifest.services.worker = { kind: "app", image: "worker", ready: ["true"] };
    await f.manager.deploy(context(), p);
    p.manifest.services.web = {
      ...p.manifest.services.web,
      environment: { MODE: "new", DATABASE_URL: "{{db.url}}" },
    };
    f.runtime.calls = [];
    await f.manager.deploy(context(), p);
    const stopped = () =>
      f.runtime.calls.filter((c) => c.startsWith("stop ")).map((c) => c.split("-").at(-1));
    expect(stopped()).toEqual(["web"]);
    const env = f.manager.resolve(p.identity.ID);
    await f.runtime.stop(context(), env.Services.db.Container);
    f.runtime.calls = [];
    await f.manager.deploy(context(), p);
    expect(stopped().sort()).toEqual(["db", "web"]);
    expect(f.runtime.calls.some((c) => c.startsWith("remove network"))).toBe(false);
  } finally {
    f.clean();
  }
});

test("independent apps start together after infrastructure passes readiness", async () => {
  const f = fixture();
  try {
    const p = f.prepare();
    p.manifest.services.worker = { kind: "app", image: "worker", ready: ["true"] };
    let dbReady = false,
      active = 0,
      peak = 0;
    const original = f.runtime.run.bind(f.runtime);
    f.runtime.exec = async (_ctx, _name, args) => {
      if (args[0] === "pg_isready") {
        await Bun.sleep(20);
        dbReady = true;
      }
      return Buffer.from("ready");
    };
    f.runtime.run = async (ctx, spec) => {
      if (spec.service.kind === "app") {
        expect(dbReady).toBe(true);
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(30);
        active--;
      }
      await original(ctx, spec);
    };
    await f.manager.deploy(context(), p);
    expect(peak).toBe(2);
  } finally {
    f.clean();
  }
});

test("cancelling a migration removes its task container with an independent cleanup signal", async () => {
  const f = fixture();
  try {
    const p = f.prepare(),
      controller = new AbortController();
    p.manifest.services.web = { ...p.manifest.services.web, migrate: ["migrate"] };
    const original = f.runtime.run.bind(f.runtime),
      remove = f.runtime.remove.bind(f.runtime);
    let cleaned = false;
    f.runtime.run = async (ctx, spec) => {
      if (spec.task) {
        controller.abort();
        ctx.signal.throwIfAborted();
      }
      await original(ctx, spec);
    };
    f.runtime.remove = async (ctx, name) => {
      if (controller.signal.aborted && name.endsWith("-task")) {
        expect(ctx.signal.aborted).toBe(false);
        cleaned = true;
      }
      await remove(ctx, name);
    };
    await expect(f.manager.deploy(context(controller.signal), p)).rejects.toThrow();
    expect(cleaned).toBe(true);
  } finally {
    f.clean();
  }
});
