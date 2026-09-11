import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { call, health } from "@contremaitre/cli/client";
import { context, decode } from "@contremaitre/execution/context";
import { sleep } from "@contremaitre/execution/sleep";
import { operationSchema } from "@contremaitre/operations/operations";

const signal = AbortSignal.timeout(60_000),
  ctx = context(signal),
  dir = await mkdtemp(join(tmpdir(), "cm-packaging-")),
  home = join(dir, "home"),
  project = join(dir, "project"),
  fakebin = join(dir, "bin"),
  installHome = join(dir, "install home"),
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
  `#!${process.execPath}\nimport {existsSync,writeFileSync} from 'node:fs';\nconst r=await Bun.file(process.env.CONTREMAITRE_REQUEST).json();if(r.operation==='exec'){if(r.arguments[1]!=='--help')process.exit(24);process.exit(23);}if(r.operation==='deploy'){writeFileSync(r.environment.root+'/pid',String(process.pid));await Bun.sleep(existsSync(r.environment.root+'/slow')?50000:200);}console.log(JSON.stringify({version:1,status:['deploy','status'].includes(r.operation)?'running':'stopped',services:{web:{}}}));`,
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
let upgradedPid: number | undefined;
async function makeInstall() {
  const command = Bun.spawn(["make", "-o", "build", "install", `HOME=${installHome}`], {
    env: { ...process.env, CONTREMAITRE_HOME: home, PATH: `${fakebin}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    command.exited,
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
  ]);
  assert.equal(code, 0, `${stdout}\n${stderr}`);
}
async function boot() {
  child = Bun.spawn(
    [
      join(installHome, ".local/bin/contremaitre"),
      "serve",
      "--http",
      "--home",
      home,
      "--http-port",
      String(port),
    ],
    {
      env: { ...process.env, PATH: `${fakebin}:${process.env.PATH}` },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
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
  await makeInstall();
  assert.equal(await health(ctx, home), false, "installation must leave a stopped hub stopped");
  const help = Bun.spawn([binary, "--help"], { stdout: "pipe", stderr: "pipe" });
  const helpText = await new Response(help.stdout).text();
  assert.equal(await help.exited, 0);
  assert.equal(await new Response(help.stderr).text(), "");
  assert.ok(helpText.includes("Usage: contremaitre <command> [flags]"));
  assert.ok(helpText.includes("forward-http"));
  const bare = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" });
  assert.equal(await new Response(bare.stdout).text(), helpText);
  assert.equal(await bare.exited, 0);
  const invalid = Bun.spawn([binary, "version", "--rebuild"], { stdout: "pipe", stderr: "pipe" });
  assert.equal(await invalid.exited, 64);
  assert.ok((await new Response(invalid.stderr).text()).includes("Unknown flag '--rebuild'"));
  const install = Bun.spawn([binary, "agents", "install", "--agent", "all", "--json"], {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(await install.exited, 0, await new Response(install.stderr).text());
  JSON.parse(await new Response(install.stdout).text());
  const skill = join(project, ".agents/skills/contremaitre");
  assert.ok((await readFile(join(skill, "SKILL.md"), "utf8")).includes("contremaitre ensure"));
  assert.equal(await realpath(join(project, ".claude/skills/contremaitre")), await realpath(skill));
  assert.ok(
    (await readFile(join(project, ".opencode/plugins/contremaitre.ts"), "utf8")).includes(
      "session.idle",
    ),
  );
  assert.ok(
    (await readFile(join(project, ".pi/extensions/contremaitre/index.ts"), "utf8")).includes(
      "agent_end",
    ),
  );
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
  assert.ok(!(await new Response(cli.stdout).text()).includes("Usage:"));
  await makeInstall();
  assert.notEqual(child?.exitCode, null, "make install must retire the old hub process");
  const owner = Bun.spawn(["lsof", "-t", join(home, "daemon.lock")], { stdout: "pipe" });
  upgradedPid = Number((await new Response(owner.stdout).text()).trim());
  assert.equal(await owner.exited, 0);
  assert.ok(upgradedPid > 0 && upgradedPid !== child?.pid);
  assert.equal(await health(ctx, home), true);
  assert.equal(((await call(ctx, home, "health")) as { public_port: number }).public_port, port);
  const environments = (await call(ctx, home, "list")) as { Status: string }[];
  assert.equal(environments[0].Status, "running", "upgrade must preserve running environments");
  console.log(
    "Standalone help, agent installation, flag validation, Unix socket, duplicate requests, SIGKILL recovery, owned-process cleanup, SIGTERM restart and make install hub upgrade passed",
  );
} finally {
  if (upgradedPid) {
    process.kill(upgradedPid, "SIGTERM");
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(upgradedPid, 0);
      } catch {
        break;
      }
      await Bun.sleep(100);
    }
  }
  child?.kill("SIGTERM");
  await child?.exited;
  await rm(dir, { recursive: true, force: true });
}
