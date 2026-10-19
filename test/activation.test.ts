import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActivationRuntime,
  defaultWasmIdleTimeoutSeconds,
} from "@contremaitre/environments/activation";
import type { RunSpec, ServiceRuntime } from "@contremaitre/environments/runtimes";
import { type Context, context } from "@contremaitre/execution/context";
import { parseManifest } from "@contremaitre/projects/config";
import { freePort } from "./ports.js";

class Backend implements ServiceRuntime {
  readonly capabilities = { network: "host", development: "mount", clone: "files" } as const;
  specs = new Map<string, RunSpec>();
  servers = new Map<string, Server[]>();
  starts = 0;
  stops = 0;
  bodies: string[] = [];
  failStart = false;
  handlerDelay = 0;
  beforeStart?: (ctx: Context) => Promise<void>;
  beforeStop?: () => Promise<void>;
  async preflight() {}
  async build() {
    return { image: "fixture.wasm", digest: "fixture" };
  }
  async logs() {}
  async run(ctx: Context, spec: RunSpec) {
    this.specs.set(spec.name, spec);
    await this.start(ctx, spec.name);
  }
  async inspect(_ctx: Context, name: string) {
    return this.specs.has(name)
      ? { Host: "127.0.0.1", Running: this.servers.has(name) }
      : undefined;
  }
  async start(ctx: Context, name: string) {
    await this.beforeStart?.(ctx);
    ctx.signal.throwIfAborted();
    if (this.failStart) throw Error("fixture startup failed");
    if (this.servers.has(name)) return;
    this.starts++;
    const servers: Server[] = [];
    for (const port of Object.values(this.specs.get(name)?.ports ?? {})) {
      const handler: RequestListener = async (req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
        let body = "";
        for await (const chunk of req) body += String(chunk);
        this.bodies.push(body);
        res.end(`${name}:${body}`);
      };
      const server = createServer();
      if (this.handlerDelay) setTimeout(() => server.on("request", handler), this.handlerDelay);
      else server.on("request", handler);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      servers.push(server);
    }
    this.servers.set(name, servers);
  }
  async stop(_ctx: Context, name: string) {
    if (!this.servers.has(name)) return;
    await this.beforeStop?.();
    const servers = this.servers.get(name) ?? [];
    this.servers.delete(name);
    this.stops++;
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  }
  async remove(ctx: Context, name: string) {
    await this.stop(ctx, name);
    this.specs.delete(name);
  }
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error("Activation condition timed out");
    await Bun.sleep(10);
  }
}
async function fixture(timeout = 1) {
  const home = await mkdtemp(join(tmpdir(), "cm-activation-"));
  const backend = new Backend();
  let runtime = new ActivationRuntime(backend, home);
  const port = await freePort();
  const envFile = join(home, "env");
  await writeFile(envFile, "GREETING=private\n");
  await runtime.run(context(), {
    name: "web",
    image: "fixture.wasm",
    network: "",
    volumes: {},
    envFile,
    root: home,
    data: join(home, "data"),
    ports: { "8080": port },
    service: {
      runtime: "wasm",
      http: true,
      port: 8080,
      idle_timeout_seconds: timeout,
      wasm: { component: "fixture.wasm" },
    },
  });
  return {
    backend,
    port,
    home,
    get runtime() {
      return runtime;
    },
    request: (body = "") =>
      fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        body,
        headers: { Connection: "close" },
      }).then((r) => r.text()),
    restart: async () => {
      await runtime.shutdown();
      runtime = new ActivationRuntime(backend, home);
      await runtime.inspect(context(), "web");
    },
    close: async () => {
      await runtime.remove(context(), "web");
      await runtime.shutdown();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("Wasm idle policy defaults to sixty seconds, validates overrides, and rejects Apple overrides", () => {
  expect(defaultWasmIdleTimeoutSeconds).toBe(60);
  const text = (value: number) =>
    `version: 1\nproject: idle\nservices:\n  db: {kind: postgres, runtime: wasm, idle_timeout_seconds: ${value}}\n`;
  expect(parseManifest(text(0)).services.db.idle_timeout_seconds).toBe(0);
  for (const value of [-1, 0.5, 2_147_484]) expect(() => parseManifest(text(value))).toThrow();
  expect(() => parseManifest(text(10).replace("runtime: wasm", "runtime: apple"))).toThrow(
    "requires runtime: wasm",
  );
});

test("concurrent cold connections share one start and forward each POST body exactly once", async () => {
  const f = await fixture();
  try {
    await until(() => f.backend.stops === 1);
    const values = Array.from({ length: 12 }, (_, i) => `body-${i}`);
    expect(await Promise.all(values.map((value) => f.request(value)))).toEqual(
      values.map((value) => `web:${value}`),
    );
    expect(f.backend.starts).toBe(2);
    expect(f.backend.bodies.sort()).toEqual(values.sort());
  } finally {
    await f.close();
  }
});

test("cold HTTP activation waits for the request handler after the TCP listener opens", async () => {
  const f = await fixture();
  try {
    await until(() => f.backend.stops === 1);
    f.backend.handlerDelay = 200;
    const response = await fetch(`http://127.0.0.1:${f.port}`, {
      method: "POST",
      body: "ready",
      headers: { Connection: "close" },
      signal: AbortSignal.timeout(2000),
    });
    expect(await response.text()).toBe("web:ready");
    expect(f.backend.bodies).toEqual(["ready"]);
  } finally {
    await f.close();
  }
});

test("an open TCP connection prevents suspension and closing it starts a full idle window", async () => {
  const f = await fixture();
  const socket = createConnection(f.port, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    await Bun.sleep(1200);
    expect(f.backend.stops).toBe(0);
    socket.destroy();
    await until(() => f.backend.stops === 1);
    expect(await f.request("after-close")).toBe("web:after-close");
  } finally {
    socket.destroy();
    await f.close();
  }
});

test("zero disables backend suspension", async () => {
  const f = await fixture(0);
  try {
    await Bun.sleep(1200);
    expect(f.backend.stops).toBe(0);
    expect(await f.request()).toBe("web:");
  } finally {
    await f.close();
  }
});

test("each service has its own idle timer", async () => {
  const f = await fixture();
  const port = await freePort();
  try {
    const spec = f.backend.specs.get("web");
    if (!spec) throw Error("Missing fixture service");
    await f.runtime.run(context(), {
      ...spec,
      name: "background",
      ports: { "8080": port },
      envFile: join(f.home, "env"),
      service: { runtime: "wasm", port: 8080, idle_timeout_seconds: 0 },
    });
    await until(() => f.backend.stops === 1);
    expect(f.backend.servers.has("web")).toBe(false);
    expect(f.backend.servers.has("background")).toBe(true);
    expect(await f.request("independent")).toBe("web:independent");
  } finally {
    await f.runtime.remove(context(), "background");
    await f.close();
  }
});

test("explicit stop closes the activation listener and persists across hub recovery", async () => {
  const f = await fixture();
  try {
    await f.runtime.stop(context(), "web");
    await expect(f.request()).rejects.toThrow();
    await f.restart();
    expect((await f.runtime.inspect(context(), "web"))?.Running).toBe(false);
    await expect(f.request()).rejects.toThrow();
    await f.runtime.start(context(), "web");
    expect(await f.request("resumed")).toBe("web:resumed");
  } finally {
    await f.close();
  }
});

test("hub recovery preserves a suspended service and restores its stable listener", async () => {
  const f = await fixture();
  try {
    await until(() => f.backend.stops === 1);
    await f.restart();
    expect(f.backend.starts).toBe(1);
    expect(await f.runtime.inspect(context(), "web")).toEqual({
      Host: "127.0.0.1",
      Running: true,
      Suspended: true,
    });
    expect(await f.request("recovered")).toBe("web:recovered");
    expect(f.backend.starts).toBe(2);
  } finally {
    await f.close();
  }
});

test("a connection racing idle shutdown waits for shutdown and then starts the backend", async () => {
  const f = await fixture();
  let release!: () => void;
  let stopping = false;
  f.backend.beforeStop = () => {
    stopping = true;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  try {
    await until(() => stopping);
    const response = f.request("race");
    release();
    expect(await response).toBe("web:race");
    expect(f.backend.starts).toBe(2);
  } finally {
    release?.();
    f.backend.beforeStop = undefined;
    await f.close();
  }
});

test("failed wake closes its client and a later connection can retry", async () => {
  const f = await fixture();
  try {
    await until(() => f.backend.stops === 1);
    f.backend.failStart = true;
    await expect(f.request("failure")).rejects.toThrow();
    f.backend.failStart = false;
    expect(await f.request("retry")).toBe("web:retry");
    expect(f.backend.bodies).toEqual(["retry"]);
  } finally {
    await f.close();
  }
});

test("disconnecting the first cold caller does not cancel startup for another caller", async () => {
  const f = await fixture();
  let release!: () => void;
  let starting = false;
  f.backend.beforeStart = () => {
    starting = true;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  try {
    await until(() => f.backend.stops === 1);
    const socket = createConnection(f.port, "127.0.0.1");
    socket.on("error", () => {});
    await until(() => starting);
    const response = f.request("surviving");
    socket.destroy();
    f.backend.beforeStart = undefined;
    release();
    expect(await response).toBe("web:surviving");
    expect(f.backend.starts).toBe(2);
  } finally {
    release?.();
    f.backend.beforeStart = undefined;
    await f.close();
  }
});

test("startup finishing after every caller disconnects still schedules idle suspension", async () => {
  const f = await fixture();
  let release!: () => void;
  let starting = false;
  try {
    await until(() => f.backend.stops === 1);
    f.backend.beforeStart = () => {
      starting = true;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const socket = createConnection(f.port, "127.0.0.1");
    socket.on("error", () => {});
    await until(() => starting);
    socket.destroy();
    await new Promise<void>((resolve) => socket.once("close", resolve));
    f.backend.beforeStart = undefined;
    release();
    await until(() => f.backend.stops === 2);
    expect(f.backend.servers.has("web")).toBe(false);
  } finally {
    release?.();
    f.backend.beforeStart = undefined;
    await f.close();
  }
});
