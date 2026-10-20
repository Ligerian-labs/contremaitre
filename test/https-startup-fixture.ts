import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@contremaitre/cli/client";
import { context, HubError } from "@contremaitre/execution/context";
import { attempt } from "@contremaitre/execution/effect";
import { lockHome } from "@contremaitre/execution/files";
import { run as processRun } from "@contremaitre/execution/process";
import { application, Deploy } from "@contremaitre/hub/application";
import { startServer } from "@contremaitre/hub/server";
import { defineFixture, defineScenario, makeCatalog, run } from "@structure-ai/fixtures";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { commandFailure } from "../apps/cli/src/errors.js";
import { FakeRuntime } from "./fake-runtime.js";

// Every resource belongs to this temporary target; no machine trust store is changed.
export async function httpsPortConflictFixture(retain = false) {
  const home = mkdtempSync(join(tmpdir(), "cm-https-startup-fixture-"));
  const runtime = new FakeRuntime();
  let hub = await startServer({ home, port: 0, runtime });
  const app = application({
    ...hub,
    share: async () => {
      throw Error("Sharing disabled in fixture");
    },
  });
  const occupied = createServer();
  const previousRoot = process.env.CAROOT;
  const project = defineFixture({
    key: "https-startup/project",
    create: ({ dispatch, id }) =>
      Effect.gen(function* () {
        const root = join(home, id("workspace"));
        mkdirSync(root);
        writeFileSync(
          join(root, ".contremaitre.yaml"),
          'version: 1\nproject: https-startup\nservices:\n  web: {image: app, ready: ["true"]}\n',
        );
        const op = yield* dispatch(Deploy, { root, branch: "fixture" });
        const result = yield* attempt(() => hub.operations.wait(op.id));
        assert.equal(result.status, "succeeded");
        return op.environmentId;
      }),
  });
  const retry = defineFixture({
    key: "https-startup/retry",
    dependencies: { project },
    create: ({ dependencies }) =>
      Effect.gen(function* () {
        yield* attempt(() => hub.close());
        yield* attempt(
          () => new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve)),
        );
        const address = occupied.address();
        assert(address && typeof address !== "string");
        const options = { home, port: 8080, httpsPort: address.port, runtime };
        const failed = yield* Effect.exit(attempt(() => startServer(options)));
        assert(Exit.isFailure(failed));
        const failure = Option.getOrThrow(Cause.failureOption(failed.cause));
        assert(failure instanceof HubError);
        assert.equal(failure.classification, "conflict");
        assert(failure.cause instanceof Error && "code" in failure.cause);
        assert.equal(failure.cause.code, "EADDRINUSE");
        const reported = commandFailure(failed.cause);
        assert.equal(reported.code, 1);
        assert.equal(reported.text, `Local HTTPS port ${address.port} is already in use`);
        assert(!existsSync(join(home, "hub.sock")));
        lockHome(home)();
        yield* attempt(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
        hub = yield* attempt(() => startServer(options));
        assert.equal(hub.manager.resolve(dependencies.project).Status, "running");
        return { environmentId: dependencies.project, port: address.port, error: reported.text };
      }),
  });
  const catalog = makeCatalog({
    base: { project },
    scenarios: [
      defineScenario({
        name: "hub/https-port-conflict",
        description: "An occupied HTTPS port reports a conflict and allows startup after release",
        input: Schema.Struct({}),
        fixtures: () => ({ retry }),
      }),
    ],
  });
  try {
    const caRoot = join(home, "ca");
    mkdirSync(caRoot);
    await processRun(
      context(),
      [
        "mkcert",
        "-cert-file",
        join(home, "bootstrap.pem"),
        "-key-file",
        join(home, "bootstrap-key.pem"),
        "localhost",
      ],
      { env: { ...process.env, CAROOT: caRoot } },
    );
    process.env.CAROOT = caRoot;
    const fixtures = await Effect.runPromise(catalog.prepare("hub/https-port-conflict", {}));
    const report = await app.runPromise(
      run({
        fixtures,
        enabled: true,
        ready: () =>
          attempt(async () => {
            const health = await call(context(), home, "health");
            assert(health && typeof health === "object" && "local_https" in health);
            assert.equal(health.local_https, true);
            const environments = await call(context(), home, "list");
            assert(Array.isArray(environments));
            assert.equal(environments.length, 1);
            assert.equal(environments[0].Status, "running");
          }),
      }),
    );
    return {
      scenario: "hub/https-port-conflict",
      input: {},
      target: "isolated FakeRuntime with disposable mkcert CA",
      run_id: report.runId,
      home,
      proof: report.values.retry,
      retained: retain,
      verified: [
        "HTTPS port collision preserves its typed conflict and system cause",
        "CLI reports the occupied port",
        "failed startup releases the control socket and home lock",
        "retry serves a healthy hub with the deployed environment after port release",
      ],
    };
  } finally {
    try {
      if (!retain && !hub.closed)
        for (const env of hub.manager.list())
          await call(context(), home, "down", { env: env.Identity.ID, delete_data: true });
    } finally {
      await app.dispose();
      await hub.close();
      if (occupied.listening) await new Promise<void>((resolve) => occupied.close(() => resolve()));
      if (previousRoot === undefined) delete process.env.CAROOT;
      else process.env.CAROOT = previousRoot;
      if (!retain) rmSync(home, { recursive: true, force: true });
    }
  }
}

if (import.meta.main)
  console.log(
    JSON.stringify(await httpsPortConflictFixture(process.argv.includes("--retain")), null, 2),
  );
