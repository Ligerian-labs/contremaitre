import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const workflow = Bun.YAML.parse(
  readFileSync(resolve(import.meta.dir, "../.github/workflows/release.yml"), "utf8"),
) as { jobs: Record<string, { steps: { name?: string; run?: string }[] }> };

function script(name: string) {
  const step = Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .find((step) => step.name === name);
  if (!step?.run) throw Error(`Missing workflow step: ${name}`);
  return step.run;
}

function runStep(name: string, env: Record<string, string>, mockGh?: string) {
  const directory = mkdtempSync(join(tmpdir(), "cm-release-"));
  try {
    const output = join(directory, "output");
    writeFileSync(output, "");
    if (mockGh) writeFileSync(join(directory, "gh"), mockGh, { mode: 0o755 });
    const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", script(name)], {
      cwd: directory,
      env: {
        ...process.env,
        ...env,
        GITHUB_OUTPUT: output,
        GH_LOG: output,
        PATH: `${directory}:${process.env.PATH}`,
      },
    });
    return {
      code: result.exitCode,
      output: readFileSync(output, "utf8"),
      stdout: result.stdout.toString(),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [tag, prerelease] of [
  ["v1.2.3", "false"],
  ["v1.2.3-rc.1", "true"],
] as const) {
  test(`release parses ${tag}`, () => {
    const result = runStep("Parse version from tag", { GITHUB_REF_NAME: tag });
    expect(result.code).toBe(0);
    expect(result.output).toContain(`version=${tag.slice(1)}\n`);
    expect(result.output).toContain(`prerelease=${prerelease}\n`);
  });
}

for (const tag of ["vnext", "v1.2", "v1.2.3-", "v1.2.3;echo bad"]) {
  test(`release rejects ${tag}`, () => {
    const result = runStep("Parse version from tag", { GITHUB_REF_NAME: tag });
    expect(result.code).not.toBe(0);
    expect(result.output).toBe("");
  });
}

for (const version of ["1.2.3", "1.2.3-rc.1"]) {
  test(`release stamps ${version} into the manifest and CLI module`, () => {
    const directory = mkdtempSync(join(tmpdir(), "cm-release-version-"));
    try {
      mkdirSync(join(directory, "apps/cli/src"), { recursive: true });
      writeFileSync(join(directory, "package.json"), '{"name":"contremaitre","version":"0.0.0"}');
      writeFileSync(join(directory, "apps/cli/src/version.ts"), 'export const version = "0.0.0";');
      const result = Bun.spawnSync(
        ["bash", "-e", "-o", "pipefail", "-c", script("Stamp tag version into the CLI")],
        { cwd: directory, env: { ...process.env, VERSION: version } },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))).toEqual({
        name: "contremaitre",
        version,
      });
      const cliVersion = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          'import {version} from "./apps/cli/src/version.ts"; console.log(version)',
        ],
        { cwd: directory },
      );
      expect(cliVersion.exitCode).toBe(0);
      expect(cliVersion.stdout.toString().trim()).toBe(version);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

const mockGh = `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_LOG"
case "$2" in
  view)
    case "$RELEASE_STATE" in
      missing) exit 1 ;;
      draft) echo true ;;
      published) echo false ;;
    esac ;;
  upload) if [ "$UPLOAD_EXIT" = 1 ]; then exit 1; fi ;;
esac
`;

for (const state of ["missing", "draft", "published"]) {
  for (const prerelease of ["false", "true"]) {
    test(`release handles ${state}, prerelease=${prerelease}`, () => {
      const tag = prerelease === "true" ? "v1.2.3-rc.1" : "v1.2.3";
      const result = runStep(
        "Publish a complete release",
        { RELEASE_TAG: tag, PRERELEASE: prerelease, RELEASE_STATE: state },
        mockGh,
      );
      expect(result.code).toBe(0);
      if (state === "published") {
        expect(result.output).not.toContain("release upload");
        expect(result.output).not.toContain("release edit");
        expect(result.output).not.toContain("release create");
      } else {
        expect(result.output.includes("release create")).toBe(state === "missing");
        if (state === "missing") expect(result.output).toContain("--verify-tag --draft");
        expect(result.output).toContain(`release upload ${tag}`);
        expect(result.output).toContain(
          `release edit ${tag} --draft=false --prerelease=${prerelease} --latest=${prerelease === "false"}`,
        );
      }
    });
  }
}

test("failed asset uploads leave the release as a draft", () => {
  const result = runStep(
    "Publish a complete release",
    { RELEASE_TAG: "v1.2.3", PRERELEASE: "false", RELEASE_STATE: "draft", UPLOAD_EXIT: "1" },
    mockGh,
  );
  expect(result.code).not.toBe(0);
  expect(result.output).not.toContain("release edit");
});
