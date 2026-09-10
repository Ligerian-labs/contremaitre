import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import ignore from "@balena/dockerignore";
import { type Context, fail, isCode } from "@contremaitre/execution/context";
import { run } from "@contremaitre/execution/process";
import { inside, loadManifest, safePath } from "@contremaitre/projects/config";

const generated = new Set([
  ".git",
  ".jj",
  "node_modules",
  ".turbo",
  ".next",
  ".svelte-kit",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".venv",
  ".contremaitre",
]);
async function optional(path: string) {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return "";
    throw error;
  }
}

/** Hash contents and modes, never emit file contents or environment values. */
export async function sourceIdentity(ctx: Context, directory: string) {
  const root = await fs.realpath(directory);
  const manifest = loadManifest(root);
  const digest = createHash("sha256").update("contremaitre-source-v1\0");
  // Exclusions must never hide changes to runtime configuration or verification profiles.
  digest.update(JSON.stringify(manifest));
  let entries = 0,
    bytes = 0;
  const file = async (path: string, label: string) => {
    ctx.signal.throwIfAborted();
    const actual = await fs.realpath(path);
    if (!inside(root, actual)) fail(`Source escapes project: ${label}`);
    const before = await fs.stat(actual);
    if (!before.isFile()) fail(`Source must be a regular file: ${label}`);
    bytes += before.size;
    if (++entries > 50000 || before.size > 64 * 1048576 || bytes > 512 * 1048576)
      fail(
        "Source fingerprint exceeds 50000 files or 512 MiB; narrow build contexts and verification.exclude",
      );
    digest.update(JSON.stringify([label, before.mode & 0o777, before.size]));
    const handle = await fs.open(actual, "r");
    let read = 0;
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        ctx.signal.throwIfAborted();
        read += chunk.length;
        if (read > before.size) fail("Source grew while fingerprinting; retry ensure");
        digest.update(chunk);
      }
      const after = await handle.stat();
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        fail("Source changed while fingerprinting; retry ensure");
    } finally {
      await handle.close();
    }
  };
  const tree = async (base: string, patterns: string, label: string, defaults: boolean) => {
    const matcher = ignore().add(patterns);
    const negations = patterns.split("\n").some((p) => p.trim().startsWith("!"));
    const walk = async (dir: string): Promise<void> => {
      ctx.signal.throwIfAborted();
      for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (
          entry.name === ".git" ||
          entry.name === ".jj" ||
          (defaults &&
            (generated.has(entry.name) ||
              /^\.env(?:\.|$)/.test(entry.name) ||
              /\.(pem|key)$/.test(entry.name)))
        )
          continue;
        const path = join(dir, entry.name),
          rel = relative(base, path);
        const excluded = matcher.ignores(rel);
        if (entry.isDirectory()) {
          if (++entries > 50000) fail("Source fingerprint exceeds 50000 entries");
          if (!excluded || negations) await walk(path);
        } else if (!excluded) await file(path, `${label}/${rel}`);
      }
    };
    await walk(base);
  };
  await tree(
    root,
    `${await optional(join(root, ".gitignore"))}\n${(manifest.verification?.exclude ?? []).join("\n")}`,
    "workspace",
    true,
  );
  for (const [name, service] of Object.entries(manifest.services)) {
    if (service.build) {
      const base = safePath(root, service.build);
      const dockerfile = safePath(root, service.dockerfile || join(service.build, "Dockerfile"));
      let patterns = await optional(`${dockerfile}.dockerignore`);
      // An empty Dockerfile-specific ignore file still overrides the root ignore file.
      if (!(await fs.stat(`${dockerfile}.dockerignore`).catch(() => undefined)))
        patterns = await optional(join(base, ".dockerignore"));
      await file(dockerfile, `dockerfile/${name}`);
      await tree(base, patterns, `build/${name}`, false);
    }
    const envFiles =
      typeof service.env_file === "string" ? [service.env_file] : (service.env_file ?? []);
    for (const path of envFiles) await file(safePath(root, path), `env/${name}/${path}`);
    if (service.dev) {
      const base = safePath(root, service.dev.source);
      await tree(
        base,
        `${await optional(join(base, ".gitignore"))}\n${(service.dev.exclude ?? []).join("\n")}`,
        `dev/${name}`,
        true,
      );
    }
  }
  let revision: string | undefined;
  const vcs = async (args: string[]) =>
    (await run(ctx, args, { cwd: root, timeout: 5000, maxOutput: 200 })).toString().trim();
  let jj = false;
  for (let p = root; ; p = dirname(p)) {
    if (await fs.stat(join(p, ".jj")).catch(() => undefined)) {
      jj = true;
      break;
    }
    if (dirname(p) === p) break;
  }
  try {
    revision = jj
      ? await vcs([
          "jj",
          "log",
          "--ignore-working-copy",
          "-r",
          "@",
          "--no-graph",
          "-T",
          "commit_id",
        ])
      : await vcs(["git", "rev-parse", "HEAD"]);
  } catch {
    ctx.signal.throwIfAborted();
  }
  return { fingerprint: digest.digest("hex"), ...(revision ? { revision } : {}) };
}
