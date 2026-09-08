import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ignore from "@balena/dockerignore";
import { inside } from "./config.js";
import { type Context, fail, isCode } from "./model.js";

export async function prepareBuildContext(
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
  await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(join(cache, "context-"));
  const targetRoot = join(dir, "context"),
    definition = join(dir, "definition", "Dockerfile");
  const cleanup = async () => {
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
    await fs.mkdir(targetRoot, { mode: 0o700 });
    await fs.mkdir(dirname(definition), { mode: 0o700 });
    const docker = await fs.readFile(dockerfile);
    await fs.writeFile(definition, docker, { mode: 0o600 });
    await fs.writeFile(`${definition}.dockerignore`, patterns, { mode: 0o600 });
    const digest = createHash("sha256")
      .update("context-ts-v1\0")
      .update(docker)
      .update("\0")
      .update(patterns);
    let files = 0,
      bytes = 0;
    const walk = async (path: string): Promise<void> => {
      ctx.signal.throwIfAborted();
      const rel = relative(root, path),
        info = await fs.lstat(path),
        target = join(targetRoot, rel);
      const excluded = rel !== "" && matcher.ignores(rel);
      if (info.isDirectory()) {
        if (excluded && !negations) return;
        // Recheck parent confinement before enumeration; never follow directory links.
        if (!inside(root, await fs.realpath(path))) fail(`Build directory escapes context: ${rel}`);
        if (!excluded) await fs.mkdir(target, { recursive: true, mode: 0o700 });
        for (const entry of (await fs.readdir(path)).sort()) await walk(join(path, entry));
        try {
          await fs.stat(target);
        } catch (e) {
          if (isCode(e, "ENOENT")) return;
          throw e;
        }
        digest.update(JSON.stringify([rel, info.mode & 0o777, "directory"]));
        await fs.chmod(target, info.mode & 0o777);
        await fs.utimes(target, info.mtime, info.mtime);
        return;
      }
      if (excluded) return;
      await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
      digest.update(JSON.stringify([rel, info.mode & 0o777]));
      if (info.isSymbolicLink()) {
        let link = await fs.readlink(path);
        const dest = resolve(dirname(path), link);
        if (!inside(root, dest)) fail(`Build symlink escapes context: ${rel}`);
        if (isAbsolute(link))
          link = relative(dirname(target), join(targetRoot, relative(root, dest)));
        digest.update(JSON.stringify(link));
        await fs.symlink(link, target);
        return;
      }
      if (!info.isFile()) fail(`Unsupported build context entry: ${rel}`);
      const input = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let count = 0;
      try {
        const before = await input.stat();
        if (before.ino !== info.ino || before.dev !== info.dev)
          fail(`Build source changed: ${rel}; retry deploy`);
        if (!inside(root, await fs.realpath(path))) fail(`Build file escapes context: ${rel}`);
        const out = await fs.open(target, "wx", 0o600);
        try {
          digest.update(`${info.size}\0`);
          for await (const chunk of input.createReadStream({ autoClose: false })) {
            ctx.signal.throwIfAborted();
            const data = Buffer.from(chunk);
            digest.update(data);
            let offset = 0;
            while (offset < data.length) {
              const r = await out.write(data, offset);
              offset += r.bytesWritten;
            }
            count += data.length;
          }
        } finally {
          await out.close();
        }
        const after = await input.stat();
        if (count !== info.size || after.mtimeMs !== before.mtimeMs || after.size !== before.size)
          fail(`Build source changed: ${rel}; retry deploy`);
      } finally {
        await input.close();
      }
      await fs.chmod(target, info.mode & 0o777);
      await fs.utimes(target, info.mtime, info.mtime);
      files++;
      bytes += count;
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
