import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardingPlist, forwardingWarning, HttpsService } from "@contremaitre/cli/https-service";
import { type Context, context } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cm-https-service-"));
  const source = join(root, "cli & 'quoted'");
  writeFileSync(source, "original binary", { mode: 0o755 });
  const state = { loaded: false, listening: false, failBootstrap: false, failBootout: false };
  const calls: string[] = [];
  const manager = new HttpsService({
    root,
    owner: process.getuid?.() ?? -1,
    listening: async () => state.listening,
    command: async (ctx: Context, args: string[]) => {
      if (args[0] === "/usr/sbin/lsof") return state.listening ? "1234\n" : "";
      if (args[0] !== "/bin/launchctl") return (await run(ctx, args)).toString();
      calls.push(args[1]);
      switch (args[1]) {
        case "print":
          if (!state.loaded) throw Error("Could not find service");
          return "state = running\n\tpid = 1234\n";
        case "bootout":
          if (state.failBootout) throw Error("bootout denied");
          state.loaded = false;
          state.listening = false;
          return "";
        case "bootstrap":
          if (state.failBootstrap) {
            state.failBootstrap = false;
            throw Error("bootstrap failed");
          }
          state.loaded = true;
          state.listening = true;
          return "";
        case "enable":
          return "";
        default:
          throw Error(`Unexpected launchctl command: ${args[1]}`);
      }
    },
  });
  return {
    root,
    source,
    state,
    calls,
    manager,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("install creates a protected boot service, updates its target, and uninstalls idempotently", async () => {
  const f = fixture();
  try {
    const first = await f.manager.install(context(), f.source, 8443);
    expect(first).toMatchObject({
      installed: true,
      loaded: true,
      pid: 1234,
      targetPort: 8443,
      listening: true,
    });
    expect(statSync(f.manager.binary).mode & 0o777).toBe(0o755);
    expect(statSync(f.manager.binary).uid).toBe(process.getuid?.() ?? -1);
    expect(statSync(f.manager.plist).mode & 0o777).toBe(0o644);
    expect(readFileSync(f.manager.binary, "utf8")).toBe("original binary");
    const plist = JSON.parse(
      (
        await run(context(), ["/usr/bin/plutil", "-convert", "json", "-o", "-", f.manager.plist])
      ).toString(),
    );
    expect(plist.RunAtLoad).toBe(true);
    expect(plist.KeepAlive).toBe(true);
    expect(plist.WorkingDirectory).toBe("/");
    expect(plist.ProgramArguments).toEqual([
      "/usr/bin/env",
      "-i",
      "HOME=/var/root",
      "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
      f.manager.binary,
      "forward-https",
      "--https-port",
      "8443",
    ]);
    expect(plist.ProgramArguments).not.toContain(f.source);
    writeFileSync(f.source, "updated binary");
    await f.manager.install(context(), f.source, 18443);
    expect((await f.manager.status(context())).targetPort).toBe(18443);
    expect(readFileSync(f.manager.binary, "utf8")).toBe("updated binary");
    expect(f.calls.filter((c) => c === "bootout")).toHaveLength(1);
    await f.manager.uninstall(context());
    await f.manager.uninstall(context());
    expect(existsSync(f.manager.plist)).toBe(false);
    expect(existsSync(f.manager.binary)).toBe(false);
    expect(existsSync(f.source)).toBe(true);
    expect(existsSync(f.manager.log)).toBe(true);
  } finally {
    f.clean();
  }
});

test("a failed upgrade restores the previous files and running service", async () => {
  const f = fixture();
  try {
    await f.manager.install(context(), f.source, 8443);
    writeFileSync(f.source, "broken replacement");
    f.state.failBootstrap = true;
    await expect(f.manager.install(context(), f.source, 18443)).rejects.toThrow("bootstrap failed");
    expect(readFileSync(f.manager.binary, "utf8")).toBe("original binary");
    expect(await f.manager.status(context())).toMatchObject({
      targetPort: 8443,
      loaded: true,
      listening: true,
    });
    f.state.failBootout = true;
    await expect(f.manager.uninstall(context())).rejects.toThrow("bootout denied");
    expect(existsSync(f.manager.binary)).toBe(true);
    expect(existsSync(f.manager.plist)).toBe(true);
  } finally {
    f.clean();
  }
});

test("a failed first installation removes its partial service files", async () => {
  const f = fixture();
  try {
    f.state.failBootstrap = true;
    await expect(f.manager.install(context(), f.source, 8443)).rejects.toThrow("bootstrap failed");
    expect(existsSync(f.manager.binary)).toBe(false);
    expect(existsSync(f.manager.plist)).toBe(false);
    expect(f.state.loaded).toBe(false);
  } finally {
    f.clean();
  }
});

test("installation rejects an occupied port and unsafe service files without changing them", async () => {
  const f = fixture();
  try {
    f.state.listening = true;
    await expect(f.manager.install(context(), f.source, 8443)).rejects.toThrow("already in use");
    expect(f.calls).not.toContain("bootout");
    f.state.listening = false;
    symlinkSync(f.source, f.manager.binary);
    await expect(f.manager.install(context(), f.source, 8443)).rejects.toThrow("unsafe");
    expect(readFileSync(f.source, "utf8")).toBe("original binary");
    rmSync(f.manager.binary);
    writeFileSync(f.manager.binary, "unsafe", { mode: 0o777 });
    chmodSync(f.manager.binary, 0o777);
    await expect(f.manager.uninstall(context())).rejects.toThrow("unsafe");
    expect(readFileSync(f.manager.binary, "utf8")).toBe("unsafe");
  } finally {
    f.clean();
  }
});

test("forwarding status distinguishes missing, stopped, matching and mismatched targets", () => {
  const status = { installed: false, loaded: false, listening: false, log: "log" };
  expect(forwardingWarning(status, 8443)).toContain("https-service install");
  expect(forwardingWarning({ ...status, listening: true }, 8443)).toBeUndefined();
  const installed = {
    ...status,
    installed: true,
    loaded: true,
    pid: 1234,
    listening: true,
    targetPort: 8443,
  };
  expect(forwardingWarning(installed, 8443)).toBeUndefined();
  expect(forwardingWarning(installed, 18443)).toContain("--https-port 18443");
  expect(forwardingWarning({ ...installed, pid: undefined }, 8443)).toContain("unavailable");
  for (const port of [443, 1023, 65536, 1.5, NaN])
    expect(() => forwardingPlist("binary", port, "log")).toThrow("1024..65535");
});
