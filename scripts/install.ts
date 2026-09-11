import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { call } from "@contremaitre/cli/client";
import { type Context, context, isCode, message } from "@contremaitre/execution/context";
import { lockHome } from "@contremaitre/execution/files";
import { sleep } from "@contremaitre/execution/sleep";

const exec = promisify(execFile);

export function routingArguments(command: string, https: boolean): string[] {
  const port = (flag: string, fallback: number) => {
    const matches = [...command.matchAll(new RegExp(`(?:^|\\s)--${flag}(?:=|\\s+)(\\S+)`, "g"))];
    if (!matches.length) return fallback;
    const value = matches[0][1];
    if (matches.length !== 1 || !/^\d+$/.test(value) || Number(value) > 65535)
      throw Error(`Cannot preserve hub --${flag}: ${value}`);
    return Number(value);
  };
  return https
    ? ["--https-port", String(port("https-port", 8443))]
    : [
        "--http",
        "--http-port",
        String(port("http-port", 8080)),
        "--public-port",
        String(port("public-port", 0)),
      ];
}

async function owner(ctx: Context, home: string): Promise<number> {
  // Older hubs expose neither their PID nor their startup options through the API.
  const { stdout } = await exec("/usr/sbin/lsof", ["-t", join(home, "daemon.lock")], {
    signal: ctx.signal,
  });
  const pids = [...new Set(stdout.trim().split(/\s+/))];
  if (pids.length !== 1 || !/^\d+$/.test(pids[0]) || Number(pids[0]) <= 1)
    throw Error("Cannot identify a single running hub from daemon.lock");
  return Number(pids[0]);
}

async function runningHub(ctx: Context, home: string) {
  let health: { local_https?: boolean };
  try {
    health = (await call(ctx, home, "health", {}, 2000)) as typeof health;
  } catch (error) {
    if (!isCode(error, "ENOENT") && !isCode(error, "ECONNREFUSED")) throw error;
    // A missing socket can also mean startup or shutdown is still in progress.
    if (existsSync(home)) lockHome(home)();
    return;
  }
  const pid = await owner(ctx, home);
  const { stdout } = await exec("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
    signal: ctx.signal,
  });
  if (!/(?:^|\s)serve(?:\s|$)/.test(stdout))
    throw Error(`Process ${pid} owns daemon.lock but is not a hub serve command`);
  return { pid, args: routingArguments(stdout, !!health.local_https) };
}

export async function installBinary(
  ctx: Context,
  source: string,
  destination: string,
  home: string,
) {
  const hub = await runningHub(ctx, home);
  await mkdir(dirname(destination), { recursive: true });
  const staged = join(dirname(destination), `.contremaitre-${randomUUID()}`);
  try {
    await copyFile(source, staged);
    await chmod(staged, 0o755);
    // Keep the old executable's inode intact until the old hub has exited.
    await rename(staged, destination);
  } finally {
    await rm(staged, { force: true });
  }
  ctx.log(`Installed ${destination}\n`);
  if (!hub) return;
  const args = ["start", "--home", home, ...hub.args];
  try {
    if ((await owner(ctx, home)) !== hub.pid)
      throw Error("The running hub changed during installation; retry make install");
    ctx.log("Upgrading the running hub. Active operations and tunnel sessions will end.\n");
    process.kill(hub.pid, "SIGTERM");
    const deadline = Date.now() + 180_000;
    while (true) {
      ctx.signal.throwIfAborted();
      try {
        process.kill(hub.pid, 0);
      } catch (error) {
        if (isCode(error, "ESRCH")) break;
        throw error;
      }
      if (Date.now() >= deadline) throw Error("Timed out waiting for the old hub to exit");
      await sleep(100, ctx.signal);
    }
    const result = await exec(destination, args, { signal: ctx.signal });
    ctx.log(result.stdout);
    ctx.log(result.stderr);
  } catch (error) {
    throw Error(
      `CLI installed, but hub upgrade failed: ${message(error)}. Start it with: ${[destination, ...args].map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")}`,
    );
  }
}

if (import.meta.main) {
  const userHome = process.env.HOME || homedir();
  try {
    await installBinary(
      context(AbortSignal.timeout(400_000), (data) => process.stdout.write(data)),
      resolve("bin/contremaitre"),
      join(userHome, ".local", "bin", "contremaitre"),
      resolve(process.env.CONTREMAITRE_HOME || join(userHome, ".local", "share", "contremaitre")),
    );
  } catch (error) {
    process.stderr.write(`make install: ${message(error)}\n`);
    process.exitCode = 1;
  }
}
