import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "../src/client.js";
import { context, decode } from "../src/model.js";
import { operationSchema } from "../src/operations.js";
import { startServer } from "../src/server.js";
import { FakeRuntime } from "./fake-runtime.js";

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
