import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "@contremaitre/environments/manager";
import { Store } from "@contremaitre/environments/store";
import { context } from "@contremaitre/execution/context";
import { parseManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";

test("browser URL dependencies resolve locally before sharing without startup dependencies", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-browser-url-"));
  try {
    const manifest = parseManifest(`version: 1
project: example
services:
  api:
    image: app
    http: true
    port: 3000
    ready: ["true"]
    environment: {ORIGIN: '{{web.browser_url}}'}
  web:
    image: app
    http: true
    port: 4200
    ready: ["true"]
    environment: {API_URL: '{{api.browser_url}}'}
`);
    const manager = new Manager(new Store(home), new FakeRuntime(), 443, "https");
    const identity = newIdentity("example", home, "main");
    await manager.deploy(context(), { root: home, identity, manifest, request: {} });
    const env = manager.resolve(identity.ID);
    expect(manager.serviceEnv(env, env.Services.web).API_URL).toBe(`https://${identity.Host}`);
    expect(manager.serviceEnv(env, env.Services.api).ORIGIN).toBe(`https://web.${identity.Host}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
