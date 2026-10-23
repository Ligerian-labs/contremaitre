import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatUpdate, updateBinary } from "@contremaitre/cli/update";
import { context, fail, hash } from "@contremaitre/execution/context";
import { lockHome } from "@contremaitre/execution/files";
import type { run as execute } from "@contremaitre/execution/process";
import { CommandBus } from "@contremaitre/hub/application";
import { defineFixture, defineScenario, makeCatalog, run } from "@structure-ai/fixtures";
import { Effect, Schema } from "effect";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(
  options: {
    current?: string;
    latest?: string;
    latestPointer?: string;
    check?: boolean;
    corrupt?: boolean;
    checksum?: string;
    failure?: "latest" | "checksum" | "binary";
    channel?: "stable" | "beta" | "nightly";
    releases?: Record<string, unknown>[][];
    response?: string;
    abort?: AbortController;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "cm-update-test-"));
  directories.push(directory);
  const executable = join(directory, "custom binary");
  const home = join(directory, "hub home");
  writeFileSync(executable, "old binary");
  const requests: string[] = [];
  const temporary: string[] = [];
  const latest = options.latest ?? "1.10.0";
  const binary = "verified release binary";
  const runner: typeof execute = async (ctx, argv) => {
    ctx.signal.throwIfAborted();
    const url = argv.at(-1) ?? "";
    requests.push(url);
    expect(argv).toContain("--fail");
    expect(argv).toContain("--proto-redir");
    expect(argv.filter((arg) => arg === "=https")).toHaveLength(2);
    if (url.endsWith("/latest"))
      return Buffer.from(
        `https://github.com/Ligerian-labs/contremaitre/releases/tag/v${options.latestPointer ?? latest}`,
      );
    const stage = url.includes("api.github.com")
      ? "latest"
      : url.endsWith(".sha256")
        ? "checksum"
        : "binary";
    if (stage === options.failure) fail(`Fixture ${stage} download failed`);
    if (stage === "latest")
      return Buffer.from(
        options.response ??
          JSON.stringify(
            options.releases?.[Number(new URL(url).searchParams.get("page")) - 1] ?? [
              {
                tag_name: `v${latest}`,
                draft: false,
                prerelease: options.channel !== undefined && options.channel !== "stable",
              },
            ],
          ),
      );
    const destination = argv[argv.indexOf("-o") + 1];
    temporary.push(destination);
    expect(url).toContain(`/releases/download/v${latest}/`);
    writeFileSync(
      destination,
      stage === "checksum"
        ? (options.checksum ??
            `${options.corrupt ? "0".repeat(64) : hash(binary)}  contremaitre-darwin-arm64\n`)
        : binary,
    );
    if (stage === "binary") options.abort?.abort();
    return Buffer.alloc(0);
  };
  const input = {
    currentVersion: options.current ?? "1.9.0",
    executable,
    home,
    check: options.check ?? false,
    channel: options.channel ?? "stable",
  };
  return { input, runner, requests, temporary, binary, directory };
}

test("latest stable update replaces the invoked symlink target atomically and leaves a stopped hub stopped", async () => {
  const f = fixture();
  const alias = join(f.directory, "alias");
  symlinkSync(f.input.executable, alias);
  const inode = statSync(f.input.executable).ino;
  const result = await updateBinary(context(), { ...f.input, executable: alias }, f.runner);
  expect(result).toEqual({ current_version: "1.9.0", latest_version: "1.10.0", status: "updated" });
  expect(readFileSync(alias, "utf8")).toBe(f.binary);
  expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  expect(statSync(f.input.executable).ino).not.toBe(inode);
  expect(statSync(alias).mode & 0o777).toBe(0o755);
  expect(existsSync(f.input.home)).toBe(false);
  expect(f.requests).toHaveLength(3);
  expect(f.temporary.every((path) => !existsSync(path))).toBe(true);
});

test("current versions and --check only resolve the release, even with a locked hub", async () => {
  for (const options of [{ current: "1.10.0" }, { check: true }]) {
    const f = fixture(options);
    const unlock = lockHome(f.input.home);
    const inode = statSync(f.input.executable).ino;
    try {
      const result = await updateBinary(context(), f.input, f.runner);
      expect(result.status).toBe(options.check ? "update-available" : "up-to-date");
      expect(f.requests).toHaveLength(1);
      expect(statSync(f.input.executable).ino).toBe(inode);
      expect(readFileSync(f.input.executable, "utf8")).toBe("old binary");
    } finally {
      unlock();
    }
  }
});

