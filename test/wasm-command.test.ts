import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Manager } from "@contremaitre/environments/manager";
import { Store } from "@contremaitre/environments/store";
import { context } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";
import { parseManifest, prepareManifest } from "@contremaitre/projects/config";
import { newIdentity } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";

const real = Bun.which("wasmtime") && Bun.which("cargo") ? test : test.skip;
const root = resolve("test/fixtures/wasm-command");
let target = "";
beforeAll(async () => {
  if (!Bun.which("wasmtime") || !Bun.which("cargo")) return;
  target = join(tmpdir(), "contremaitre-wasm-command-target");
  await run(
    context(),
    [
      "cargo",
      "build",
      "--release",
      "--locked",
      "--target",
      "wasm32-wasip2",
      "--target-dir",
      target,
    ],
    { cwd: root, timeout: 120000 },
  );
}, 150000);

function fixture(argument: string, workload = "job", timeout = 10) {
  const home = mkdtempSync(join(tmpdir(), "cm-wasm-command-"));
  const manager = new Manager(new Store(home), new FakeRuntime());
  // The component lives inside the fixture root, as it would after a host build.
  const component = "command.wasm";
  const project = join(home, "project");
  const prepared = async () => {
    const { mkdir, copyFile } = await import("node:fs/promises");
    await mkdir(project, { recursive: true });
    await copyFile(
      join(target, "wasm32-wasip2/release/wasm-command.wasm"),
      join(project, component),
    );
    return {
      root: project,
      identity: newIdentity("commands", project, "main"),
      manifest: prepareManifest(
        project,
        parseManifest(`version: 1
project: commands
services:
  command:
    runtime: wasm
    workload: ${workload}
    ${workload === "job" ? `timeout_seconds: ${timeout}` : ""}
    wasm: {component: ${component}}
    command: [${argument}]
    volumes: {results: /data}
    environment: {MESSAGE: hello}
`),
      ),
      request: {},
    };
  };
  return {
    home,
    manager,
    prepared,
    clean: async () => {
      for (const env of Object.values(manager.state.Environments))
        await manager.down(context(), env, true);
      await manager.stopDevelopment();
      await manager.stopNetworking();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
real(
  "real WASI jobs receive arguments, environment and persistent volumes, and are retained",
  async () => {
    const f = fixture("write");
    try {
      const p = await f.prepared();
      await f.manager.deploy(context(), p);
      const env = f.manager.resolve(p.identity.ID);
      expect(env.Services.command.job?.status).toBe("succeeded");
      const data = join(f.home, "data", env.Identity.ID, "results/result.txt");
      expect(readFileSync(data, "utf8")).toBe("done\n");
      expect(
        readFileSync(join(f.home, "data", env.Identity.ID, ".jobs/command.log"), "utf8"),
      ).toContain("command:hello");
      await f.manager.deploy(context(), p);
      await f.manager.recover(context());
      expect(readFileSync(data, "utf8")).toBe("done\n");
      await f.manager.deploy(context(), { ...p, request: { rebuild: true } });
      expect(readFileSync(data, "utf8")).toBe("done\ndone\n");
    } finally {
      await f.clean();
    }
  },
  30000,
);
real(
  "real WASI job failures and timeouts fail deployment and leave no running process",
  async () => {
    for (const arg of ["fail", "worker"]) {
      const f = fixture(arg, "job", 1);
      try {
        const p = await f.prepared();
        await expect(f.manager.deploy(context(), p)).rejects.toThrow();
        const s = f.manager.resolve(p.identity.ID).Services.command;
        expect(s.job?.status).toBe("failed");
        expect((await f.manager.backend(s).inspect(context(), s.Container))?.Running).not.toBe(
          true,
        );
      } finally {
        await f.clean();
      }
    }
  },
  30000,
);
real(
  "real WASI workers start without ports, survive reattachment, and stop cleanly",
  async () => {
    const f = fixture("worker", "worker");
    try {
      const p = await f.prepared();
      await f.manager.deploy(context(), p);
      const s = f.manager.resolve(p.identity.ID).Services.command;
      expect(s.Ports).toEqual({});
      expect(s.ready).toBe(true);
      await f.manager.recover(context());
      expect((await f.manager.backend(s).inspect(context(), s.Container))?.Running).toBe(true);
      await f.manager.down(context(), f.manager.resolve(p.identity.ID));
      expect((await f.manager.backend(s).inspect(context(), s.Container))?.Running).not.toBe(true);
    } finally {
      await f.clean();
    }
  },
  30000,
);
