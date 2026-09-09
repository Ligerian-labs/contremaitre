import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { type Context, context, fail, message } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";
import { sleep } from "@contremaitre/execution/sleep";

const label = "dev.contremaitre.https";
const service = `system/${label}`;
const launchctl = "/bin/launchctl";
const command = async (ctx: Context, args: string[]) =>
  (await run(ctx, args, { timeout: 15_000 })).toString();
const xml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c,
  );

export function forwardingPlist(binary: string, port: number, log: string) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    fail("HTTPS forwarding target must be 1024..65535");
  const args = [
    "/usr/bin/env",
    "-i",
    "HOME=/var/root",
    "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    binary,
    "forward-https",
    "--https-port",
    String(port),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>/</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

export const portListening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

export interface ForwardingStatus {
  installed: boolean;
  loaded: boolean;
  pid?: number;
  targetPort?: number;
  listening: boolean;
  log: string;
}

// These boundaries let lifecycle tests use temporary files and a fake launchd.
export class HttpsService {
  readonly binary: string;
  readonly plist: string;
  readonly log: string;
  constructor(
    private readonly system = {
      root: "/",
      owner: 0,
      command,
      listening: () => portListening(443),
    },
  ) {
    this.binary = join(system.root, "Library/PrivilegedHelperTools", label);
    this.plist = join(system.root, "Library/LaunchDaemons", `${label}.plist`);
    this.log = join(system.root, "Library/Logs/Contremaitre", "https-forwarder.log");
  }
  private async job(ctx: Context) {
    try {
      return await this.system.command(ctx, [launchctl, "print", service]);
    } catch (error) {
      if (message(error).includes("Could not find service")) return undefined;
      throw error;
    }
  }
  private async ownsListener(ctx: Context, pid: number) {
    try {
      const output = await this.system.command(ctx, [
        "/usr/sbin/lsof",
        "-nP",
        "-a",
        "-p",
        String(pid),
        "-iTCP:443",
        "-sTCP:LISTEN",
        "-t",
      ]);
      return output.trim().split(/\s+/).includes(String(pid));
    } catch (error) {
      if ((error as { exitCode?: number }).exitCode === 1) return false;
      throw error;
    }
  }
  async status(ctx: Context): Promise<ForwardingStatus> {
    const installed = existsSync(this.plist);
    let targetPort: number | undefined;
    if (installed) {
      const args = JSON.parse(
        await this.system.command(ctx, [
          "/usr/bin/plutil",
          "-extract",
          "ProgramArguments",
          "json",
          "-o",
          "-",
          this.plist,
        ]),
      );
      const index = Array.isArray(args) ? args.indexOf("--https-port") : -1;
      if (index < 0 || !/^\d+$/.test(args[index + 1]))
        fail(`Invalid HTTPS service configuration: ${this.plist}`);
      targetPort = Number(args[index + 1]);
    }
    const job = await this.job(ctx);
    const pid = job?.match(/^\s*pid = (\d+)$/m)?.[1];
    return {
      installed,
      loaded: job !== undefined,
      ...(pid ? { pid: Number(pid) } : {}),
      targetPort,
      listening: await this.system.listening(),
      log: this.log,
    };
  }
  private secure(path: string, directory: boolean) {
    const stat = lstatSync(path);
    if (
      stat.uid !== this.system.owner ||
      stat.mode & 0o022 ||
      (directory ? !stat.isDirectory() : !stat.isFile())
    )
      fail(`Refusing unsafe HTTPS service path: ${path}`);
  }
  private directory(path: string) {
    if (path !== this.system.root) this.directory(dirname(path));
    if (!existsSync(path)) mkdirSync(path, { mode: 0o755 });
    this.secure(path, true);
  }
  private checkFiles() {
    for (const path of [this.binary, this.plist, this.log]) {
      this.directory(dirname(path));
      // lstat also catches dangling symlinks, which existsSync would overlook.
      try {
        lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      this.secure(path, false);
    }
  }
  async install(ctx: Context, source: string, port: number) {
    const contents = forwardingPlist(this.binary, port, this.log);
    this.checkFiles();
    const before = await this.status(ctx);
    if (before.listening && (!before.pid || !(await this.ownsListener(ctx, before.pid))))
      fail(
        "Port 443 is already in use. Stop the existing listener before installing HTTPS forwarding.",
      );
    const stage = mkdtempSync(join(dirname(this.binary), ".https-install-"));
    const previous: (string | undefined)[] = [];
    let changed = false;
    let preserve = false;
    try {
      for (const [i, path] of [this.binary, this.plist].entries()) {
        const backup = join(stage, `backup-${i}`);
        if (existsSync(path)) {
          copyFileSync(path, backup);
          previous[i] = backup;
        }
      }
      copyFileSync(source, join(stage, "binary"));
      // Bun's macOS copy can preserve the source owner even when invoked as root.
      chownSync(join(stage, "binary"), this.system.owner, lstatSync(stage).gid);
      chmodSync(join(stage, "binary"), 0o755);
      this.secure(join(stage, "binary"), false);
      writeFileSync(join(stage, "service.plist"), contents, { mode: 0o644 });
      await this.system.command(ctx, ["/usr/bin/plutil", "-lint", join(stage, "service.plist")]);
      if (!existsSync(this.log)) writeFileSync(this.log, "", { mode: 0o644 });
      if (before.loaded) await this.system.command(ctx, [launchctl, "bootout", service]);
      changed = true;
      renameSync(join(stage, "binary"), this.binary);
      renameSync(join(stage, "service.plist"), this.plist);
      await this.system.command(ctx, [launchctl, "enable", service]);
      await this.system.command(ctx, [launchctl, "bootstrap", "system", this.plist]);
      for (let i = 0; i < 40; i++) {
        const status = await this.status(ctx);
        if (status.pid && status.listening && (await this.ownsListener(ctx, status.pid)))
          return status;
        await sleep(250, ctx.signal);
      }
      fail(`HTTPS forwarding did not listen on port 443; see ${this.log}`);
    } catch (error) {
      if (changed) {
        const recovery = context(AbortSignal.timeout(15_000));
        try {
          if (await this.job(recovery))
            await this.system.command(recovery, [launchctl, "bootout", service]);
          for (const [i, path] of [this.binary, this.plist].entries()) {
            if (previous[i]) renameSync(previous[i], path);
            else rmSync(path, { force: true });
          }
          if (before.loaded)
            await this.system.command(recovery, [launchctl, "bootstrap", "system", this.plist]);
        } catch (rollback) {
          preserve = true;
          fail(
            `${message(error)}; restoring the previous HTTPS service failed: ${message(rollback)}. Recovery files: ${stage}`,
          );
        }
      }
      throw error;
    } finally {
      if (!preserve) rmSync(stage, { recursive: true, force: true });
    }
  }
  async uninstall(ctx: Context) {
    this.checkFiles();
    if (await this.job(ctx)) await this.system.command(ctx, [launchctl, "bootout", service]);
    rmSync(this.plist, { force: true });
    rmSync(this.binary, { force: true });
  }
}

export function forwardingWarning(status: ForwardingStatus, port: number): string | undefined {
  if (status.installed && status.targetPort !== port)
    return `HTTPS forwarding targets ${status.targetPort}, but the hub uses ${port}. Run contremaitre https-service install --https-port ${port}.`;
  if (!status.listening || (status.installed && !status.pid))
    return "HTTPS port 443 is unavailable. Run contremaitre https-service install once to enable background forwarding.";
}

export async function manageHttpsService(ctx: Context, action: string, port: number) {
  if (process.platform !== "darwin") fail("HTTPS background forwarding requires macOS");
  const manager = new HttpsService();
  if (action === "status") return manager.status(ctx);
  if (!["install", "uninstall"].includes(action))
    fail("https-service requires install, status or uninstall");
  forwardingPlist(manager.binary, port, manager.log);
  if (!Bun.main.startsWith("/$bunfs/"))
    fail("HTTPS service installation requires the compiled CLI. Run make install first.");
  if (process.getuid?.() !== 0) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const shell = [
      process.execPath,
      "https-service",
      action,
      "--https-port",
      String(port),
      "--json",
    ]
      .map(quote)
      .join(" ");
    const result = await run(
      ctx,
      [
        "/usr/bin/osascript",
        "-e",
        `do shell script ${JSON.stringify(shell)} with administrator privileges`,
      ],
      { timeout: 300_000 },
    );
    return JSON.parse(result.toString()).data;
  }
  if (action === "install") return manager.install(ctx, process.execPath, port);
  await manager.uninstall(ctx);
  return "HTTPS background forwarding removed. The hub and certificates are unchanged.";
}