test("newer stable and development versions refuse downgrades; --check reports ahead", async () => {
  for (const current of ["2.0.0", "2.0.0-rc.1"]) {
    const f = fixture({ current });
    await expect(updateBinary(context(), f.input, f.runner)).rejects.toThrow(
      "refusing to downgrade",
    );
    expect(f.requests).toHaveLength(1);
    expect(readFileSync(f.input.executable, "utf8")).toBe("old binary");
    expect((await updateBinary(context(), { ...f.input, check: true }, f.runner)).status).toBe(
      "ahead",
    );
  }
  const prerelease = fixture({ current: "1.10.0-rc.1", check: true });
  expect((await updateBinary(context(), prerelease.input, prerelease.runner)).status).toBe(
    "update-available",
  );
  const metadata = fixture({ current: "1.10.0+local", check: true });
  expect((await updateBinary(context(), metadata.input, metadata.runner)).status).toBe(
    "up-to-date",
  );
});

test("missing releases and malformed responses fail before asset downloads", async () => {
  for (const response of [
    "not JSON",
    "{}",
    "[]",
    '[{"tag_name":"v1.10.0-rc.1","draft":false,"prerelease":true}]',
    '[{"tag_name":"v1.10.0/extra","draft":false,"prerelease":false}]',
  ]) {
    const f = fixture({ response });
    await expect(updateBinary(context(), f.input, f.runner)).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
    expect(readFileSync(f.input.executable, "utf8")).toBe("old binary");
  }
});

const release = (tag: string, prerelease = false, draft = false) => ({
  tag_name: tag,
  prerelease,
  draft,
});

test("stable selects the highest patch across pages regardless of GitHub latest or release order", async () => {
  const first = Array.from({ length: 100 }, () => release("v1.10.0"));
  first[0] = release("v9.0.0", false, true);
  first[1] = release("v2.0.0-beta.0", true);
  const f = fixture({
    current: "1.10.0",
    latest: "1.10.2",
    latestPointer: "1.10.0",
    releases: [first, [release("v1.10.2"), release("v1.10.1")]],
  });
  expect((await updateBinary(context(), f.input, f.runner)).status).toBe("updated");
  expect(f.requests.slice(0, 2).map((url) => new URL(url).searchParams.get("page"))).toEqual([
    "1",
    "2",
  ]);
  expect(f.requests[2]).toContain("/download/v1.10.2/");
});

test("beta selects numeric beta versions and keeps the dotted GitHub tag for downloads", async () => {
  const f = fixture({
    channel: "beta",
    current: "1.10.0-beta.9",
    latest: "1.10.0.beta.10",
    releases: [
      [
        release("v1.10.0-beta.9", true),
        release("v1.10.0.beta.10", true),
        release("v3.0.0"),
        release("v4.0.0-rc.1", true),
        release("v5.0.0-beta.0", true, true),
      ],
    ],
  });
  const result = await updateBinary(context(), f.input, f.runner);
  expect(result.latest_version).toBe("1.10.0-beta.10");
  expect(result.status).toBe("updated");
  expect(f.requests[1]).toContain("/download/v1.10.0.beta.10/");
});

test("explicit beta and nightly switches install even when their version sorts below stable", async () => {
  for (const [channel, latest] of [
    ["beta", "1.0.0-beta.0"],
    ["nightly", "0.0.0-nightly.12.gabcdef123456"],
  ] as const) {
    const f = fixture({ channel, latest, current: "2.0.0" });
    expect((await updateBinary(context(), { ...f.input, check: true }, f.runner)).status).toBe(
      "update-available",
    );
    expect(readFileSync(f.input.executable, "utf8")).toBe("old binary");
    expect((await updateBinary(context(), f.input, f.runner)).status).toBe("updated");
    expect(
      formatUpdate({
        current_version: "2.0.0",
        latest_version: latest,
        status: "update-available",
        channel,
      }),
    ).toContain(`update --${channel}`);
  }
});

test("nightly selects the newest main build and skips the installed build", async () => {
  const latest = "0.0.0-nightly.12.gabcdef123456";
  const f = fixture({
    channel: "nightly",
    latest,
    current: latest,
    releases: [
      [
        release("v0.0.0-nightly.9.gabcdef123456", true),
        release(`v${latest}`, true),
        release("v1.0.0-beta.0", true),
      ],
    ],
  });
  expect((await updateBinary(context(), f.input, f.runner)).status).toBe("up-to-date");
  expect(f.requests).toHaveLength(1);
});

