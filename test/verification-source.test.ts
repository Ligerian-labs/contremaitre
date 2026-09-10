import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context } from "@contremaitre/execution/context";
import { parseManifest } from "@contremaitre/projects/config";
import { sourceIdentity } from "@contremaitre/verification/source";

test("source identity includes ignored build inputs and env files but excludes generated workspace output", async () => {
  const root = mkdtempSync(join(tmpdir(), "cm-source-"));
  try {
    writeFileSync(
      join(root, ".contremaitre.yaml"),
      "version: 1\nproject: demo\nservices:\n  web: {build: ., env_file: .env.local}\nverification:\n  profiles: {}\n  exclude: [test-output]\n",
    );
    writeFileSync(join(root, "Dockerfile"), "FROM scratch\n");
    writeFileSync(join(root, ".gitignore"), "hidden-source\n");
    writeFileSync(join(root, ".dockerignore"), "test-output\n.env*\n");
    writeFileSync(join(root, "hidden-source"), "one");
    writeFileSync(join(root, ".env.local"), "SECRET=first\n");
    const a = await sourceIdentity(context(), root);
    mkdirSync(join(root, "test-output"));
    writeFileSync(join(root, "test-output/result.txt"), "generated");
    expect((await sourceIdentity(context(), root)).fingerprint).toBe(a.fingerprint);
    writeFileSync(join(root, "hidden-source"), "two");
    const b = await sourceIdentity(context(), root);
    expect(b.fingerprint).not.toBe(a.fingerprint);
    writeFileSync(join(root, ".env.local"), "SECRET=second\n");
    const c = await sourceIdentity(context(), root);
    expect(c.fingerprint).not.toBe(b.fingerprint);
    expect(JSON.stringify(c)).not.toContain("second");
    symlinkSync("/etc/passwd", join(root, "escape"));
    await expect(sourceIdentity(context(), root)).rejects.toThrow("escapes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source identity always includes manifest semantics even when excluded", async () => {
  const root = mkdtempSync(join(tmpdir(), "cm-source-config-"));
  try {
    const manifest =
      "version: 1\nproject: demo\nservices:\n  web: {image: nginx}\nverification:\n  profiles: {}\n  exclude: [.contremaitre.yaml]\n";
    writeFileSync(join(root, ".contremaitre.yaml"), manifest);
    const before = await sourceIdentity(context(), root);
    writeFileSync(join(root, ".contremaitre.yaml"), manifest.replace("nginx", "alpine"));
    expect((await sourceIdentity(context(), root)).fingerprint).not.toBe(before.fingerprint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verification profiles reject ambiguous checks, escaping artifacts and unbounded execution", () => {
  const prefix =
    "version: 1\nproject: demo\nservices:\n  web: {image: nginx}\nverification:\n  profiles:\n    smoke:\n";
  for (const check of [
    "      - {name: test, command: []}\n",
    "      - {name: test, command: [true], service: absent}\n",
    "      - {name: test, command: [echo], timeout_seconds: 0}\n",
    "      - {name: test, command: [echo], artifacts: [../secret]}\n",
    "      - {name: test, command: [echo]}\n      - {name: test, command: [echo]}\n",
  ])
    expect(() => parseManifest(prefix + check)).toThrow();
});
