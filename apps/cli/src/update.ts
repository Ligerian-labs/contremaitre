import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fail, hash } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";
import { Schema } from "effect";
import { installBinary } from "./install.js";
import { parseReleaseTag, type ReleaseChannel } from "./releases.js";

const repository = "https://github.com/Ligerian-labs/contremaitre";
const artifact = "contremaitre-darwin-arm64";
const releaseList = Schema.parseJson(
  Schema.Array(
    Schema.Struct({ tag_name: Schema.String, draft: Schema.Boolean, prerelease: Schema.Boolean }),
  ),
);

export interface UpdateOptions {
  currentVersion: string;
  executable: string;
  home: string;
  check: boolean;
  channel?: ReleaseChannel;
}
export interface UpdateResult {
  current_version: string;
  latest_version: string;
  status: "up-to-date" | "update-available" | "ahead" | "updated";
  channel?: ReleaseChannel;
}

export async function updateBinary(
  ctx: Context,
  options: UpdateOptions,
  execute: typeof run = run,
): Promise<UpdateResult> {
  const channel = options.channel ?? "stable";
  const download = (args: string[], maxOutput = 4096) =>
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
      { timeout: 400_000, maxOutput, strictOutput: true },
    );
  let latest: ReturnType<typeof parseReleaseTag>;
  for (let page = 1; ; page++) {
    const response = await download(
      [
        "--header",
        "Accept: application/vnd.github+json",
        "--header",
        "X-GitHub-Api-Version: 2022-11-28",
        `https://api.github.com/repos/Ligerian-labs/contremaitre/releases?per_page=100&page=${page}`,
      ],
      4 * 1024 * 1024,
    );
    const releases = Schema.decodeUnknownOption(releaseList)(response.toString());
    if (releases._tag === "None")
      fail("Invalid GitHub releases response; the installed CLI was not changed");
    for (const release of releases.value) {
      const parsed = parseReleaseTag(release.tag_name);
      if (
        !parsed ||
        release.draft ||
        parsed.channel !== channel ||
        release.prerelease !== parsed.prerelease
      )
        continue;
      if (!latest || Bun.semver.order(parsed.version, latest.version) > 0) latest = parsed;
    }
    if (releases.value.length < 100) break;
    ctx.signal.throwIfAborted();
  }
  if (!latest) fail(`Cannot find a published Contremaitre ${channel} release`);
  const latestVersion = latest.version;
  const order = Bun.semver.order(options.currentVersion, latestVersion);
  const result: UpdateResult = {
    current_version: options.currentVersion,
    latest_version: latestVersion,
    status:
      order === 0 ? "up-to-date" : order > 0 && channel === "stable" ? "ahead" : "update-available",
    ...(channel === "stable" ? {} : { channel }),
  };
  if (options.check || order === 0) return result;
  if (order > 0 && channel === "stable")
    fail(
      `Installed Contremaitre ${options.currentVersion} is newer than the latest release ${latestVersion}; refusing to downgrade. Use the download installer to select a version explicitly.`,
    );

  // Resolve symlinks so shell aliases keep pointing to the updated executable.
  const destination = await realpath(options.executable);
  const temporary = await mkdtemp(join(tmpdir(), "contremaitre-update-"));
  try {
    const base = `${repository}/releases/download/${latest.tag}`;
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
      return `Contremaitre ${result.latest_version} is available, installed: ${result.current_version}. Run contremaitre update${result.channel && result.channel !== "stable" ? ` --${result.channel}` : ""} to install it.`;
    case "ahead":
      return `Installed Contremaitre ${result.current_version} is newer than the latest release ${result.latest_version}. No downgrade will be performed.`;
    case "updated":
      return `Updated Contremaitre ${result.current_version} to ${result.latest_version}.`;
  }
}