test("failed downloads and invalid checksums preserve the installed binary and remove staged downloads", async () => {
  for (const options of [
    { failure: "latest" as const },
    { failure: "checksum" as const },
    { failure: "binary" as const },
    { corrupt: true },
    { checksum: "invalid" },
    { checksum: `${"0".repeat(64)}  another-binary\n` },
  ]) {
    const f = fixture(options);
    await expect(updateBinary(context(), f.input, f.runner)).rejects.toThrow();
    expect(readFileSync(f.input.executable, "utf8")).toBe("old binary");
    expect(f.temporary.every((path) => !existsSync(path))).toBe(true);
    expect(existsSync(f.input.home)).toBe(false);
  }
});

test("cancellation after downloading leaves the installed binary and hub untouched", async () => {
  const abort = new AbortController();
  const f = fixture({ abort });
  await expect(updateBinary(context(abort.signal), f.input, f.runner)).rejects.toThrow();
  expect(readFileSync(f.input.executable, "utf8")).toBe("old binary");
  expect(existsSync(f.input.home)).toBe(false);
  expect(f.temporary.every((path) => !existsSync(path))).toBe(true);
});

test("update leaves the CLI untouched when the selected hub is locked but unhealthy", async () => {
  const f = fixture();
  const unlock = lockHome(f.input.home);
  try {
    await expect(updateBinary(context(), f.input, f.runner)).rejects.toThrow("locked");
    expect(readFileSync(f.input.executable, "utf8")).toBe("old binary");
    expect(f.temporary.every((path) => !existsSync(path))).toBe(true);
  } finally {
    unlock();
  }
});

test("human output distinguishes current, available, ahead and updated versions", () => {
  const result = { current_version: "1.0.0", latest_version: "2.0.0" };
  expect(formatUpdate({ ...result, status: "up-to-date" })).toContain("already up to date");
  expect(formatUpdate({ ...result, status: "update-available" })).toContain(
    "Run contremaitre update",
  );
  expect(formatUpdate({ ...result, status: "ahead" })).toContain("No downgrade");
  expect(formatUpdate({ ...result, status: "updated" })).toBe(
    "Updated Contremaitre 1.0.0 to 2.0.0.",
  );
});

for (const [channel, latest, installedVersion] of [
  ["stable", "1.10.1", "1.10.1"],
  ["beta", "1.10.0.beta.0", "1.10.0-beta.0"],
  ["nightly", "0.0.0-nightly.12.gabcdef123456", "0.0.0-nightly.12.gabcdef123456"],
] as const) {
  const scenario = `cli/${channel}-update`;
  test(`Structure ${scenario} checks, updates and then skips the installed version`, async () => {
    const installed = defineFixture({
      key: "cli/installed-binary",
      create: () => Effect.sync(() => fixture({ channel, latest })),
    });
    const updated = defineFixture({
      key: "cli/updated-binary",
      dependencies: { installed },
      create: ({ dependencies }) =>
        Effect.tryPromise(async () => {
          const f = dependencies.installed;
          expect(
            (await updateBinary(context(), { ...f.input, check: true }, f.runner)).status,
          ).toBe("update-available");
          expect(readFileSync(f.input.executable, "utf8")).toBe("old binary");
          expect((await updateBinary(context(), f.input, f.runner)).status).toBe("updated");
          const inode = statSync(f.input.executable).ino;
          expect(
            (
              await updateBinary(
                context(),
                { ...f.input, currentVersion: installedVersion },
                f.runner,
              )
            ).status,
          ).toBe("up-to-date");
          expect(statSync(f.input.executable).ino).toBe(inode);
          return f;
        }),
    });
    const catalog = makeCatalog({
      base: { installed },
      scenarios: [
        defineScenario({
          name: scenario,
          description:
            "Check a stable release, install its verified binary and skip a repeated update",
          input: Schema.Struct({}),
          fixtures: () => ({ updated }),
        }),
      ],
    });
    const fixtures = await Effect.runPromise(catalog.prepare(scenario, {}));
    const report = await Effect.runPromise(
      run({
        fixtures,
        enabled: true,
        ready: () =>
          Effect.sync(() => {
            // This local CLI command has no CQRS dispatch or asynchronous hub work.
            for (const directory of directories)
              expect(readFileSync(join(directory, "custom binary"), "utf8")).toBe(
                "verified release binary",
              );
          }),
      }).pipe(
        Effect.provideService(CommandBus, {
          dispatch: () => Effect.die("The local update fixture must not dispatch hub commands"),
        }),
      ),
    );
    expect(report.completed).toEqual(["cli/installed-binary", "cli/updated-binary"]);
    console.log(
      `${scenario} run ${report.runId}, target: isolated temporary executable, inputs: {}`,
    );
  });
}
