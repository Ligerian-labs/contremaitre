import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context } from "@contremaitre/execution/context";
import {
  loadManifest,
  manifestFile,
  manifestNames,
  projectName,
} from "@contremaitre/projects/config";
import { initProject } from "@contremaitre/projects/init";
import { sourceIdentity } from "@contremaitre/verification/source";
import { projectRoot } from "../apps/cli/src/client.js";

// Tests name the running platform's manifest, so they hold on macOS and Linux.
const own = `.contremaitre.${process.platform}`;
const other = `.contremaitre.${process.platform === "linux" ? "darwin" : "linux"}`;

const manifest = (project: string, port: number, profile = "smoke") =>
  `version: 1\nproject: ${project}\nservices:\n  web: {image: nginx, port: ${port}, http: true}\nverification:\n  profiles:\n    ${profile}:\n      - {name: check, command: [sh, -c, "true"]}\n`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cm-platform-"));
  return { root, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test("the platform manifest takes precedence over the shared one", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, ".contremaitre.yaml"), manifest("shared", 3000));
    expect(manifestFile(f.root)).toBe(join(f.root, ".contremaitre.yaml"));
    writeFileSync(join(f.root, `${other}.yaml`), manifest("elsewhere", 4000));
    expect(manifestFile(f.root)).toBe(join(f.root, ".contremaitre.yaml"));
    expect(projectName(f.root)).toBe("shared");
    writeFileSync(join(f.root, `${own}.yml`), manifest("here", 5000, "platform"));
    expect(manifestFile(f.root)).toBe(join(f.root, `${own}.yml`));
    expect(projectName(f.root)).toBe("here");
    const loaded = loadManifest(f.root);
    expect(loaded.services.web.port).toBe(5000);
    expect(Object.keys(loaded.verification?.profiles ?? {})).toEqual(["platform"]);
    expect(manifestNames("linux")[0]).toEqual([
      ".contremaitre.linux.yaml",
      ".contremaitre.linux.yml",
    ]);
    expect(manifestFile(f.root, process.platform === "linux" ? "darwin" : "linux")).toContain(
      other,
    );
  } finally {
    f.clean();
  }
});

test("each manifest accepts one extension, even when another is in effect, and another platform's is not a fallback", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, `${other}.yaml`), manifest("elsewhere", 4000));
    expect(() => manifestFile(f.root)).toThrow("No .contremaitre.yaml");
    writeFileSync(join(f.root, `${own}.yaml`), manifest("here", 5000));
    writeFileSync(join(f.root, `${own}.yml`), manifest("here", 5000));
    expect(() => manifestFile(f.root)).toThrow(`Both ${own}.yaml and ${own}.yml exist`);
    rmSync(join(f.root, `${own}.yml`));
    writeFileSync(join(f.root, ".contremaitre.yaml"), manifest("shared", 3000));
    writeFileSync(join(f.root, ".contremaitre.yml"), manifest("shared", 3000));
    // A duplicate shared pair stays an error beside a platform manifest:
    // every name takes one extension, in effect or not.
    for (const read of [manifestFile, loadManifest, projectName])
      expect(() => read(f.root)).toThrow("Both .contremaitre.yaml and .contremaitre.yml exist");
    rmSync(join(f.root, ".contremaitre.yml"));
    expect(manifestFile(f.root)).toBe(join(f.root, `${own}.yaml`));
    // Both pairs doubled: the platform pair is reported first.
    writeFileSync(join(f.root, ".contremaitre.yml"), manifest("shared", 3000));
    writeFileSync(join(f.root, `${own}.yml`), manifest("here", 5000));
    expect(() => manifestFile(f.root)).toThrow(`Both ${own}.yaml and ${own}.yml exist`);
    rmSync(join(f.root, `${own}.yaml`));
    rmSync(join(f.root, `${own}.yml`));
    expect(() => manifestFile(f.root)).toThrow(
      "Both .contremaitre.yaml and .contremaitre.yml exist",
    );
  } finally {
    f.clean();
  }
});

test("platform manifests stay version 1: compact config shares one lock", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "package.json"), JSON.stringify({ scripts: { dev: "bun x.ts" } }));
    writeFileSync(join(f.root, `${own}.yaml`), "version: 2\nproject: compact\napps: {app: '.'}\n");
    expect(() => loadManifest(f.root)).toThrow(`${own}.yaml must use version 1`);
    expect(() => projectName(f.root)).toThrow("must use version 1");
    expect(() => initProject(f.root)).toThrow("must use version 1");
    expect(existsSync(join(f.root, ".contremaitre.lock"))).toBe(false);
  } finally {
    f.clean();
  }
});

test("init treats a platform manifest as the existing manifest", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "docker"));
    writeFileSync(join(f.root, "docker", "api.Dockerfile"), "FROM node:22\nEXPOSE 3000\n");
    writeFileSync(join(f.root, `${own}.yaml`), manifest("here", 5000));
    expect(() => initProject(f.root)).toThrow(`Manifest already exists: ${own}.yaml`);
    expect(existsSync(join(f.root, ".contremaitre.yaml"))).toBe(false);
  } finally {
    f.clean();
  }
});

test("the project root and the source identity follow the manifest in effect", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "nested"));
    writeFileSync(join(f.root, `${own}.yaml`), manifest("here", 5000));
    expect(projectRoot(join(f.root, "nested"))).toBe(f.root);
    const before = await sourceIdentity(context(), f.root);
    // The shared manifest is only a file in the tree here; its semantics are not.
    writeFileSync(join(f.root, ".contremaitre.yaml"), manifest("shared", 3000));
    const shared = await sourceIdentity(context(), f.root);
    expect(shared.fingerprint).not.toBe(before.fingerprint);
    writeFileSync(join(f.root, `${own}.yaml`), manifest("here", 5001));
    const changed = await sourceIdentity(context(), f.root);
    expect(changed.fingerprint).not.toBe(shared.fingerprint);
  } finally {
    f.clean();
  }
});
