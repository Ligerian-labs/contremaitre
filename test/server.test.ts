import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { call } from "@contremaitre/cli/client";
import { context, decode } from "@contremaitre/execution/context";
import { startServer } from "@contremaitre/hub/server";
import { operationSchema } from "@contremaitre/operations/operations";
import { FakeRuntime } from "./fake-runtime.js";

test("failed stop closes the hub, preserves data and attempts other environments", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-stop-"));
  const runtime = new FakeRuntime();
  const hub = await startServer({ home, port: 0, runtime, skipSystemStart: true });
  try {
    for (const project of ["first", "second"]) {
      const root = join(home, project);
      mkdirSync(root);
      writeFileSync(
        join(root, ".contremaitre.yaml"),
        `version: 1\nproject: ${project}\nservices:\n  db: {image: postgres, ready: ["true"]}\n`,
      );
      await hub.manager.deploy(
        context(),
        await hub.manager.prepare(context(), { root, branch: "main" }),
      );
    }
    const [first, second] = Object.values(hub.manager.state.Environments);
    const data = join(home, "data", first.Identity.ID);
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "sentinel"), "preserved");
    const stop = runtime.stop.bind(runtime);
    runtime.stop = async (ctx, name) => {
      if (name === first.Services.db.Container) throw Error("Operation cancelled or timed out");
      await stop(ctx, name);
    };
    await expect(call(context(), home, "stop")).rejects.toThrow("Operation cancelled or timed out");
    const deadline = Date.now() + 1000;
    while (!hub.closed && Date.now() < deadline) await delay(10);
    expect(hub.closed).toBe(true);
    await hub.close();
    expect(existsSync(join(home, "hub.sock"))).toBe(false);
    expect(second.Status).toBe("stopped");
    expect(first.Status).toBe("stopping");
    expect(readFileSync(join(data, "sentinel"), "utf8")).toBe("preserved");
    expect(runtime.calls.some((c) => c.startsWith("remove volume "))).toBe(false);
    const restarted = await startServer({ home, port: 0, runtime, skipSystemStart: true });
    try {
      expect(await call(context(), home, "health")).toBeDefined();
    } finally {
      await restarted.close();
    }
  } finally {
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("cleanup errors do not leave the control socket or state lock held", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-close-"));
  const runtime = new FakeRuntime();
  const hub = await startServer({ home, port: 0, runtime, skipSystemStart: true });
  const stopDevelopment = hub.manager.stopDevelopment.bind(hub.manager);
  hub.manager.stopDevelopment = async () => {
    await stopDevelopment();
    throw Error("watcher cleanup failed");
  };
  try {
    await expect(hub.close()).rejects.toThrow("watcher cleanup failed");
    expect(existsSync(join(home, "hub.sock"))).toBe(false);
    const restarted = await startServer({ home, port: 0, runtime, skipSystemStart: true });
    await restarted.close();
  } finally {
    await hub.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test("Unix API owns deploy beyond caller lifetime and preserves state across hub restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-server-")),
    root = join(home, "project");
  mkdirSync(root);
  writeFileSync(
    join(root, ".contremaitre.yaml"),
    'version: 1\nproject: example\nservices:\n  web: {build: ".", ready: ["true"]}\n',
  );
  writeFileSync(join(root, "Dockerfile"), "FROM scratch");
  const runtime = new FakeRuntime();
  runtime.buildDelay = 100;
  const hub = await startServer({ home, port: 0, runtime, skipSystemStart: true });
  try {
    expect(statSync(join(home, "hub.sock")).mode & 0o777).toBe(0o600);
    const op = decode(
      operationSchema,
      await call(context(), home, "deploy-async", { root, branch: "main" }),
      "operation",
    );
    const duplicate = decode(
      operationSchema,
      await call(context(), home, "deploy-async", { root, branch: "main" }),
      "operation",
    );
    expect(duplicate.id).toBe(op.id);
    expect((await hub.operations.wait(op.id)).status).toBe("succeeded");
    expect(((await call(context(), home, "list")) as unknown[]).length).toBe(1);
    await expect(startServer({ home, port: 0, runtime, skipSystemStart: true })).rejects.toThrow(
      "already running",
    );
    await hub.close();
    const restarted = await startServer({ home, port: 0, runtime, skipSystemStart: true });
    try {
      expect(restarted.operations.get(op.id).status).toBe("succeeded");
      expect(restarted.manager.list()[0].Status).toBe("running");
    } finally {
      await restarted.close();
    }
  } finally {
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("ready services remain routable during redeploy and after another service fails", async () => {
  const { routes } = await import("@contremaitre/hub/server");
  const home = mkdtempSync(join(tmpdir(), "cm-routes-")),
    root = join(home, "project");
  mkdirSync(root);
  writeFileSync(
    join(root, ".contremaitre.yaml"),
    'version: 1\nproject: routes\nservices:\n  web: {image: web, http: true, port: 8080, ready: ["true"]}\n  worker: {image: worker, ready: ["true"]}\n',
  );
  const runtime = new FakeRuntime();
  const hub = await startServer({ home, port: 0, runtime, skipSystemStart: true });
  try {
    const p = await hub.manager.prepare(context(), { root, branch: "main" });
    await hub.manager.deploy(context(), p);
    const env = hub.manager.resolve(p.identity.ID),
      host = new URL(hub.manager.localURL(env, "web")).hostname;
    p.manifest.services.worker = { ...p.manifest.services.worker, migrate: ["migrate"] };
    const original = runtime.run.bind(runtime);
    runtime.run = async (ctx, spec) => {
      if (spec.task) {
        expect(routes(hub.manager, host)?.upstream).toBe("http://127.0.0.1:8080");
        throw Error("worker migration failed");
      }
      await original(ctx, spec);
    };
    await expect(hub.manager.deploy(context(), p)).rejects.toThrow("worker migration failed");
    expect(routes(hub.manager, host)?.upstream).toBe("http://127.0.0.1:8080");
  } finally {
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
});
