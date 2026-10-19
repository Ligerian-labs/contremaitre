import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "@contremaitre/environments/manager";
import { Store } from "@contremaitre/environments/store";
import { context } from "@contremaitre/execution/context";
import { parseManifest, prepareManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";

const text = `version: 1
project: workloads
services:
  migrate:
    workload: job
    image: alpine
    command: [echo, migrated]
    timeout_seconds: 10
  worker:
    workload: worker
    image: alpine
    command: [sleep, infinity]
    depends_on: [migrate]
`;
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cm-workloads-"));
  const runtime = new FakeRuntime();
  const manager = new Manager(new Store(home), runtime);
  const prepared = {
    root: home,
    identity: newIdentity("workloads", home, "main"),
    manifest: prepareManifest(home, parseManifest(text)),
    request: {},
  };
  return {
    home,
    runtime,
    manager,
    prepared,
    clean: () => rmSync(home, { recursive: true, force: true }),
  };
}
test("workload validation accepts command Wasm and rejects incompatible lifecycle settings", () => {
  expect(parseManifest(text).services.worker.workload).toBe("worker");
  expect(
    parseManifest(
      `version: 1\nproject: jobs\nservices:\n  task: {runtime: wasm, workload: job, wasm: {component: job.wasm}}`,
    ).services.task.port,
  ).toBe(0);
  for (const invalid of [
    text.replace("workload: worker", "workload: unknown"),
    text.replace("workload: worker", "workload: worker\n    port: 1234"),
    text.replace("workload: job", "workload: job\n    http: true\n    port: 1234"),
    text.replace("timeout_seconds: 10", "timeout_seconds: 0"),
    text.replace("workload: job", "kind: postgres\n    workload: job"),
  ])
    expect(() => parseManifest(invalid)).toThrow();
});
test("jobs finish before workers start and unchanged successful jobs are retained", async () => {
  const f = fixture();
  try {
    await f.manager.deploy(context(), f.prepared);
    const env = f.manager.resolve(f.prepared.identity.ID);
    expect(env.Services.migrate.job?.status).toBe("succeeded");
    expect(env.Services.migrate.Host).toBe("");
    expect(f.runtime.containers.has(env.Services.migrate.Container)).toBe(false);
    expect(f.runtime.containers.get(env.Services.worker.Container)?.Running).toBe(true);
    f.runtime.calls = [];
    await f.manager.deploy(context(), f.prepared);
    expect(f.runtime.calls.filter((c) => c.startsWith("run "))).toEqual([]);
    await f.manager.recover(context());
    expect(env.Status).toBe("running");
    expect(f.runtime.calls.filter((c) => c.startsWith("run "))).toEqual([]);
    await f.manager.deploy(context(), { ...f.prepared, request: { rebuild: true } });
    expect(f.runtime.calls.filter((c) => c.startsWith("run "))).toHaveLength(2);
  } finally {
    f.clean();
  }
});
test("a failed job blocks dependents and retains its failed status", async () => {
  const f = fixture();
  try {
    f.runtime.failTask = true;
    await expect(f.manager.deploy(context(), f.prepared)).rejects.toThrow("task failed");
    const env = f.manager.resolve(f.prepared.identity.ID);
    expect(env.Services.migrate.job?.status).toBe("failed");
    expect(f.runtime.containers.has(env.Services.worker.Container)).toBe(false);
    f.runtime.failTask = false;
    await f.manager.deploy(context(), f.prepared);
    expect(env.Services.migrate.job?.status).toBe("succeeded");
    expect(env.Status).toBe("running");
  } finally {
    f.clean();
  }
});
test("job dependencies allow ordering but reject address references", () => {
  expect(() => prepareManifest(".", parseManifest(text))).not.toThrow();
  expect(() =>
    prepareManifest(
      ".",
      parseManifest(
        text.replace(
          "depends_on: [migrate]",
          "depends_on: [migrate]\n    environment: {JOB_URL: '{{migrate.url}}'}",
        ),
      ),
    ),
  ).toThrow("has no network address");
});
test("recovery cleans an interrupted job without replaying its side effects", async () => {
  const f = fixture();
  try {
    await f.manager.deploy(context(), f.prepared);
    const env = f.manager.resolve(f.prepared.identity.ID);
    const s = env.Services.migrate;
    s.job = { status: "running" };
    env.Status = "deploying";
    f.runtime.containers.set(s.Container, { Host: "127.0.0.1", Running: true });
    f.manager.save();
    f.runtime.calls = [];
    await f.manager.recover(context());
    expect(s.job.status).toBe("interrupted");
    expect(f.runtime.containers.has(s.Container)).toBe(false);
    expect(f.runtime.calls.some((call) => call.startsWith("run "))).toBe(false);
    expect(env.Status).toBe("failed");
  } finally {
    f.clean();
  }
});
