import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context } from "@contremaitre/execution/context";
import { lockHome } from "@contremaitre/execution/files";
import { installBinary, routingArguments } from "../scripts/install.js";

test("upgrade preserves HTTPS and legacy HTTP routing options from older hubs", () => {
  expect(routingArguments("/path with spaces/contremaitre serve --https-port=18443", true)).toEqual(
    ["--https-port", "18443"],
  );
  expect(routingArguments("contremaitre serve", true)).toEqual(["--https-port", "8443"]);
  expect(
    routingArguments("contremaitre serve --http --http-port 18080 --public-port=80", false),
  ).toEqual(["--http", "--http-port", "18080", "--public-port", "80"]);
  expect(routingArguments("contremaitre serve --http", false)).toEqual([
    "--http",
    "--http-port",
    "8080",
    "--public-port",
    "0",
  ]);
  for (const args of [
    "--https-port bad",
    "--https-port 65536",
    "--https-port 8443 --https-port 9443",
  ])
    expect(() => routingArguments(`contremaitre serve ${args}`, true)).toThrow("Cannot preserve");
});

test("installation replaces the binary atomically and leaves a stopped hub stopped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-install-"));
  try {
    const source = join(dir, "source"),
      destination = join(dir, "installed"),
      home = join(dir, "home");
    writeFileSync(source, "new binary");
    writeFileSync(destination, "old binary");
    const oldInode = statSync(destination).ino;
    await installBinary(context(), source, destination, home);
    expect(readFileSync(destination, "utf8")).toBe("new binary");
    expect(statSync(destination).ino).not.toBe(oldInode);
    expect(statSync(destination).mode & 0o777).toBe(0o755);
    expect(existsSync(home)).toBe(false);
    await expect(
      installBinary(context(), join(dir, "missing"), destination, home),
    ).rejects.toThrow();
    expect(readFileSync(destination, "utf8")).toBe("new binary");
    expect(readdirSync(dir).some((name) => name.startsWith(".contremaitre-"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a locked home without a healthy socket fails before replacing the binary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-install-locked-"));
  const home = join(dir, "home"),
    unlock = lockHome(home);
  try {
    const source = join(dir, "source"),
      destination = join(dir, "installed");
    writeFileSync(source, "new binary");
    writeFileSync(destination, "old binary");
    await expect(installBinary(context(), source, destination, home)).rejects.toThrow("locked");
    expect(readFileSync(destination, "utf8")).toBe("old binary");
  } finally {
    unlock();
    rmSync(dir, { recursive: true, force: true });
  }
});
