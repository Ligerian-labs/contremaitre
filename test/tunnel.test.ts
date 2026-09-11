import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { call } from "@contremaitre/cli/client";
import { Manager } from "@contremaitre/environments/manager";
import { Store } from "@contremaitre/environments/store";
import { Tunnels } from "@contremaitre/environments/tunnel";
import type { TunnelSessions } from "@contremaitre/environments/tunnel-session";
import { context } from "@contremaitre/execution/context";
import { startServer } from "@contremaitre/hub/server";
import { FakeRuntime } from "./fake-runtime.js";

async function until(check: () => boolean | Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error("Condition timed out");
    await Bun.sleep(25);
  }
}
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cm-session-"));
  const provider = join(home, "provider");
  const requests: Headers[] = [];
  const upstream = Bun.serve({
    port: 0,
    fetch: (request) => {
      requests.push(request.headers);
      return new Response("local app");
    },
  });
  writeFileSync(
    provider,
    `#!${process.execPath}
import {createInterface} from 'node:readline';
import {appendFileSync,existsSync} from 'node:fs';
let first,expires=0;
const lines=createInterface({input:process.stdin});
lines.on('line', async line=>{
 const r=JSON.parse(line),op=process.argv[2];
 if(!first){
  first=r; appendFileSync(r.config.calls,JSON.stringify({op,...r})+'\\n');
  while(existsSync(r.config.calls+'.hold-'+op)||existsSync(r.config.calls+'.hold-'+op+'-'+r.service_id))await Bun.sleep(10);
  if(op==='start'){
   expires=r.expires_at;
   if(existsSync(r.config.fail)&&r.service_id==='web')process.exit(1);
   const status=(await fetch(r.upstream)).status;
   appendFileSync(r.config.calls,JSON.stringify({op:'initial-gate',status})+'\\n');
   console.log(JSON.stringify({version:2,ready:true}));
   setInterval(()=>{if(existsSync(r.config.calls+'.revoked'))process.exit(77);if(existsSync(r.config.calls+'.disconnected')||Date.now()>=expires)process.exit(0)},100);
  }else{console.log(JSON.stringify({version:1,capabilities:{stable_urls:true,https:true,foreground_sessions:!existsSync(r.config.legacy)},reservation_id:r.service_id,url:'https://'+r.service_id+'.example.test'}));process.exit(0);}
 }else{expires=r.expires_at;appendFileSync(first.config.calls,JSON.stringify({op:'renew',service_id:first.service_id,...r})+'\\n');}
});
lines.on('close',()=>{if(process.argv[2]==='start')process.exit(0)});
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(home, "tunnels.json"),
    JSON.stringify({
      default: "fake",
      providers: {
        fake: {
          executable: provider,
          config: {
            calls: join(home, "calls"),
            fail: join(home, "fail"),
            legacy: join(home, "legacy"),
          },
        },
      },
    }),
  );
  writeFileSync(
    join(home, ".contremaitre.yaml"),
    `version: 1
project: example
services:
  api:
    image: app
    http: true
    port: ${upstream.port}
    ready: ["true"]
    environment: {ORIGIN: '{{web.browser_url}}'}
  web:
    image: app
    http: true
    port: ${upstream.port}
    ready: ["true"]
    environment: {API_URL: '{{api.browser_url}}'}
  worker: {image: app, ready: ["true"]}
`,
  );
  const runtime = new FakeRuntime();
  const hub = await startServer({
    home,
    port: 0,
    publicPort: 9080,
    runtime,
    skipSystemStart: true,
  });
  const manager = hub.manager;
  const prepared = await manager.prepare(context(), { root: home, branch: "main" });
  await manager.deploy(context(), prepared);
  const env = manager.resolve(prepared.identity.ID);
  const sessions = manager.tunnels as TunnelSessions;
  return {
    home,
    manager,
    env,
    sessions,
    runtime,
    requests,
    events: () =>
      existsSync(join(home, "calls"))
        ? readFileSync(join(home, "calls"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
    close: async () => {
      await hub.close();
      upstream.stop(true);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("foreground group gates startup, configures browser URLs, restores local config and reuses reservations", async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    expect(await f.sessions.open(context(), f.env, id)).toEqual({
      api: "https://api.example.test/",
      web: "https://web.example.test/",
    });
    expect(f.manager.serviceEnv(f.env, f.env.Services.web).API_URL).toBe(
      "https://api.example.test/",
    );
    expect(f.sessions.running(f.env.Identity.ID, "web")).toBe(true);
    expect(
      f
        .events()
        .filter((e) => e.op === "initial-gate")
        .map((e) => e.status),
    ).toEqual([503, 503]);
    expect(
      JSON.parse(f.manager.serviceEnv(f.env, f.env.Services.web).CONTREMAITRE_ORIGINS),
    ).toEqual([new URL(f.manager.localURL(f.env, "web")).origin, "https://web.example.test"]);
    const starts = f.events().filter((e) => e.op === "start");
    expect(starts[0].environment_id).not.toBe(f.env.Identity.ID);
    expect(starts[0].service_ids).toEqual(["api", "web"]);
    expect(starts.map((e) => e.service_id).sort()).toEqual(["api", "web"]);
    expect(await (await fetch(starts.find((e) => e.service_id === "api").upstream)).text()).toBe(
      "local app",
    );
    const headers = f.requests.at(-1);
    expect(headers?.get("host")).toBe(new URL(f.manager.localURL(f.env, "api")).host);
    expect(headers?.get("x-forwarded-host")).toBe("api.example.test");
    expect(headers?.get("x-forwarded-proto")).toBe("https");
    const recovery = new Manager(new Store(f.home), f.runtime, 9080);
    await expect(f.sessions.open(context(), f.env, randomUUID())).rejects.toThrow("already owns");
    await f.sessions.end(f.env, id);
    expect(f.env.tunnel_configuration).toBeUndefined();
    expect(f.manager.serviceEnv(f.env, f.env.Services.web).API_URL).toBe(
      f.manager.localURL(f.env, "api"),
    );
    expect(f.manager.serviceEnv(f.env, f.env.Services.web).CONTREMAITRE_PUBLIC_URL).toBeUndefined();
    expect(f.env.tunnels?.web.Desired).toBe(false);
    await recovery.recover(context());
    expect(recovery.resolve(f.env.Identity.ID).tunnel_configuration).toBeUndefined();
    expect(recovery.resolve(f.env.Identity.ID).tunnels?.web.Desired).toBe(false);
    const next = randomUUID();
    await f.sessions.open(context(), f.env, next);
    await f.sessions.end(f.env, id);
    expect(f.sessions.running(f.env.Identity.ID, "web")).toBe(true);
    expect(f.events().filter((e) => e.op === "reserve").length).toBe(2);
    f.sessions.renew(next);
    await f.sessions.end(f.env, next);
  } finally {
    await f.close();
  }
}, 20000);

test("tunnel prepares services concurrently and checks capabilities once per service", async () => {
  const f = await fixture();
  const reserveGate = join(f.home, "calls.hold-reserve");
  const startGate = join(f.home, "calls.hold-start");
  const appGate = Promise.withResolvers<void>();
  const run = f.runtime.run.bind(f.runtime);
  f.runtime.run = async (ctx, spec) => {
    if (spec.name === f.env.Services.api.Container) await appGate.promise;
    return run(ctx, spec);
  };
  writeFileSync(reserveGate, "");
  writeFileSync(startGate, "");
  const opening = f.sessions.open(context(), f.env, randomUUID());
  void opening.catch(() => {});
  try {
    await until(() => f.events().filter((e) => e.op === "reserve").length === 2, 2000);
    expect(f.env.tunnel_configuration).toBeUndefined();
    rmSync(reserveGate);
    await until(() => f.events().filter((e) => e.op === "start").length === 2, 2000);
    expect(f.events().filter((e) => e.op === "capabilities")).toHaveLength(2);
    expect(f.events().some((e) => e.op === "renew" && e.enabled)).toBe(false);
    rmSync(startGate);
    await until(() => f.events().filter((e) => e.op === "initial-gate").length === 2);
    expect(f.env.Services.api.ready).toBe(false);
    expect(f.sessions.running(f.env.Identity.ID, "web")).toBe(false);
    expect(f.events().some((e) => e.op === "renew" && e.enabled)).toBe(false);
    appGate.resolve();
    await opening;
    expect(f.sessions.running(f.env.Identity.ID, "api")).toBe(true);
    expect(f.sessions.running(f.env.Identity.ID, "web")).toBe(true);
  } finally {
    rmSync(reserveGate, { force: true });
    rmSync(startGate, { force: true });
    appGate.resolve();
    await opening.catch(() => {});
    await f.close();
  }
}, 10000);

test("a connector that exits during application preparation cannot activate the group", async () => {
  const f = await fixture();
  const gate = Promise.withResolvers<void>();
  const run = f.runtime.run.bind(f.runtime);
  f.runtime.run = async (ctx, spec) => {
    if (spec.name === f.env.Services.api.Container) await gate.promise;
    return run(ctx, spec);
  };
  const opening = f.sessions.open(context(), f.env, randomUUID());
  void opening.catch(() => {});
  try {
    await until(() => f.events().filter((e) => e.op === "initial-gate").length === 2);
    const upstream = f.events().find((e) => e.op === "start").upstream;
    writeFileSync(join(f.home, "calls.disconnected"), "");
    await until(async () => {
      try {
        await fetch(upstream);
        return false;
      } catch {
        return true;
      }
    });
    gate.resolve();
    await expect(opening).rejects.toThrow("connector");
    expect(f.events().some((e) => e.op === "renew" && e.enabled)).toBe(false);
    expect(f.env.tunnel_configuration).toBeUndefined();
  } finally {
    gate.resolve();
    await opening.catch(() => {});
    await f.close();
  }
}, 10000);

test("hub uses the CLI-selected provider even when another command changes the default", async () => {
  const f = await fixture();
  try {
    const path = join(f.home, "tunnels.json");
    const settings = JSON.parse(readFileSync(path, "utf8"));
    settings.default = "unavailable";
    settings.providers.unavailable = { executable: "/unavailable/provider" };
    writeFileSync(path, JSON.stringify(settings));
    const id = randomUUID();
    await call(context(), f.home, "tunnel", {
      env: f.env.Identity.ID,
      session_id: id,
      provider: "fake",
    });
    expect(f.env.tunnels?.web.Provider).toBe("fake");
    await f.sessions.end(f.env, id);
    const calls = f.events().filter((event) => event.op === "reserve").length;
    await expect(f.sessions.open(context(), f.env, randomUUID(), "unavailable")).rejects.toThrow(
      "another provider",
    );
    expect(f.events().filter((event) => event.op === "reserve")).toHaveLength(calls);
    expect(f.env.tunnel_configuration).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("failed connector startup rolls back the entire group and refuses legacy unleased providers", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.home, "legacy"), "");
    const before = [...f.runtime.calls];
    await expect(f.sessions.open(context(), f.env, randomUUID())).rejects.toThrow(
      "foreground_sessions",
    );
    expect(f.runtime.calls).toEqual(before);
    rmSync(join(f.home, "legacy"));
    writeFileSync(join(f.home, "fail"), "");
    writeFileSync(join(f.home, "calls.hold-start-api"), "");
    await expect(f.sessions.open(context(), f.env, randomUUID())).rejects.toThrow("connector");
    expect(f.sessions.running(f.env.Identity.ID, "api")).toBe(false);
    expect(f.env.tunnel_configuration).toBeUndefined();
    expect(f.env.tunnels?.api.Desired).toBe(false);
    expect(f.events().some((e) => e.op === "renew" && e.enabled)).toBe(false);
  } finally {
    await f.close();
  }
}, 20000);

test("a branch switch closes the session even with an explicit deployment branch override", async () => {
  const f = await fixture();
  try {
    const init = Bun.spawn(["git", "init", "--initial-branch=main", f.home], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await init.exited).toBe(0);
    await f.sessions.open(context(), f.env, randomUUID());
    const switchBranch = Bun.spawn(["git", "symbolic-ref", "HEAD", "refs/heads/feature"], {
      cwd: f.home,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await switchBranch.exited).toBe(0);
    await until(() => !f.sessions.sharing(f.env.Identity.ID));
    expect(f.env.tunnel_configuration).toBeUndefined();
  } finally {
    await f.close();
  }
}, 10000);

test("killing the foreground CLI expires exposure and restores local configuration", async () => {
  const f = await fixture();
  const cli = fileURLToPath(new URL("../apps/cli/src/cli.ts", import.meta.url));
  const child = Bun.spawn(
    [process.execPath, cli, "tunnel", "--home", f.home, "--branch", "main", "--json"],
    { cwd: f.home, stdout: "pipe", stderr: "pipe" },
  );
  try {
    await until(() => f.sessions.running(f.env.Identity.ID, "web"));
    const initial = f.events().find((event) => event.op === "start").expires_at;
    await until(() =>
      f.events().some((event) => event.op === "renew" && event.expires_at > initial),
    );
    child.kill("SIGKILL");
    await child.exited;
    await until(() => !f.sessions.sharing(f.env.Identity.ID), 20000);
    expect(f.env.tunnel_configuration).toBeUndefined();
    expect(f.env.tunnels?.api.Desired).toBe(false);
  } finally {
    child.kill();
    await child.exited;
    await f.close();
  }
}, 25000);

test("SIGTERM waits for session cleanup and down ends sharing before taking the environment lock", async () => {
  const f = await fixture();
  const cli = fileURLToPath(new URL("../apps/cli/src/cli.ts", import.meta.url));
  const child = Bun.spawn(
    [process.execPath, cli, "tunnel", "--home", f.home, "--branch", "main", "--json"],
    { cwd: f.home, stdout: "pipe", stderr: "pipe" },
  );
  try {
    await until(() => f.sessions.running(f.env.Identity.ID, "web"));
    child.kill("SIGTERM");
    await until(() => child.exitCode !== null);
    expect(f.sessions.sharing(f.env.Identity.ID)).toBe(false);
    expect(f.env.tunnel_configuration).toBeUndefined();
    await f.sessions.open(context(), f.env, randomUUID());
    await call(context(), f.home, "down", { env: f.env.Identity.ID }, 5000);
    expect(f.env.Status).toBe("stopped");
    expect(f.sessions.sharing(f.env.Identity.ID)).toBe(false);
  } finally {
    child.kill();
    await child.exited;
    await f.close();
  }
}, 15000);

test("failed restoration is journaled and a hub recovery retries local configuration without resuming sharing", async () => {
  const f = await fixture();
  try {
    await f.sessions.open(context(), f.env, randomUUID());
    const run = f.runtime.run.bind(f.runtime);
    f.runtime.run = async (ctx, spec) => {
      if (spec.name === f.env.Services.web.Container) throw Error("simulated restart failure");
      return run(ctx, spec);
    };
    await expect(f.sessions.end(f.env)).rejects.toThrow("cleanup failed");
    expect(f.env.Status).toBe("failed");
    expect(f.env.tunnel_configuration?.pending).toContain("web");
    f.runtime.run = run;
    const recovered = new Manager(new Store(f.home), f.runtime, 9080);
    await recovered.recover(context());
    const env = recovered.resolve(f.env.Identity.ID);
    expect(env.Status).toBe("running");
    expect(env.tunnel_configuration).toBeUndefined();
    expect(env.tunnels?.web.Desired).toBe(false);
    expect(recovered.serviceEnv(env, env.Services.web).API_URL).toBe(
      recovered.localURL(env, "api"),
    );
  } finally {
    await f.close();
  }
}, 10000);

test("permanent provider revocation ends the whole session instead of reconnecting", async () => {
  const f = await fixture();
  try {
    await f.sessions.open(context(), f.env, randomUUID());
    writeFileSync(join(f.home, "calls.revoked"), "");
    await until(() => !f.sessions.sharing(f.env.Identity.ID));
    expect(f.env.tunnel_configuration).toBeUndefined();
    expect(f.events().filter((e) => e.op === "start").length).toBe(2);
  } finally {
    await f.close();
  }
}, 10000);

test("installation identity separates equal local environment IDs on different computers", async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const a = new Tunnels(first.manager, () => undefined);
    const b = new Tunnels(second.manager, () => undefined);
    await a.reserve(context(), first.env, "api");
    const copy = { ...second.env, Identity: first.env.Identity, tunnels: {} };
    await b.reserve(context(), copy, "api");
    const firstRequest = first.events().find((event) => event.op === "reserve");
    const secondRequest = second.events().find((event) => event.op === "reserve");
    expect(firstRequest.machine_id).not.toBe(secondRequest.machine_id);
    expect(firstRequest.environment_id).not.toBe(secondRequest.environment_id);
  } finally {
    await first.close();
    await second.close();
  }
}, 10000);
