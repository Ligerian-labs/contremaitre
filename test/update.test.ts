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
    check?: boolean;
    corrupt?: boolean;
    checksum?: string;
    failure?: "latest" | "checksum" | "binary";
    latestUrl?: string;
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
    const stage = url.endsWith("/latest")
      ? "latest"
      : url.endsWith(".sha256")
        ? "checksum"
        : "binary";
    if (stage === options.failure) fail(`Fixture ${stage} download failed`);
    if (stage === "latest")
      return Buffer.from(
        options.latestUrl ??
          `https://github.com/Ligerian-labs/contremaitre/releases/tag/v${latest}`,
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

test("missing releases, prereleases and foreign redirect URLs fail before asset downloads", async () => {
  for (const latestUrl of [
    "https://github.com/Ligerian-labs/contremaitre/releases/latest",
    "https://github.com/Ligerian-labs/contremaitre/releases/tag/v1.10.0-rc.1",
    "https://github.com/other/repository/releases/tag/v1.10.0",
    "http://github.com/Ligerian-labs/contremaitre/releases/tag/v1.10.0",
    "https://github.com/Ligerian-labs/contremaitre/releases/tag/v1.10.0/extra",
  ]) {
    const f = fixture({ latestUrl });
    await expect(updateBinary(context(), f.input, f.runner)).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
    expect(readFileSync(f.input.executable, "utf8")).toBe("old binary");
  }
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

test("Structure cli/stable-update scenario checks, updates and then skips the installed version", async () => {
  const installed = defineFixture({
    key: "cli/installed-binary",
    create: () => Effect.sync(() => fixture()),
  });
  const updated = defineFixture({
    key: "cli/updated-binary",
    dependencies: { installed },
    create: ({ dependencies }) =>
      Effect.tryPromise(async () => {
        const f = dependencies.installed;
        expect((await updateBinary(context(), { ...f.input, check: true }, f.runner)).status).toBe(
          "update-available",
        );
        expect(readFileSync(f.input.executable, "utf8")).toBe("old binary");
        expect((await updateBinary(context(), f.input, f.runner)).status).toBe("updated");
        const inode = statSync(f.input.executable).ino;
        expect(
          (await updateBinary(context(), { ...f.input, currentVersion: "1.10.0" }, f.runner))
            .status,
        ).toBe("up-to-date");
        expect(statSync(f.input.executable).ino).toBe(inode);
        return f;
      }),
  });
  const catalog = makeCatalog({
    base: { installed },
    scenarios: [
      defineScenario({
        name: "cli/stable-update",
        description:
          "Check a stable release, install its verified binary and skip a repeated update",
        input: Schema.Struct({}),
        fixtures: () => ({ updated }),
      }),
    ],
  });
  const fixtures = await Effect.runPromise(catalog.prepare("cli/stable-update", {}));
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
    `cli/stable-update run ${report.runId}, target: isolated temporary executable, inputs: {}`,
  );
});
