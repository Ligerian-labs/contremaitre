// Native benchmark: bun scripts/benchmark-boot.ts [path/to/compiled/contremaitre]
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { context } from "@contremaitre/execution/context";
import { startServer } from "@contremaitre/hub/server";

const binary = resolve(process.argv[2] ?? "bin/contremaitre");
const directory = mkdtempSync(join(tmpdir(), "cm-boot-benchmark-"));
const home = join(directory, "state"),
  root = join(directory, "project");
mkdirSync(root);
writeFileSync(
  join(root, ".contremaitre.yaml"),
  `version: 1
project: boot-benchmark
services:
  web:
    image: docker.io/library/nginx:alpine
    command: [sh, -ec, 'test -f /usr/share/nginx/html/index.html || echo boot-proof > /usr/share/nginx/html/index.html; exec nginx -g "daemon off;"']
    port: 80
    http: true
    volumes: {uploads: /usr/share/nginx/html}
    ready: [wget, -q, -O, /dev/null, 'http://127.0.0.1/']
verification:
  profiles:
    smoke:
      - name: response
        command: [${JSON.stringify(process.execPath)}, -e, 'if ((await (await fetch(process.env.CONTREMAITRE_BASE_URL)).text()).trim() !== "boot-proof") process.exit(1)']
`,
);
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert(address && typeof address !== "string");
    server.close(() => resolve(address.port));
  });
});
const hub = await startServer({ home, port });
const samples: Record<string, number[]> = {
  new_environment: [],
  running_reuse: [],
  stopped_boot: [],
};
const command = async (...args: string[]) => {
  const started = performance.now();
  const child = Bun.spawn([binary, ...args, "--home", home, "--json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const elapsed = performance.now() - started;
  assert.equal(code, 0, `${args.join(" ")}: ${stderr}\n${stdout}`);
  return { data: JSON.parse(stdout).data, elapsed };
};
try {
  const boot = async (kind: keyof typeof samples) => {
    const { data, elapsed } = await command("ensure", "--http", "--branch", "benchmark");
    assert.equal(data.ready, true);
    assert.equal(data.reused, kind === "running_reuse");
    const env = hub.manager.resolve(data.environment_id);
    const response = await fetch(`http://127.0.0.1:${hub.proxyPort}`, {
      headers: { host: new URL(data.urls.web).hostname },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.text()).trim(), "boot-proof");
    assert.equal(env.Status, "running");
    samples[kind].push(Math.round(elapsed));
  };
  await boot("new_environment");
  for (let i = 0; i < 10; i++) await boot("running_reuse");
  for (let i = 0; i < 3; i++) {
    await command("down", "--branch", "benchmark");
    await boot("stopped_boot");
  }
  const verification = await command("verify", "--profile", "smoke", "--branch", "benchmark");
  assert.equal(verification.data.status, "passed");
  const report = await command("report", "--branch", "benchmark");
  assert.equal(report.data.ready, true);
  assert.equal(report.data.source_current, true);
  assert.equal(report.data.verification, "passed");
  assert.equal(report.data.stale, false);
  console.log(
    JSON.stringify(
      {
        scenario: "boot/cached-nginx-http",
        budget_ms: 500,
        hub: "already running, isolated HTTP",
        image: "docker.io/library/nginx:alpine",
        cli: binary,
        samples_ms: samples,
        under_budget: Object.fromEntries(
          Object.entries(samples).map(([kind, values]) => [kind, values.every((ms) => ms < 500)]),
        ),
        response_verified: true,
        verification: report.data.counts,
      },
      null,
      2,
    ),
  );
} finally {
  for (const env of Object.values(hub.manager.state.Environments))
    await hub.manager.down(context(AbortSignal.timeout(30_000)), env, true);
  await hub.close();
  rmSync(directory, { recursive: true, force: true });
}
