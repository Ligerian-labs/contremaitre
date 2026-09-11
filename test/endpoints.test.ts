import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "@contremaitre/environments/manager";
import { httpEndpoints } from "@contremaitre/environments/model";
import { Store } from "@contremaitre/environments/store";
import { context } from "@contremaitre/execution/context";
import { routes } from "@contremaitre/hub/server";
import { parseManifest, prepareManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";

test("one container routes several endpoints, resolves internal URLs, and restarts once for sharing", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-endpoints-"));
  const api = Bun.serve({ port: 0, fetch: () => new Response("api") });
  const web = Bun.serve({ port: 0, fetch: () => new Response("web") });
  const runtime = new FakeRuntime(),
    manager = new Manager(new Store(home), runtime, 443, "https");
  try {
    const identity = newIdentity("demo", home, "main");
    const manifest = prepareManifest(
      home,
      parseManifest(`version: 1
project: demo
services:
  app:
    image: app
    endpoints: {web: ${web.port}, api: ${api.port}}
    environment:
      API_URL: '{{api.browser_url}}'
      SELF_URL: '{{api.url}}'
      WEB_ORIGINS: '{{web.browser_origins}}'
  worker:
    image: worker
    depends_on: [app]
    environment: {API_URL: '{{api.url}}'}
`),
    );
    await manager.deploy(context(), { root: home, identity, manifest, request: {} });
    const env = manager.resolve(identity.ID);
    expect(Object.keys(httpEndpoints(env))).toEqual(["api", "web"]);
    expect(runtime.calls.filter((call) => call.startsWith("run "))).toHaveLength(2);
    expect(routes(manager, new URL(manager.localURL(env, "web")).hostname)?.upstream).toBe(
      `http://127.0.0.1:${web.port}`,
    );
    expect(routes(manager, `${identity.ID}/api`)?.upstream).toBe(`http://127.0.0.1:${api.port}`);
    expect(manager.serviceEnv(env, env.Services.app).SELF_URL).toBe(`http://127.0.0.1:${api.port}`);
    expect(manager.serviceEnv(env, env.Services.worker).API_URL).toBe(
      `http://127.0.0.1:${api.port}`,
    );
    expect(manager.serviceEnv(env, env.Services.app).API_URL).toBe(`https://${identity.Host}`);
    expect(api.port).toBe(env.Services.app.Port);
    runtime.calls = [];
    await manager.configureTunnel(context(), env, {
      api: "https://api.example.test",
      web: "https://web.example.test",
    });
    expect(runtime.calls.filter((call) => call.startsWith("run "))).toEqual([
      `run ${env.Services.app.Container}`,
    ]);
    expect(manager.serviceEnv(env, env.Services.app).API_URL).toBe("https://api.example.test");
    expect(JSON.parse(manager.serviceEnv(env, env.Services.app).WEB_ORIGINS)).toContain(
      "https://web.example.test",
    );
    await manager.configureTunnel(context(), env, {});
    expect(manager.serviceEnv(env, env.Services.app).API_URL).toBe(`https://${identity.Host}`);
  } finally {
    await manager.stopDevelopment();
    api.stop(true);
    web.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});

test("every named endpoint must listen before its container becomes ready", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-endpoint-ready-"));
  const ready = Bun.serve({ port: 0, fetch: () => new Response("ready") });
  const closed = Bun.serve({ port: 0, fetch: () => new Response("closed") });
  const closedPort = closed.port;
  closed.stop(true);
  const manager = new Manager(new Store(home), new FakeRuntime());
  try {
    const identity = newIdentity("demo", home, "main");
    const manifest = parseManifest(
      `version: 1\nproject: demo\nservices:\n  app:\n    image: app\n    ready: ["true"]\n    endpoints: {api: ${ready.port}, web: ${closedPort}}\n`,
    );
    await expect(
      manager.deploy(context(AbortSignal.timeout(150)), {
        root: home,
        identity,
        manifest,
        request: {},
      }),
    ).rejects.toThrow();
    const env = manager.resolve(identity.ID);
    expect(env.Services.app.ready).toBe(false);
    expect(routes(manager, `${identity.ID}/api`)?.upstream).toBe("");
  } finally {
    ready.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});

test("endpoint names cannot shadow containers or another endpoint", () => {
  for (const services of [
    "app: {image: app, endpoints: {web: 3000}}\n  web: {image: other}",
    "app: {image: app, endpoints: {web: 3000}}\n  other: {image: other, endpoints: {web: 4000}}",
    "app: {image: app, endpoints: {web: 0}}",
    "db: {kind: postgres, endpoints: {web: 3000}}",
  ])
    expect(() => parseManifest(`version: 1\nproject: demo\nservices:\n  ${services}\n`)).toThrow();
});

test("endpoint references accept transitive dependencies on their owning container", () => {
  expect(() =>
    prepareManifest(
      ".",
      parseManifest(`version: 1
project: demo
services:
  app: {image: app, endpoints: {api: 8000}}
  middle: {image: middle, depends_on: [app]}
  worker: {image: worker, depends_on: [middle], environment: {API: '{{api.url}}'}}
`),
    ),
  ).not.toThrow();
});
