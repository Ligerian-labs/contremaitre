import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "@contremaitre/hub/server";
import { FakeRuntime } from "./fake-runtime.js";

const cli = new URL("../apps/cli/src/cli.ts", import.meta.url).pathname;
async function fixture(checks = "") {
  const home = mkdtempSync(join(tmpdir(), "cm-agent-"));
  const root = join(home, "project");
  mkdirSync(root);
  writeFileSync(
    join(root, ".contremaitre.yaml"),
    `version: 1\nproject: demo\nservices:\n  web: {image: nginx:alpine, ready: ["true"]}\n${checks}`,
  );
  writeFileSync(join(root, "source.txt"), "first");
  const runtime = new FakeRuntime();
  const hub = await startServer({ home, port: 0, runtime, skipSystemStart: true });
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, cli, ...args, "--home", home, "--json"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      stdout,
      stderr,
      code,
      data: stdout.trim().startsWith("{") ? JSON.parse(stdout).data : undefined,
    };
  };
  return {
    home,
    root,
    runtime,
    hub,
    run,
    async close() {
      await hub.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("agent commands reuse environments and report missing checks without claiming a pass", async () => {
  const f = await fixture();
  try {
    const first = await f.run("ensure", "--http");
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.data.ready).toBe(true);
    const calls = f.runtime.calls.length;
    const second = await f.run("ensure", "--http");
    expect(second.code).toBe(0);
    expect(second.data.reused).toBe(true);
    expect(f.runtime.calls.length).toBe(calls);
    const verify = await f.run("verify");
    expect(verify.code).not.toBe(0);
    expect(verify.data.status).toBe("not-configured");
    const report = await f.run("report");
    expect(report.code).toBe(0);
    expect(report.data.verification).toBe("not-run");
    const page = await fetch(report.data.review_url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Not run");
  } finally {
    await f.close();
  }
}, 15000);

test("verification captures output and artifacts, bounds diagnostics, and detects source changes", async () => {
  const script = `const fs=require('node:fs');fs.writeFileSync(process.env.CONTREMAITRE_ARTIFACTS+'/result.txt','evidence');console.log('x'.repeat(12000));process.exit(7)`;
  const f = await fixture(
    `verification:\n  profiles:\n    smoke:\n      - name: failing\n        command: ${JSON.stringify([process.execPath, "-e", script])}\n`,
  );
  try {
    expect((await f.run("ensure", "--http")).code).toBe(0);
    const verify = await f.run("verify", "--profile", "smoke");
    expect(verify.code).not.toBe(0);
    expect(verify.data.status).toBe("failed");
    expect(verify.stdout.length).toBeLessThan(1600);
    const diagnostic = await f.run("diagnose", "--run", verify.data.run_id);
    expect(diagnostic.code).toBe(0);
    expect(diagnostic.data.truncated).toBe(true);
    expect(diagnostic.stdout.length).toBeLessThan(7000);
    const report = await f.run("report");
    expect(report.data.stale).toBe(false);
    writeFileSync(join(f.root, "source.txt"), "second");
    expect((await f.run("report")).data.stale).toBe(true);
    const stale = await f.run("verify");
    expect(stale.code).not.toBe(0);
    expect(stale.stdout).toContain("ensure");
  } finally {
    await f.close();
  }
}, 15000);

test("passing checks link immutable artifacts, reject foreign hosts and become stale after redeploy", async () => {
  const script = `const fs=require('node:fs');fs.writeFileSync(process.env.CONTREMAITRE_ARTIFACTS+'/screenshot.png',Buffer.from('89504e470d0a1a0a','hex'));fs.writeFileSync(process.env.CONTREMAITRE_ARTIFACTS+'/output.log','artifact content');console.log('execution content')`;
  const f = await fixture(
    `verification:\n  profiles:\n    smoke:\n      - name: browser\n        command: ${JSON.stringify([process.execPath, "-e", script])}\n`,
  );
  try {
    expect((await f.run("ensure", "--http")).code).toBe(0);
    const verified = await f.run("verify");
    expect(verified.code).toBe(0);
    expect(verified.data.counts).toEqual({ passed: 1, failed: 0, skipped: 0 });
    expect(verified.stderr).toBe("");
    const report = await f.run("report");
    const page = await fetch(report.data.review_url);
    const html = await page.text();
    const path = html.match(/href="([^"]+\/browser\/screenshot.png)"/)?.[1];
    expect(path).toBeDefined();
    const artifact = await fetch(new URL(path ?? "/", report.data.review_url));
    expect(artifact.headers.get("content-type")).toBe("image/png");
    expect((await artifact.arrayBuffer()).byteLength).toBe(8);
    const logArtifact = html.match(/href="([^"]+\/artifact\/[^"]+\/browser\/output.log)"/)?.[1];
    expect(logArtifact).toBeDefined();
    expect(await (await fetch(new URL(logArtifact ?? "/", report.data.review_url))).text()).toBe(
      "artifact content",
    );
    expect(
      (await fetch(report.data.review_url, { headers: { host: "attacker.example" } })).status,
    ).toBe(403);
    expect((await fetch(new URL("/wrong-token", report.data.review_url))).status).toBe(404);
    const redeploy = await f.run("deploy", "--http");
    expect(redeploy.code).toBe(0);
    expect((await f.run("report")).data.stale).toBe(true);
  } finally {
    await f.close();
  }
}, 15000);

test("cancelled verification persists an interrupted result and quiet wait exits nonzero", async () => {
  const f = await fixture(
    `verification:\n  profiles:\n    smoke:\n      - name: slow\n        command: ${JSON.stringify([process.execPath, "-e", "console.log('started');setInterval(()=>{},1000)"])}\n`,
  );
  try {
    expect((await f.run("ensure", "--http")).code).toBe(0);
    const accepted = await f.run("verify", "--detach");
    expect(accepted.code).toBe(0);
    for (let i = 0; i < 100; i++) {
      if (
        f.hub.agents.evidence.latest(
          accepted.data.environment_id ?? Object.keys(f.hub.manager.state.Environments)[0],
        )?.checks[0].status === "running"
      )
        break;
      await Bun.sleep(10);
    }
    const cancelled = await f.run("cancel", accepted.data.operation_id);
    expect(cancelled.code).toBe(0);
    expect(cancelled.data.status).toBe("cancelled");
    const waited = await f.run("wait", accepted.data.operation_id);
    expect(waited.code).not.toBe(0);
    expect(waited.stderr).toBe("");
    expect(waited.stdout).not.toContain("started");
    expect((await f.run("report")).data.verification).toBe("interrupted");
  } finally {
    await f.close();
  }
}, 15000);

test("timeouts and source edits during checks cannot produce a passing handoff", async () => {
  const f = await fixture(
    `verification:\n  profiles:\n    smoke:\n      - name: timeout\n        timeout_seconds: 1\n        command: ${JSON.stringify([process.execPath, "-e", "setInterval(()=>{},1000)"])}\n    editing:\n      - name: edits\n        command: ${JSON.stringify([process.execPath, "-e", "require('node:fs').writeFileSync('source.txt','edited by check')"])}\n`,
  );
  try {
    expect((await f.run("ensure", "--http")).code).toBe(0);
    expect((await f.run("verify")).data.status).toBe("failed");
    const editing = await f.run("verify", "--profile", "editing");
    expect(editing.code).not.toBe(0);
    expect(editing.data.stale).toBe(true);
    expect((await f.run("report")).data.source_current).toBe(false);
  } finally {
    await f.close();
  }
}, 15000);

test("host artifact symlinks are rejected and successful evidence survives hub restart", async () => {
  const script = `const fs=require('node:fs');fs.symlinkSync('/etc/passwd',process.env.CONTREMAITRE_ARTIFACTS+'/leak.txt')`;
  const f = await fixture(
    `verification:\n  profiles:\n    smoke:\n      - name: symlink\n        command: ${JSON.stringify([process.execPath, "-e", script])}\n    passing:\n      - name: pass\n        command: ${JSON.stringify([process.execPath, "-e", "process.exit(0)"])}\n`,
  );
  try {
    expect((await f.run("ensure", "--http")).code).toBe(0);
    const rejected = await f.run("verify");
    expect(rejected.data.status).toBe("failed");
    expect(f.hub.agents.evidence.get(rejected.data.run_id).checks[0].artifacts).toEqual([]);
    const passing = await f.run("verify", "--profile", "passing");
    expect(passing.code).toBe(0);
    await f.hub.close();
    const restarted = await startServer({
      home: f.home,
      port: 0,
      runtime: f.runtime,
      skipSystemStart: true,
    });
    try {
      const result = await f.run("report");
      expect(result.data.verification).toBe("passed");
      expect(result.data.stale).toBe(false);
      expect((await fetch(result.data.review_url)).status).toBe(200);
    } finally {
      await restarted.close();
    }
  } finally {
    await f.close();
  }
}, 15000);
