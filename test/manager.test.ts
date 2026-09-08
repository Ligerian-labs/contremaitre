import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest, prepareManifest } from "../src/config.js";
import { Manager, type PreparedDeploy } from "../src/manager.js";
import { context, newIdentity } from "../src/model.js";
import { Store } from "../src/store.js";
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
