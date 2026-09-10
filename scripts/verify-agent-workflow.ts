// Opt-in native check: bun scripts/verify-agent-workflow.ts [--inspect]
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context } from "@contremaitre/execution/context";
import { startServer } from "@contremaitre/hub/server";
import { AgentWorkflow } from "@contremaitre/verification/workflow";

const home = mkdtempSync(join(tmpdir(), "cm-native-agents-")),
  root = join(home, "project");
mkdirSync(root);
const port = await new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const addr = s.address();
    assert(addr && typeof addr !== "string");
    s.close(() => resolve(addr.port));
  });
});
const app = (text: string) =>
  `Bun.serve({hostname:'0.0.0.0',port:3000,fetch(){return new Response('<!doctype html><html><head><title>Agent preview</title></head><body><h1>${text}</h1><p>Running in an isolated Contremaitre container.</p></body></html>',{headers:{'content-type':'text/html'}})}});`;
writeFileSync(join(root, "app.ts"), app("Preview ready"));
writeFileSync(
  join(root, ".contremaitre.yaml"),
  `version: 1
project: agent-smoke
services:
  web:
    image: oven/bun:1.3.4
    command: [bun, app.ts]
    working_dir: /app
    port: 3000
    http: true
    ready: [bun, -e, "if(!(await fetch('http://127.0.0.1:3000')).ok)process.exit(1)"]
    dev: {source: '.', target: /app}
verification:
  profiles:
    smoke:
      - name: response
        service: web
        command: [bun, -e, "const text=await(await fetch('http://127.0.0.1:3000')).text();if(!text.includes('Preview ready'))process.exit(1);await Bun.write(process.env.CONTREMAITRE_ARTIFACTS+'/response.html',text);console.log('Response content verified');"]
        artifacts: [response.html]
    slow:
      - name: slow
        service: web
        timeout_seconds: 10
        command: [bun, -e, "setInterval(()=>{},1000)"]
`,
);
const hub = await startServer({ home: join(home, "state"), port });
const ctx = context(AbortSignal.timeout(180_000));
const req = { root, branch: "agent-smoke" };
try {
  const ensure = await hub.agents.ensure(ctx, req);
  assert.equal((await hub.operations.wait(ensure.id)).status, "succeeded");
  const ready = await hub.agents.report(ctx, req);
  assert.equal(ready.ready, true);
  assert.equal(ready.source_current, true);
  const reused = await hub.agents.ensure(ctx, req);
  await hub.operations.wait(reused.id);
  assert.equal(hub.agents.ensureResult(reused.id).reused, true);
  const verify = await hub.agents.verify(ctx, req);
  assert("id" in verify);
  assert.equal((await hub.operations.wait(verify.id)).status, "succeeded");
  const report = await hub.agents.report(ctx, req);
  assert.equal(report.verification, "passed");
  assert.equal(report.stale, false);
  assert(
    (await (await fetch(report.review_url)).text()).includes("Response") ||
      (await (await fetch(report.review_url)).text()).includes("response"),
  );
  console.log(
    JSON.stringify({
      home,
      review_url: report.review_url,
      app_url: Object.values(report.urls)[0],
      run_id: verify.id,
      response_bytes: Buffer.byteLength(JSON.stringify({ version: 1, data: report })),
    }),
  );
  writeFileSync(join(home, "review.json"), JSON.stringify(report));
  if (process.argv.includes("--inspect")) {
    for (let i = 0; i < 120 && !existsSync(join(home, "finish")); i++) await Bun.sleep(1000);
  }
  writeFileSync(join(root, "app.ts"), app("Edited preview"));
  assert.equal((await hub.agents.report(ctx, req)).stale, true);
  const changed = await hub.agents.ensure(ctx, req);
  assert.equal((await hub.operations.wait(changed.id)).status, "succeeded");
  const failed = await hub.agents.verify(ctx, req);
  assert("id" in failed);
  assert.equal((await hub.operations.wait(failed.id)).status, "failed");
  assert.equal(hub.agents.result(failed.id).status, "failed");
  const slow = await hub.agents.verify(ctx, req, "slow");
  assert("id" in slow);
  const env = await hub.agents.environment(ctx, req),
    container = env.Services.web.Container;
  let pid = "";
  for (let i = 0; i < 50; i++) {
    try {
      pid = (
        await hub.manager.runtime.exec(ctx, container, [
          "cat",
          `/tmp/contremaitre-${slow.id}/slow/.pid`,
        ])
      )
        .toString()
        .trim();
      if (pid) break;
    } catch {}
    await Bun.sleep(50);
  }
  assert(/^\d+$/.test(pid), "Check process group was not created");
  await hub.operations.cancel(slow.id);
  await assert.rejects(
    () => hub.manager.runtime.exec(ctx, container, ["kill", "-0", `-${pid}`]),
    "Cancelled check still has a live process group",
  );
  const recovered = new AgentWorkflow(hub.manager, hub.operations);
  assert.equal(recovered.evidence.get(verify.id).status, "passed");
  console.log(
    "Native ensure/reuse, container checks, artifact collection, live report, stale detection and failing check passed.",
  );
} finally {
  for (const env of Object.values(hub.manager.state.Environments))
    await hub.manager.down(context(AbortSignal.timeout(60000)), env, true);
  await hub.close();
  rmSync(home, { recursive: true, force: true });
}
