import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { application, Deploy, List, QueryBus } from "@contremaitre/hub/application";
import { routes, startServer } from "@contremaitre/hub/server";
import { closeServer, listen, proxyServer } from "@contremaitre/routing/proxy";
import { defineFixture, defineScenario, makeCatalog, run } from "@structure-ai/fixtures";
import { Effect, Schema } from "effect";
import { FakeRuntime } from "./fake-runtime.js";

export async function namingFixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cm-naming-fixture-")));
  const upstreams = ["first", "second"].map((value) =>
    Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(value) }),
  );
  const hub = await startServer({
    home,
    port: 0,
    runtime: new FakeRuntime(),
    skipSystemStart: true,
  });
  const proxy = proxyServer((host) => routes(hub.manager, host));
  const app = application({
    ...hub,
    share: async () => {
      throw Error("Sharing disabled in fixture");
    },
  });
  const workspaces = defineFixture({
    key: "naming/workspaces",
    create: ({ id }) =>
      Effect.sync(() =>
        upstreams.map((upstream, index) => {
          const root = join(home, id(`workspace-${index}`), "app");
          mkdirSync(root, { recursive: true });
          writeFileSync(
            join(root, ".contremaitre.yaml"),
            `version: 1
project: naming
services:
  api: {image: app, endpoints: {api: ${upstream.port}, web: ${upstream.port}}, ready: ["true"]}
`,
          );
          return root;
        }),
      ),
  });
  const environments = defineFixture({
    key: "naming/environments",
    dependencies: { workspaces },
    create: ({ dispatch, dependencies }) =>
      Effect.gen(function* () {
        const ids: string[] = [];
        for (const [index, root] of dependencies.workspaces.entries()) {
          const operation = yield* dispatch(Deploy, {
            root,
            branch: index === 0 ? "feature/a" : "feature-a",
          });
          const result = yield* Effect.tryPromise(() => hub.operations.wait(operation.id));
          assert.equal(result.status, "succeeded");
          ids.push(operation.environmentId);
        }
        return ids;
      }),
  });
  const catalog = makeCatalog({
    base: { workspaces },
    scenarios: [
      defineScenario({
        name: "environments/readable-names",
        description: "Two workspaces with colliding normalized names retain separate HTTP routes",
        input: Schema.Struct({}),
        fixtures: () => ({ environments }),
      }),
    ],
  });
  try {
    await listen(proxy, 0);
    const port = (proxy.address() as AddressInfo).port;
    const fixtures = await Effect.runPromise(catalog.prepare("environments/readable-names", {}));
    const report = await app.runPromise(
      run({
        fixtures,
        enabled: true,
        ready: () =>
          Effect.gen(function* () {
            const queries = yield* QueryBus;
            const listed = yield* queries.dispatch(List, {});
            assert.equal((listed as unknown[]).length, 2);
          }),
      }),
    );
    const ids = Schema.decodeUnknownSync(Schema.Array(Schema.String))(report.values.environments);
    const [first, second] = ids.map((id) => hub.manager.resolve(id));
    assert.equal(first.Identity.Name, "naming/feature-a-app");
    assert.equal(first.Identity.Host, "feature-a-app.naming.localhost");
    assert.equal(
      second.Identity.Host,
      `feature-a-app-${second.Identity.ID.slice(0, 8)}.naming.localhost`,
    );
    const observations: Record<string, string> = {};
    for (const [index, env] of [first, second].entries()) {
      for (const endpoint of ["api", "web"]) {
        const host = new URL(hub.manager.localURL(env, endpoint)).hostname;
        assert.equal(host, `${endpoint === "api" ? "" : "web."}${env.Identity.Host}`);
        const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { host } });
        assert.equal(response.status, 200);
        const body = await response.text();
        assert.equal(body, index === 0 ? "first" : "second");
        observations[host] = body;
      }
    }
    return {
      scenario: "environments/readable-names",
      input: {},
      run_id: report.runId,
      environment_ids: ids,
      observations,
    };
  } finally {
    await app.dispose();
    await closeServer(proxy);
    await hub.close();
    for (const upstream of upstreams) upstream.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) console.log(JSON.stringify(await namingFixture(), null, 2));
