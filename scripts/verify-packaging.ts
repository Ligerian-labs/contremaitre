import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { call, health } from "../src/client.js";
import { context, decode } from "../src/model.js";
import { operationSchema } from "../src/operations.js";
import { sleep } from "../src/process.js";

const signal = AbortSignal.timeout(60_000),
  ctx = context(signal),
  dir = await mkdtemp(join(tmpdir(), "cm-packaging-")),
  home = join(dir, "home"),
  project = join(dir, "project"),
  fakebin = join(dir, "bin"),
  binary = resolve("bin/contremaitre");
await mkdir(project);
await mkdir(fakebin);
await writeFile(join(fakebin, "container"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
await writeFile(
  join(project, ".contremaitre.yaml"),
  "version: 1\nproject: packaging\ndriver: {executable: driver, timeout_seconds: 60}\n",
);
await writeFile(
  join(project, "driver"),
  `#!${process.execPath}\nimport {existsSync,writeFileSync} from 'node:fs';\nconst r=await Bun.file(process.env.CONTREMAITRE_REQUEST).json();if(r.operation==='exec'){if(r.arguments[1]!=='--help')process.exit(24);process.exit(23);}if(r.operation==='deploy'){writeFileSync(r.environment.root+'/pid',String(process.pid));await Bun.sleep(existsSync(r.environment.root+'/slow')?50000:200);}console.log(JSON.stringify({version:1,status:r.operation==='deploy'?'running':'stopped',services:{web:{}}}));`,
  { mode: 0o700 },
);
await writeFile(join(project, "slow"), "");
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("invalid port");
    server.close(() => resolve(address.port));
  });
});
let child: ReturnType<typeof Bun.spawn> | undefined;
async function boot() {
  child = Bun.spawn([binary, "serve", "--home", home, "--http-port", String(port)], {
    env: { ...process.env, PATH: `${fakebin}:${process.env.PATH}` },
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    if (await health(ctx, home)) return;
    if (child.exitCode !== null)
      throw Error(
        child.stderr instanceof ReadableStream
          ? await new Response(child.stderr).text()
          : "Hub exited during startup",
      );
    await sleep(100, signal);
  }
  throw Error("Hub startup timeout");
}
try {
  await boot();
  const op = decode(
    operationSchema,
    await call(ctx, home, "deploy-async", { root: project, branch: "main" }),
    "operation",
  );
  const duplicate = decode(
    operationSchema,
    await call(ctx, home, "deploy-async", { root: project, branch: "main" }),
    "operation",
  );
  assert.equal(op.id, duplicate.id);
  let driverPid = 0;
  for (let i = 0; i < 100; i++) {
    try {
      driverPid = Number(await readFile(join(project, "pid"), "utf8"));
      break;
    } catch {}
    await sleep(50, signal);
  }
  assert.ok(driverPid > 0);
  child?.kill("SIGKILL");
  await child?.exited;
  await boot();
  const progress = (await call(ctx, home, "operation", { id: op.id })) as {
    operation: { status: string };
  };
  assert.equal(progress.operation.status, "interrupted");
  let alive = true;
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(driverPid, 0);
    } catch {
      alive = false;
      break;
    }
    await sleep(50, signal);
  }
  assert.equal(alive, false, "interrupted driver still running");
  await rm(join(project, "slow"));
  const next = decode(
    operationSchema,
    await call(ctx, home, "deploy-async", { root: project, branch: "main" }),
    "operation",
  );
  let status = "";
  for (let i = 0; i < 100; i++) {
    const p = (await call(ctx, home, "operation", { id: next.id })) as {
      operation: { status: string };
    };
    status = p.operation.status;
    if (status === "succeeded") break;
    await sleep(50, signal);
  }
  assert.equal(status, "succeeded");
  child?.kill("SIGTERM");
  const exit = await child?.exited;
  assert.ok(exit === 0 || exit === 130, `graceful hub exit: ${exit}`);
  await boot();
  assert.equal(
    ((await call(ctx, home, "operation", { id: next.id })) as { operation: { status: string } })
      .operation.status,
    "succeeded",
  );
  const cli = Bun.spawn(
    [binary, "--home", home, "--env", next.environmentId, "exec", "web", "--", "printf", "--help"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  ); // Driver receives passthrough; Contremaitre must not print its own help.
  assert.equal(await cli.exited, 23);
  assert.ok(!(await new Response(cli.stdout).text()).includes("USAGE"));
  console.log(
    "Standalone executable, Unix socket, duplicate requests, SIGKILL recovery, owned-process cleanup and SIGTERM restart passed",
  );
} finally {
  child?.kill("SIGTERM");
  await child?.exited;
  await rm(dir, { recursive: true, force: true });
}
