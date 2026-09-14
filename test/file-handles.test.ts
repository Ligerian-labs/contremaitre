import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fingerprintBuildContext,
  prepareBuildContext,
} from "@contremaitre/environments/build-context";
import { context } from "@contremaitre/execution/context";
import { sourceIdentity } from "@contremaitre/verification/source";
import { copyTree } from "../packages/environments/src/clone.js";

function openFiles(root: string) {
  // Count actual OS handles: FileHandle.close() can succeed while Bun leaks a stream's fd.
  const result = spawnSync("/usr/sbin/lsof", ["-nP", "-p", String(process.pid), "-Fn"], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return result.stdout.split("\n").filter((line) => line.startsWith(`n${root}/`));
}

for (const operation of [
  "build fingerprint",
  "build snapshot",
  "source identity",
  "persistent files",
] as const)
  test.skipIf(process.platform !== "darwin")(
    `${operation} releases file handles after repeated reads and failures`,
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "cm-handles-")));
      const cache = await realpath(await mkdtemp(join(tmpdir(), "cm-handles-cache-")));
      const contents = Buffer.alloc(256 * 1024 + 17, "a");
      const read = async () => {
        if (operation === "persistent files") {
          const target = join(cache, "copy");
          try {
            await copyTree(context(), root, target);
            const copied = await readFile(join(target, "input"));
            expect(copied).toEqual(contents);
            return createHash("sha256").update(copied).digest("hex");
          } finally {
            await rm(target, { recursive: true, force: true });
          }
        }
        if (operation === "source identity")
          return (await sourceIdentity(context(), root)).fingerprint;
        if (operation === "build fingerprint")
          return (await fingerprintBuildContext(context(), root, "Dockerfile")).digest;
        const snapshot = await prepareBuildContext(context(), root, "Dockerfile", cache);
        try {
          expect(await readFile(join(snapshot.root, "input"))).toEqual(contents);
          return snapshot.digest;
        } finally {
          await snapshot.cleanup();
        }
      };
      try {
        await writeFile(
          join(root, ".contremaitre.yaml"),
          "version: 1\nproject: handles\nservices:\n  web: {build: .}\n",
        );
        await writeFile(join(root, "Dockerfile"), "FROM scratch\nCOPY . /app\n");
        await writeFile(join(root, "input"), contents);
        expect(openFiles(root)).toEqual([]);
        const original = await read();
        for (let i = 0; i < 3; i++) expect(await read()).toBe(original);
        expect(openFiles(root)).toEqual([]);
        expect(openFiles(cache)).toEqual([]);

        // Exercise the last, partial buffer as well as full chunks.
        contents[contents.length - 1] = 98;
        await writeFile(join(root, "input"), contents);
        expect(await read()).not.toBe(original);
        await symlink("/etc/passwd", join(root, "z-escape"));
        await expect(read()).rejects.toThrow(
          operation === "persistent files" ? "Symlinks" : "escapes",
        );
        expect(openFiles(root)).toEqual([]);
        expect(openFiles(cache)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(cache, { recursive: true, force: true });
      }
    },
  );
