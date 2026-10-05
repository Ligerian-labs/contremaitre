import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fail, hash } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";
import { installBinary } from "./install.js";

const repository = "https://github.com/Ligerian-labs/contremaitre";
const artifact = "contremaitre-darwin-arm64";

export interface UpdateOptions {
  currentVersion: string;
  executable: string;
  home: string;
  check: boolean;
}
export interface UpdateResult {
  current_version: string;
  latest_version: string;
  status: "up-to-date" | "update-available" | "ahead" | "updated";
}

export async function updateBinary(
  ctx: Context,
  options: UpdateOptions,
  execute: typeof run = run,
): Promise<UpdateResult> {
  const download = (args: string[]) =>
    execute(
      ctx,
      [
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--connect-timeout",
        "15",
        "--max-time",
        "300",
        "--retry",
        "2",
        ...args,
      ],
      { timeout: 400_000, maxOutput: 4096, strictOutput: true },
    );
  const latest = (
    await download(["-o", "/dev/null", "-w", "%{url_effective}", `${repository}/releases/latest`])
  )
    .toString()
    .trim();
  const prefix = `${repository}/releases/tag/v`;
  if (!latest.startsWith(prefix)) fail("Cannot find the latest published Contremaitre release");
  const latestVersion = latest.slice(prefix.length);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(latestVersion))
    fail("Expected a stable Contremaitre release tag such as v0.2.0");
  const order = Bun.semver.order(options.currentVersion, latestVersion);
  const result: UpdateResult = {
    current_version: options.currentVersion,
    latest_version: latestVersion,
    status: order === 0 ? "up-to-date" : order > 0 ? "ahead" : "update-available",
  };
  if (options.check || order === 0) return result;
  if (order > 0)
    fail(
      `Installed Contremaitre ${options.currentVersion} is newer than the latest release ${latestVersion}; refusing to downgrade. Use the download installer to select a version explicitly.`,
    );

  // Resolve symlinks so shell aliases keep pointing to the updated executable.
  const destination = await realpath(options.executable);
  const temporary = await mkdtemp(join(tmpdir(), "contremaitre-update-"));
  try {
    const base = `${repository}/releases/download/v${latestVersion}`;
    const checksum = join(temporary, "checksum");
    const source = join(temporary, artifact);
    ctx.log(`Downloading Contremaitre ${latestVersion}...\n`);
    await download(["-o", checksum, `${base}/${artifact}.sha256`]);
    const expected = (await readFile(checksum, "utf8")).trim();
    const match = /^([0-9a-f]{64})(?: {2}contremaitre-darwin-arm64)?$/.exec(expected);
    if (!match) fail("Invalid release checksum; the installed CLI was not changed");
    await download(["-o", source, `${base}/${artifact}`]);
    if (hash(await readFile(source)) !== match[1])
      fail("Download checksum mismatch; the installed CLI was not changed");
    ctx.signal.throwIfAborted();
    await installBinary(ctx, source, destination, options.home);
    return { ...result, status: "updated" };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function formatUpdate(result: UpdateResult): string {
  switch (result.status) {
    case "up-to-date":
      return `Contremaitre ${result.current_version} is already up to date.`;
    case "update-available":
      return `Contremaitre ${result.latest_version} is available, installed: ${result.current_version}. Run contremaitre update to install it.`;
    case "ahead":
      return `Installed Contremaitre ${result.current_version} is newer than the latest release ${result.latest_version}. No downgrade will be performed.`;
    case "updated":
      return `Updated Contremaitre ${result.current_version} to ${result.latest_version}.`;
  }
}
