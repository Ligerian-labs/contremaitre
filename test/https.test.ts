import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch } from "@contremaitre/cli/client";
import { Manager } from "@contremaitre/environments/manager";
import { Store } from "@contremaitre/environments/store";
import { context } from "@contremaitre/execution/context";
import { application, QueryBus, Show } from "@contremaitre/hub/application";
import { startServer } from "@contremaitre/hub/server";
import { Operations } from "@contremaitre/operations/operations";
import { parseManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { AgentWorkflow } from "@contremaitre/verification/workflow";
import { Effect } from "effect";
import { FakeRuntime } from "./fake-runtime.js";

test("HTTPS URLs omit port 443 for every service and environment reference", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-https-"));
  try {
    const manager = new Manager(new Store(home), new FakeRuntime(), 443, "https");
    const identity = newIdentity("example", home, "main");
    await manager.deploy(context(), {
      root: home,
      identity,
      request: {},
      manifest: parseManifest(`version: 1
project: example
services:
  dashboard:
    image: app
    port: 5173
    http: true
    ready: ["true"]
    environment:
      ORIGIN: '{{dashboard.local_url}}'
  server:
    image: app
    port: 3000
    http: true
    ready: ["true"]
    environment:
      PUBLIC_BASE_URL: '{{dashboard.local_url}}'
`),
    });
    const env = manager.resolve(identity.ID);
    const operations = new Operations(home, 1);
    const app = application({
      agents: new AgentWorkflow(manager, operations),
      manager,
      operations,
      share: async () => {},
    });
    try {
      expect(
        await app.runPromise(
          Effect.flatMap(QueryBus, (bus) => bus.dispatch(Show, { env: identity.ID })),
        ),
      ).toEqual({
        dashboard: `https://${identity.Host}`,
        server: `https://server.${identity.Host}`,
      });
    } finally {
      await app.dispose();
    }
    expect(manager.localURL(env, "dashboard")).toBe(`https://${identity.Host}`);
    expect(manager.localURL(env, "server")).toBe(`https://server.${identity.Host}`);
    expect(manager.serviceEnv(env, env.Services.server).PUBLIC_BASE_URL).toBe(
      `https://${identity.Host}`,
    );
    expect(manager.serviceEnv(env, env.Services.dashboard).CONTREMAITRE_LOCAL_URL).toBe(
      `https://${identity.Host}`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("HTTPS rejects a running HTTP hub before deployment", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-http-hub-"));
  const hub = await startServer({
    home,
    port: 0,
    runtime: new FakeRuntime(),
    skipSystemStart: true,
  });
  try {
    await expect(launch(context(), home, 8080, 0, 8443)).rejects.toThrow("Restart it");
    expect(hub.manager.list()).toEqual([]);
    await expect(launch(context(), home, 8080, 80, 8443)).rejects.toThrow("require --http");
  } finally {
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
});
