import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ignore from "@balena/dockerignore";
import { type Context, fail, isCode } from "@contremaitre/execution/context";
import { inside } from "@contremaitre/projects/config";

export function prepareBuildContext(
  ctx: Context,
  root: string,
  dockerfile: string,
  cache = join(
    homedir(),
    process.platform === "darwin" ? "Library/Caches" : ".cache",
    "contremaitre",
    "builds",
  ),
) {
  return readBuildContext(ctx, root, dockerfile, cache);
}

export async function fingerprintBuildContext(ctx: Context, root: string, dockerfile: string) {
  const { digest, files, bytes } = await readBuildContext(ctx, root, dockerfile);
  return { digest, files, bytes };
}

// Hash-only checks use the same traversal and byte validation as build snapshots.
async function readBuildContext(ctx: Context, root: string, dockerfile: string, cache?: string) {
  root = await fs.realpath(root);
  dockerfile = resolve(root, dockerfile);
  let patterns = "";
  try {
    patterns = await fs.readFile(`${dockerfile}.dockerignore`, "utf8");
  } catch (e) {
    if (!isCode(e, "ENOENT")) throw e;
    try {
      patterns = await fs.readFile(join(root, ".dockerignore"), "utf8");
    } catch (e) {
      if (!isCode(e, "ENOENT")) throw e;
    }
  }
  const matcher = ignore().add(patterns),
    negations = patterns.split("\n").some((p) => p.trim().startsWith("!"));
  if (cache) await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  const dir = cache ? await fs.mkdtemp(join(cache, "context-")) : undefined;
  const targetRoot = dir ? join(dir, "context") : "",
    definition = dir ? join(dir, "definition", "Dockerfile") : "";
  const cleanup = async () => {
    if (!dir) return;
    const writable = async (p: string): Promise<void> => {
      const s = await fs.lstat(p);
      if (!s.isDirectory()) return;
      await fs.chmod(p, 0o700);
      for (const n of await fs.readdir(p)) await writable(join(p, n));
    };
    await writable(dir);
    await fs.rm(dir, { recursive: true, force: true });
  };
  try {
    const docker = await fs.readFile(dockerfile);
    if (dir) {
      await fs.mkdir(targetRoot, { mode: 0o700 });
      await fs.mkdir(dirname(definition), { mode: 0o700 });
      await fs.writeFile(definition, docker, { mode: 0o600 });
      await fs.writeFile(`${definition}.dockerignore`, patterns, { mode: 0o600 });
    }
    const digest = createHash("sha256")
      .update("context-ts-v1\0")
      .update(docker)
      .update("\0")
      .update(patterns);
    let files = 0,
      bytes = 0;
    const walk = async (path: string): Promise<boolean> => {
      ctx.signal.throwIfAborted();
      const rel = relative(root, path),
        info = await fs.lstat(path),
        target = dir ? join(targetRoot, rel) : undefined;
      const excluded = rel !== "" && matcher.ignores(rel);
      if (info.isDirectory()) {
        if (excluded && !negations) return false;
        // Recheck parent confinement before enumeration; never follow directory links.
        if (!inside(root, await fs.realpath(path))) fail(`Build directory escapes context: ${rel}`);
        if (!excluded && target) await fs.mkdir(target, { recursive: true, mode: 0o700 });
        let included = !excluded;
        for (const entry of (await fs.readdir(path)).sort())
          included = (await walk(join(path, entry))) || included;
        if (!included) return false;
        digest.update(JSON.stringify([rel, info.mode & 0o777, "directory"]));
        if (target) {
          await fs.chmod(target, info.mode & 0o777);
          await fs.utimes(target, info.mtime, info.mtime);
        }
        return true;
      }
      if (excluded) return false;
      if (target) await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
      digest.update(JSON.stringify([rel, info.mode & 0o777]));
      if (info.isSymbolicLink()) {
        let link = await fs.readlink(path);
        const dest = resolve(dirname(path), link);
        if (!inside(root, dest)) fail(`Build symlink escapes context: ${rel}`);
        if (isAbsolute(link)) link = relative(dirname(path), dest);
        digest.update(JSON.stringify(link));
        if (target) await fs.symlink(link, target);
        return true;
      }
      if (!info.isFile()) fail(`Unsupported build context entry: ${rel}`);
      const input = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let count = 0;
      try {
        const before = await input.stat();
        if (before.ino !== info.ino || before.dev !== info.dev)
          fail(`Build source changed: ${rel}; retry deploy`);
        if (!inside(root, await fs.realpath(path))) fail(`Build file escapes context: ${rel}`);
        const out = target ? await fs.open(target, "wx", 0o600) : undefined;
        try {
          digest.update(`${info.size}\0`);
          for await (const chunk of input.createReadStream({ autoClose: false })) {
            ctx.signal.throwIfAborted();
            const data = Buffer.from(chunk);
            digest.update(data);
            let offset = 0;
            while (out && offset < data.length) {
              const r = await out.write(data, offset);
              offset += r.bytesWritten;
            }
            count += data.length;
          }
        } finally {
          await out?.close();
        }
        const after = await input.stat();
        if (count !== info.size || after.mtimeMs !== before.mtimeMs || after.size !== before.size)
          fail(`Build source changed: ${rel}; retry deploy`);
      } finally {
        await input.close();
      }
      if (target) {
        await fs.chmod(target, info.mode & 0o777);
        await fs.utimes(target, info.mtime, info.mtime);
      }
      files++;
      bytes += count;
      return true;
    };
    await walk(root);
    return {
      root: targetRoot,
      dockerfile: definition,
      digest: digest.digest("hex"),
      files,
      bytes,
      cleanup,
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
