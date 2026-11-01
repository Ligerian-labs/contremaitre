export type ReleaseChannel = "stable" | "beta" | "nightly";

export function parseReleaseTag(tag: string) {
  if (!tag.startsWith("v")) return undefined;
  const version = tag.slice(1).replace(/\.beta\.(\d+)$/, "-beta.$1");
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      version,
    );
  if (!match || match[4]?.split(".").some((part) => /^0\d+$/.test(part))) return undefined;
  const channel: ReleaseChannel | undefined = !match[4]
    ? "stable"
    : /^beta\.(0|[1-9]\d*)$/.test(match[4])
      ? "beta"
      : /^nightly\.(0|[1-9]\d*)\.g[0-9a-f]{12}$/.test(match[4])
        ? "nightly"
        : undefined;
  return { tag, version, channel, prerelease: !!match[4] };
}
