import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@contremaitre/cli/client";
import { context, decode } from "@contremaitre/execution/context";
import { startServer } from "@contremaitre/hub/server";
import { operationSchema } from "@contremaitre/operations/operations";
import { initProject } from "@contremaitre/projects/init";
import { FakeRuntime } from "./fake-runtime.js";

test("ensure refreshes compact config and show/report expose every endpoint", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-compact-workflow-")),
    root = join(home, "project");
  mkdirSync(root);
  const api = Bun.serve({ port: 0, fetch: () => new Response("api") });
  const web = Bun.serve({ port: 0, fetch: () => new Response("web") });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ packageManager: "bun@1.3.4", scripts: { dev: "bun server.ts" } }),
  );
  const path = join(root, ".contremaitre.yaml");
  const config = `project: demo\napps:\n  app:\n    endpoints: {api: ${api.port}, web: ${web.port}}\n`;
  writeFileSync(path, config);
  initProject(root);
  const hub = await startServer({
    home,
    port: 0,
    runtime: new FakeRuntime(),
    skipSystemStart: true,
  });
  try {
    const ensure = async () => {
      const op = decode(
        operationSchema,
        await call(context(), home, "ensure", { root, branch: "main" }),
        "operation",
      );
      expect((await hub.operations.wait(op.id)).status).toBe("succeeded");
    };
    await ensure();
    const urls = await call(context(), home, "show", { root, branch: "main" });
    expect(Object.keys(urls as object).sort()).toEqual(["api", "web"]);
    expect(
      Object.keys(
        ((await call(context(), home, "report", { root, branch: "main" })) as { urls: object })
          .urls,
      ).sort(),
    ).toEqual(["api", "web"]);
    writeFileSync(path, config.replace("  app:\n", "  app:\n    memory: 3G\n"));
    await ensure();
    expect(
      JSON.parse(readFileSync(join(root, ".contremaitre.lock"), "utf8")).apps.app.resolved.memory,
    ).toBe("3G");
    expect(Object.values(hub.manager.state.Environments)[0].Services.app.Spec.memory).toBe("3G");
  } finally {
    await hub.close();
    api.stop(true);
    web.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});
