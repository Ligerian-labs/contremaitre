import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDriverReply, invokeDriver, snapshotDriver } from "@contremaitre/environments/driver";
import { Manager } from "@contremaitre/environments/manager";
import { Store } from "@contremaitre/environments/store";
import { context } from "@contremaitre/execution/context";
import { newIdentity } from "@contremaitre/projects/model";
import { FakeRuntime } from "./fake-runtime.js";

test("driver executable is frozen and response validation rejects non-loopback upstreams", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-driver-")),
    project = join(home, "project");
  mkdirSync(project);
  const path = join(project, "driver");
  writeFileSync(
    path,
    `#!${process.execPath}\nconst r=await Bun.file(process.env.CONTREMAITRE_REQUEST).json();console.log(JSON.stringify({version:1,status:r.operation==='deploy'?'running':'stopped',services:{web:{host:'127.0.0.1',port:3000,http:true}}}));`,
    { mode: 0o700 },
  );
  const m = new Manager(new Store(home), new FakeRuntime()),
    env = m.fresh(newIdentity("example", project, "main"), project);
  try {
    snapshotDriver(home, env, { executable: "driver", timeout_seconds: 5 });
    rmSync(path);
    applyDriverReply(env, await invokeDriver(context(), env, "deploy"));
    expect(env.Status).toBe("running");
    expect(env.Services.web.IP).toBe("127.0.0.1");
    expect(() =>
      applyDriverReply(env, {
        version: 1,
        status: "running",
        services: { web: { host: "8.8.8.8", port: 80, http: true } },
      }),
    ).toThrow("loopback");
    expect(() =>
      applyDriverReply(env, {
        version: 1,
        status: "running",
        services: {
          web: { host: "127.0.0.1", port: 80, http: true, url: "http://foreign.localhost" },
        },
      }),
    ).toThrow("environment hostname");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
