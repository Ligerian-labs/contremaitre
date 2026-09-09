import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentLogs } from "@contremaitre/cli/client";
import { context, progress, serviceContext } from "@contremaitre/execution/context";
import { startServer } from "@contremaitre/hub/server";
import { Operations } from "@contremaitre/operations/operations";
import { deploymentRows } from "../apps/cli/src/deploy.js";
import { FakeRuntime } from "./fake-runtime.js";

const cli = new URL("../apps/cli/src/cli.ts", import.meta.url).pathname;
const directory = () => mkdtempSync(join(tmpdir(), "cm-deploy-"));
async function fixture() {
  const home = directory(),
    root = join(home, "project");
  mkdirSync(root);
  writeFileSync(
    join(root, ".contremaitre.yaml"),
    'version: 1\nproject: demo\nservices:\n  web: {build: ".", ready: ["true"]}\n',
  );
  writeFileSync(join(root, "Dockerfile"), "FROM scratch\n");
  const runtime = new FakeRuntime();
  const hub = await startServer({ home, port: 0, runtime, skipSystemStart: true });
  const spawn = (...args: string[]) =>
    Bun.spawn(
      [
        process.execPath,
        cli,
        ...args,
        ...(args[0] === "deploy" && args[1] !== "logs" ? ["--http"] : []),
        "--home",
        home,
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  const run = async (...args: string[]) => {
    const child = spawn(...args);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  };
  return {
    home,
    root,
    runtime,
    hub,
    spawn,
    run,
    clean: async () => {
      await hub.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("deploy CLI prints compact readiness, nested logs print and exit, and -d detaches", async () => {
  const f = await fixture();
  try {
    const original = f.runtime.build.bind(f.runtime);
    f.runtime.build = async (ctx, ...args) => {
      ctx.log("BUILD OUTPUT\n");
      return original(ctx, ...args);
    };
    const first = await f.run("deploy", "--branch", "main");
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toContain("Deploying demo / main");
    expect(first.stdout).toContain("✅ web");
    expect(first.stdout).not.toContain("BUILD OUTPUT");
    expect(first.stdout).not.toContain("\x1b[");
    expect(first.stdout.trim().split("\n").length).toBe(2);
    const logs = await f.run("deploy", "logs", "--branch", "main");
    expect(logs.code).toBe(0);
    expect(logs.stdout).toContain("BUILD OUTPUT");
    const failure = await f.run("deploy", "logs", "--failure", "--branch", "main");
    expect(failure).toEqual({ stdout: "", stderr: "", code: 0 });
    const json = await f.run("deploy", "--branch", "main", "--json");
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).data.Status).toBe("running");
    f.runtime.buildDelay = 2000;
    const detached = await f.run("deploy", "--branch", "main", "-d");
    expect(detached.code).toBe(0);
    expect(detached.stdout).toContain("Deployment ");
    const op = f.hub.operations.list()[0];
    expect(op.status).toBe("running");
    await f.hub.operations.cancel(op.id);
  } finally {
    await f.clean();
  }
}, 15000);

test("Ctrl-C cancels the hub deployment and waits for its active subprocess", async () => {
  const f = await fixture();
  try {
    const { run } = await import("@contremaitre/execution/process");
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let ended = false;
    f.runtime.build = async (ctx) => {
      started();
      try {
        await run(ctx, [process.execPath, "-e", "setInterval(() => {}, 1000)"]);
      } finally {
        ended = true;
      }
      return { digest: "unused", image: "unused" };
    };
    const child = f.spawn("deploy", "--branch", "main");
    const output = new Response(child.stdout).text(),
      error = new Response(child.stderr).text();
    await ready;
    // The operation is admitted before the client starts following it.
    await Bun.sleep(200);
    child.kill("SIGINT");
    expect(await child.exited).not.toBe(0);
    await Promise.all([output, error]);
    expect(f.hub.operations.list()[0].status).toBe("cancelled");
    expect(ended).toBe(true);
  } finally {
    await f.clean();
  }
}, 15000);

test("failure logs select failed services, preserve shared errors, and survive restart", async () => {
  const home = directory();
  try {
    const ops = new Operations(home);
    const op = ops.submit(
      "env",
      "deploy",
      ["env"],
      async (ctx) => {
        ctx.log("shared setup\n");
        const web = serviceContext(ctx, "web"),
          worker = serviceContext(ctx, "worker");
        web.log("web diagnostic\n");
        worker.log("worker healthy\n");
        progress(web, "failed", "migration failed");
        progress(worker, "ready", "ready");
        throw Error("migration failed");
      },
      { name: "demo", services: ["web", "worker"] },
    );
    await ops.wait(op.id);
    const restarted = new Operations(home);
    const logs = Buffer.from(
      restarted.read(op.id, 0, 65536, { failure: true }).output,
      "base64",
    ).toString();
    expect(logs).toContain("web diagnostic");
    expect(logs).toContain("shared setup");
    expect(logs).not.toContain("worker healthy");
    expect(restarted.get(op.id).services?.web.status).toBe("failed");
    const rows = deploymentRows(restarted.get(op.id));
    expect(rows[0]).toContain("❌");
    expect(rows[1]).toContain("✅");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("deployment logs take a finite snapshot while follow waits for completion", async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const op = f.hub.operations.submit("logs", "deploy", ["logs"], async (ctx) => {
      ctx.log("before\n");
      await waiting;
      ctx.log("after\n");
    });
    let snapshot = "";
    await deploymentLogs(
      context(undefined, (data) => {
        snapshot += Buffer.from(data).toString();
      }),
      f.home,
      op.id,
    );
    expect(snapshot).toContain("before");
    expect(snapshot).not.toContain("after");
    let followed = "",
      done = false;
    const following = deploymentLogs(
      context(undefined, (data) => {
        followed += Buffer.from(data).toString();
      }),
      f.home,
      op.id,
      { follow: true },
    ).then(() => {
      done = true;
    });
    await Bun.sleep(30);
    expect(done).toBe(false);
    release();
    await following;
    expect(followed).toContain("after");
  } finally {
    await f.clean();
  }
});

test("status rows sanitize terminal controls and fit wide Unicode diagnostics", () => {
  const home = directory();
  try {
    const ops = new Operations(home);
    const op = ops.submit("env", "deploy", ["env"], async () => {}, {
      name: "demo",
      services: ["web"],
    });
    const row = deploymentRows(
      { ...op, services: { web: { status: "failed", detail: "\x1b[2J\n界".repeat(30) } } },
      0,
      40,
    )[0];
    expect(row).not.toContain("\x1b");
    expect(row).not.toContain("\n");
    expect(Bun.stringWidth(row)).toBeLessThanOrEqual(40);
    return ops.wait(op.id).finally(() => rmSync(home, { recursive: true, force: true }));
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
});
