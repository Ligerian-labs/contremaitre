import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { call, keepActive } from "@contremaitre/cli/client";
import { context } from "@contremaitre/execution/context";
import { startServer } from "@contremaitre/hub/server";
import { loadManifest, parseManifest } from "@contremaitre/projects/config";
import { initProject } from "@contremaitre/projects/init";
import { closeServer, listen } from "@contremaitre/routing/proxy";
import { FakeRuntime } from "./fake-runtime.js";

const manifest = (project: string, timeout = 10) => `version: 1
project: ${project}
idle_timeout_seconds: ${timeout}
services:
  web: {image: app, ready: ["true"], volumes: {uploads: /uploads}}
`;
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cm-idle-"));
  const runtime = new FakeRuntime();
  let time = Date.now();
  const hub = await startServer({ home, port: 0, runtime, skipSystemStart: true, now: () => time });
  const deploy = async (project: string, timeout = 10) => {
    const root = join(home, project);
    mkdirSync(root);
    writeFileSync(join(root, ".contremaitre.yaml"), manifest(project, timeout));
    await call(context(), home, "deploy", { root, branch: "main" });
    return hub.manager.resolve(project);
  };
  return {
    home,
    runtime,
    hub,
    deploy,
    advance: (ms: number) => {
      time += ms;
    },
    close: async () => {
      await hub.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
test("idle policy validates integers and retains a zero opt-out", () => {
  expect(parseManifest(manifest("example", 0)).idle_timeout_seconds).toBe(0);
  for (const value of [-1, 0.5, 2_147_484])
    expect(() => parseManifest(manifest("example", value))).toThrow();
});
test("idle expiry stops at the boundary, preserves data, and explicit deploy resumes", async () => {
  const f = await fixture();
  try {
    const env = await f.deploy("example");
    const sentinel = join(f.home, "data", env.Identity.ID, "uploads", "sentinel");
    writeFileSync(sentinel, "keep");
    f.advance(9999);
    await f.hub.idle.sweep();
    expect(env.Status).toBe("running");
    f.advance(1);
    await Promise.all([f.hub.idle.sweep(), f.hub.idle.sweep()]);
    expect(env.Status).toBe("stopped");
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    expect(f.runtime.calls.some((c) => c.startsWith("remove volume "))).toBe(false);
    await call(context(), f.home, "deploy", { root: env.Root, branch: "main" });
    expect(env.Status).toBe("running");
  } finally {
    await f.close();
  }
});
test("CLI activity only extends its environment; listings and disabled policy do not expire", async () => {
  const f = await fixture();
  try {
    const used = await f.deploy("used");
    const idle = await f.deploy("unused");
    const disabled = await f.deploy("background", 0);
    f.advance(9000);
    await call(context(), f.home, "resolve", { env: used.Identity.ID });
    await call(context(), f.home, "list");
    await call(context(), f.home, "health");
    f.advance(1000);
    await f.hub.idle.sweep();
    expect(used.Status).toBe("running");
    expect(idle.Status).toBe("stopped");
    f.advance(100_000);
    await f.hub.idle.sweep();
    expect(disabled.Status).toBe("running");
  } finally {
    await f.close();
  }
});
test("queued operations protect their clone source and failures do not stop other expiry", async () => {
  const f = await fixture();
  try {
    const source = await f.deploy("source");
    const other = await f.deploy("other");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const op = f.hub.operations.submit("clone-target", "deploy", [source.Identity.ID], () => gate);
    f.advance(10_000);
    await f.hub.idle.sweep();
    expect(source.Status).toBe("running");
    expect(other.Status).toBe("stopped");
    release();
    await f.hub.operations.wait(op.id);
    f.advance(10_000);
    const stop = f.runtime.stop.bind(f.runtime);
    f.runtime.stop = async (ctx, name) => {
      if (name === source.Services.web.Container) throw Error("temporary stop failure");
      await stop(ctx, name);
    };
    await f.hub.idle.sweep();
    expect(source.Status).toBe("stopping");
    f.runtime.stop = stop;
    f.advance(60_000);
    await f.hub.idle.sweep();
    expect(source.Status).toBe("stopped");
  } finally {
    await f.close();
  }
});
test("activity arriving while expiry awaits its lock cancels shutdown", async () => {
  const f = await fixture();
  try {
    const env = await f.deploy("racing");
    let release!: () => void;
    let acquired!: () => void;
    const locked = new Promise<void>((r) => {
      acquired = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const holding = f.hub.operations.locks.use(
      [env.Identity.ID],
      new AbortController().signal,
      async () => {
        acquired();
        await gate;
      },
    );
    await locked;
    f.advance(10_000);
    const sweep = f.hub.idle.sweep();
    await call(context(), f.home, "resolve", { env: env.Identity.ID });
    release();
    await holding;
    await sweep;
    expect(env.Status).toBe("running");
  } finally {
    await f.close();
  }
});

async function eventually(check: () => boolean) {
  const end = Date.now() + 1000;
  while (!check()) {
    if (Date.now() > end) throw Error("Activity did not settle");
    await delay(1);
  }
}
test("compact config propagates idle policy through lock refresh", () => {
  const root = mkdtempSync(join(tmpdir(), "cm-idle-config-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "compact",
        packageManager: "bun@1.4.2",
        scripts: { dev: "bun --watch index.ts --port 3000" },
      }),
    );
    writeFileSync(join(root, "bun.lock"), "{}");
    const path = initProject(root);
    writeFileSync(path, `${readFileSync(path, "utf8")}idle_timeout_seconds: 0\n`);
    expect(loadManifest(root, { refresh: true }).idle_timeout_seconds).toBe(0);
    expect(loadManifest(root).idle_timeout_seconds).toBe(0);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("idle_timeout_seconds: 0", "idle_timeout_seconds: -1"),
    );
    expect(() => loadManifest(root, { refresh: true })).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("foreground CLI socket pins environment until command exits or disconnects", async () => {
  const f = await fixture();
  try {
    const env = await f.deploy("foreground");
    const lease = await keepActive(context(), f.home, env.Identity.ID);
    try {
      f.advance(20_000);
      await f.hub.idle.sweep();
      expect(env.Status).toBe("running");
      f.advance(1);
    } finally {
      lease.close();
    }
    const expected = new Date(Date.parse(env.last_activity_at ?? "") + 1).toISOString();
    await eventually(() => env.last_activity_at === expected);
    f.advance(10_000);
    await f.hub.idle.sweep();
    expect(env.Status).toBe("stopped");
  } finally {
    await f.close();
  }
});
test("HTTP traffic and unfinished responses reset and pin only their routed environment", async () => {
  const f = await fixture();
  let finish!: () => void;
  const upstream = createServer((req, res) => {
    if (req.url === "/stream") {
      res.writeHead(200);
      res.write("open");
      finish = () => res.end("done");
    } else res.end("ok");
  });
  const port = await listen(upstream, 0);
  try {
    const env = await f.deploy("traffic");
    env.Services.web.Port = port;
    env.Services.web.HTTP = true;
    const host = new URL(f.hub.manager.localURL(env, "web")).hostname;
    const get = (path = "/") =>
      new Promise<string>((resolve, reject) => {
        const req = request(
          { hostname: "127.0.0.1", port: f.hub.proxyPort, path, headers: { host }, agent: false },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("end", () => resolve(body));
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end();
      });
    f.advance(9000);
    expect(await get()).toBe("ok");
    f.advance(1000);
    await f.hub.idle.sweep();
    expect(env.Status).toBe("running");
    const response = get("/stream");
    await eventually(() => !!finish);
    f.advance(20_000);
    await f.hub.idle.sweep();
    expect(env.Status).toBe("running");
    const expected = new Date(Date.parse(env.last_activity_at ?? "") + 1).toISOString();
    f.advance(1);
    finish();
    await response;
    // The response closes at the controlled current time before the next sweep.
    await eventually(() => env.last_activity_at === expected);
    f.advance(10_000);
    await f.hub.idle.sweep();
    expect(env.Status).toBe("stopped");
    expect(await get()).toBe("Environment is offline\n");
    expect(env.Status).toBe("stopped");
  } finally {
    await f.close();
    await closeServer(upstream);
  }
});
test("restart grants the full default idle window to existing environments", async () => {
  const f = await fixture();
  let restarted: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const env = await f.deploy("restart");
    delete env.idle_timeout_seconds;
    f.hub.manager.save();
    await f.hub.close();
    let time = Date.now() + 9_000_000;
    restarted = await startServer({
      home: f.home,
      port: 0,
      runtime: f.runtime,
      skipSystemStart: true,
      now: () => time,
    });
    const recovered = restarted.manager.resolve(env.Identity.ID);
    time += 7_199_999;
    await restarted.idle.sweep();
    expect(recovered.Status).toBe("running");
    time++;
    await restarted.idle.sweep();
    expect(recovered.Status).toBe("stopped");
    expect(
      JSON.parse(readFileSync(join(f.home, "state.json"), "utf8")).Environments[env.Identity.ID]
        .Status,
    ).toBe("stopped");
  } finally {
    await restarted?.close();
    await f.close();
  }
});

test("Structure idle fixture verifies expiry, opt-out, and retained data through hub commands", async () => {
  const { idleFixture } = await import("./idle-fixture.js");
  const receipt = await idleFixture();
  expect(receipt.data_preserved).toBe(true);
  expect(Object.values(receipt.statuses).sort()).toEqual(["running", "stopped"]);
});

test("foreground sharing prevents expiry until its owner ends the session", async () => {
  const f = await fixture();
  try {
    const env = await f.deploy("shared");
    const sharing = f.hub.manager.tunnels;
    if (!sharing) throw Error("Missing tunnel hooks");
    const original = sharing.sharing;
    let active = true;
    sharing.sharing = () => active;
    try {
      f.advance(100_000);
      await f.hub.idle.sweep();
      expect(env.Status).toBe("running");
      active = false;
      f.advance(10_000);
      await f.hub.idle.sweep();
      expect(env.Status).toBe("stopped");
    } finally {
      sharing.sharing = original;
    }
  } finally {
    await f.close();
  }
});

test("WebSocket upgrades stay active until the socket closes", async () => {
  const f = await fixture();
  const upstream = createServer();
  upstream.on("upgrade", (_req, socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
  });
  const port = await listen(upstream, 0);
  try {
    const env = await f.deploy("websocket");
    env.Services.web.Port = port;
    env.Services.web.HTTP = true;
    const host = new URL(f.hub.manager.localURL(env, "web")).hostname;
    const socket = await new Promise<import("node:stream").Duplex>((resolve, reject) => {
      const req = request({
        hostname: "127.0.0.1",
        port: f.hub.proxyPort,
        headers: { host, connection: "Upgrade", upgrade: "websocket" },
        agent: false,
      });
      req.on("upgrade", (_res, socket) => resolve(socket));
      req.on("error", reject);
      req.end();
    });
    try {
      f.advance(100_000);
      await f.hub.idle.sweep();
      expect(env.Status).toBe("running");
    } finally {
      f.advance(1);
      socket.destroy();
    }
    const expected = new Date(Date.parse(env.last_activity_at ?? "") + 1).toISOString();
    await eventually(() => env.last_activity_at === expected);
    f.advance(10_000);
    await f.hub.idle.sweep();
    expect(env.Status).toBe("stopped");
  } finally {
    await f.close();
    await closeServer(upstream);
  }
});

test("daemon timer sweeps automatically and stops scheduling after close", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-idle-timer-"));
  const runtime = new FakeRuntime();
  let time = Date.now();
  const hub = await startServer({
    home,
    port: 0,
    runtime,
    skipSystemStart: true,
    now: () => time,
    idleSweepIntervalMs: 10,
  });
  try {
    writeFileSync(join(home, ".contremaitre.yaml"), manifest("automatic", 1));
    await call(context(), home, "deploy", { root: home, branch: "main" });
    const env = hub.manager.resolve("automatic");
    time += 1000;
    await eventually(() => env.Status === "stopped");
    const saved = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    expect(saved.Environments[env.Identity.ID].Status).toBe("stopped");
    await call(context(), home, "deploy", { root: home, branch: "main" });
    await hub.close();
    time += 1000;
    await hub.idle.sweep();
    expect(env.Status).toBe("running");
  } finally {
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
});
