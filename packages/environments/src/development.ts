import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import ignore from "@balena/dockerignore";
import { type Context, decode, fail, isCode, strings } from "@contremaitre/execution/context";
import { atomicWrite } from "@contremaitre/execution/files";
import { inside, safePath } from "@contremaitre/projects/config";
import type { Service } from "@contremaitre/projects/model";
import { Schema } from "effect";

const checkpoint = Schema.Struct({
  files: strings,
  pending: Schema.Struct({
    changed: Schema.Array(Schema.String),
    removed: Schema.Array(Schema.String),
    dependenciesChanged: Schema.Boolean,
  }),
});

const dependency =
  /^(package\.json|bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.npmrc|\.yarnrc.*)$/;
const excluded = new Set([
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
]);
export interface SourceChanges {
  changed: string[];
  removed: string[];
  dependenciesChanged: boolean;
}

// The mirror is host-owned. Containers only receive archives, never write into it.
export class DevelopmentSource {
  readonly directory: string;
  private files: Record<string, string> = Object.create(null);
  private signatures = new Map<string, string>();
  private pending: SourceChanges = { changed: [], removed: [], dependenciesChanged: false };
  constructor(
    readonly root: string,
    readonly stateDirectory: string,
    readonly dev: NonNullable<Service["dev"]>,
  ) {
    this.directory = join(stateDirectory, "source");
  }
  async load() {
    try {
      const saved = decode(
        checkpoint,
        JSON.parse(await fs.readFile(join(this.stateDirectory, "files.json"), "utf8")),
        "development source checkpoint",
      );
      for (const p of [
        ...Object.keys(saved.files),
        ...saved.pending.changed,
        ...saved.pending.removed,
      ])
        if (!p || p === "." || isAbsolute(p) || !inside(this.directory, resolve(this.directory, p)))
          fail("Development checkpoint contains an unsafe path");
      this.files = Object.assign(Object.create(null), saved.files);
      this.pending = {
        ...saved.pending,
        changed: [...saved.pending.changed],
        removed: [...saved.pending.removed],
      };
    } catch (e) {
      if (!isCode(e, "ENOENT")) throw e;
    }
  }
  paths() {
    return Object.keys(this.files);
  }
  private save() {
    atomicWrite(
      join(this.stateDirectory, "files.json"),
      JSON.stringify({ files: this.files, pending: this.pending }),
    );
  }
  acknowledge() {
    this.pending = {
      changed: [],
      removed: [],
      dependenciesChanged: this.pending.dependenciesChanged,
    };
    this.save();
  }
  async refresh(ctx: Context, deploy = false): Promise<SourceChanges> {
    const root = safePath(this.root, this.dev.source);
    if (!(await fs.stat(root)).isDirectory()) fail("dev.source must be a directory");
    if (inside(root, this.stateDirectory)) fail("Contremaitre state must be outside dev.source");
    let patterns = "";
    try {
      patterns = await fs.readFile(join(root, ".gitignore"), "utf8");
    } catch (e) {
      if (!isCode(e, "ENOENT")) throw e;
    }
    const matcher = ignore()
      .add(patterns)
      .add([...(this.dev.exclude ?? [])]);
    const next: Record<string, string> = Object.create(null),
      changed: string[] = [],
      removed: string[] = [];
    const signatures = new Map(this.signatures);
    let dependenciesChanged = false,
      count = 0,
      bytes = 0;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const ensureDirectory = async (path: string): Promise<void> => {
      if (path === this.directory) return;
      await ensureDirectory(dirname(path));
      try {
        if (!(await fs.lstat(path)).isDirectory()) await fs.rm(path, { force: true });
      } catch (e) {
        if (!isCode(e, "ENOENT")) throw e;
      }
      await fs.mkdir(path, { recursive: true, mode: 0o700 });
    };
    const walk = async (dir: string): Promise<void> => {
      ctx.signal.throwIfAborted();
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name),
          rel = relative(root, path);
        if (
          excluded.has(entry.name) ||
          /^\.env(?:\.|$)/.test(entry.name) ||
          /\.(pem|key)$/.test(entry.name)
        )
          continue;
        if (matcher.ignores(rel)) continue;
        if (++count > 50_000)
          fail("Development source exceeds 50000 entries; narrow dev.source or dev.exclude");
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        const resolved = await fs.realpath(path);
        if (!inside(root, resolved)) fail(`Development source symlink escapes project: ${rel}`);
        const stat = await fs.stat(path);
        if (!stat.isFile()) fail(`Development source must contain regular files: ${rel}`);
        bytes += stat.size;
        if (stat.size > 64 * 1024 * 1024 || bytes > 512 * 1024 * 1024)
          fail("Development source is too large; use dev.exclude for data and artifacts");
        const signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.mode}`;
        let digest = this.files[rel];
        let data: Buffer | undefined;
        if (deploy || this.signatures.get(rel) !== signature || !digest) {
          data = await fs.readFile(resolved);
          digest = createHash("sha256")
            .update(data)
            .update(String(stat.mode & 0o777))
            .digest("hex");
        }
        if (!deploy && dependency.test(entry.name) && digest !== this.files[rel]) {
          dependenciesChanged = true;
          if (this.files[rel]) next[rel] = this.files[rel];
          continue;
        }
        next[rel] = digest;
        signatures.set(rel, signature);
        if (digest !== this.files[rel] || deploy) {
          const target = join(this.directory, rel);
          await ensureDirectory(dirname(target));
          try {
            if ((await fs.lstat(target)).isDirectory()) await fs.rm(target, { recursive: true });
          } catch (e) {
            if (!isCode(e, "ENOENT")) throw e;
          }
          await fs.writeFile(target, data ?? (await fs.readFile(resolved)), {
            mode: stat.mode & 0o777,
          });
          await fs.chmod(target, stat.mode & 0o777);
          changed.push(rel);
        }
      }
    };
    await walk(root);
    for (const rel of Object.keys(this.files))
      if (!(rel in next)) {
        if (!deploy && dependency.test(basename(rel))) {
          next[rel] = this.files[rel];
          dependenciesChanged = true;
          continue;
        }
        // A file may have become a directory containing new source files, or vice versa.
        try {
          if (!(await fs.lstat(join(this.directory, rel))).isDirectory())
            await fs.rm(join(this.directory, rel), { force: true });
        } catch (e) {
          if (!isCode(e, "ENOENT") && !isCode(e, "ENOTDIR")) throw e;
        }
        removed.push(rel);
        signatures.delete(rel);
      }
    const checkpointChanged =
      changed.length > 0 ||
      removed.length > 0 ||
      dependenciesChanged !== this.pending.dependenciesChanged;
    this.files = next;
    this.pending = {
      changed: [...new Set([...this.pending.changed, ...changed])].filter((p) => p in next),
      removed: [...new Set([...this.pending.removed, ...removed])].filter((p) => !(p in next)),
      dependenciesChanged,
    };
    if (checkpointChanged) this.save();
    this.signatures = signatures;
    return this.pending;
  }
}
