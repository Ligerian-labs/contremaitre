import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBuildContext } from "@contremaitre/environments/build-context";
import { context } from "@contremaitre/execution/context";

test("staging excludes dependencies, preserves nested COPY, and hashes included changes only", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-context-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "src", "app.ts"), "hello");
    await writeFile(join(root, "node_modules", "ignored"), "huge");
    await writeFile(join(root, "Dockerfile"), "FROM scratch\nCOPY src /app\n");
    await writeFile(join(root, ".dockerignore"), "node_modules\n");
    const a = await prepareBuildContext(
      context(),
      root,
      "Dockerfile",
      join(root, "..", "cm-stage"),
    );
    try {
      expect(await readdir(a.root)).not.toContain("node_modules");
      expect(await readFile(join(a.root, "src", "app.ts"), "utf8")).toBe("hello");
      await writeFile(join(root, "node_modules", "ignored"), "changed");
      const b = await prepareBuildContext(
        context(),
        root,
        "Dockerfile",
        join(root, "..", "cm-stage"),
      );
      expect(b.digest).toBe(a.digest);
      await b.cleanup();
      await writeFile(join(root, "src", "app.ts"), "new");
      const c = await prepareBuildContext(
        context(),
        root,
        "Dockerfile",
        join(root, "..", "cm-stage"),
      );
      expect(c.digest).not.toBe(a.digest);
      await c.cleanup();
    } finally {
      await a.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Dockerfile-specific rules override root rules and outside symlinks fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-context-"));
  try {
    await writeFile(join(root, "Dockerfile"), "FROM scratch");
    await writeFile(join(root, ".dockerignore"), "included\n");
    await writeFile(join(root, "Dockerfile.dockerignore"), "ignored\n");
    await writeFile(join(root, "included"), "yes");
    await writeFile(join(root, "ignored"), "no");
    const a = await prepareBuildContext(
      context(),
      root,
      "Dockerfile",
      join(root, "..", "cm-stage"),
    );
    expect(await readdir(a.root)).toContain("included");
    expect(await readdir(a.root)).not.toContain("ignored");
    await a.cleanup();
    await symlink("/etc/passwd", join(root, "escape"));
    await expect(
      prepareBuildContext(context(), root, "Dockerfile", join(root, "..", "cm-stage")),
    ).rejects.toThrow("escapes context");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("negations reinclude descendants of excluded directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-negation-"));
  try {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "Dockerfile"), "FROM scratch");
    await writeFile(join(root, ".dockerignore"), "assets\n!assets/keep.txt\n");
    await writeFile(join(root, "assets", "keep.txt"), "keep");
    await writeFile(join(root, "assets", "drop.txt"), "drop");
    const staged = await prepareBuildContext(
      context(),
      root,
      "Dockerfile",
      join(root, "..", "cm-stage"),
    );
    try {
      expect(await readdir(join(staged.root, "assets"))).toEqual(["keep.txt"]);
    } finally {
      await staged.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
