import { dlopen, FFIType, read } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type Context, phase } from "@contremaitre/execution/context";
import { copyTree } from "./clone.js";
import { lockPgliteData, recoverPglitePublication, syncPgliteParent } from "./pglite-data.js";

async function validateTree(ctx: Context, path: string): Promise<void> {
  ctx.signal.throwIfAborted();
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("Symlinks in PGlite data are unsupported");
  if (info.isDirectory()) {
    for (const name of await readdir(path)) await validateTree(ctx, join(path, name));
  } else if (!info.isFile()) throw new Error("Unsupported file in PGlite data");
}

// Unlike cp -c, clonefile never silently falls back to a byte copy.
function clonefile(source: string, target: string): boolean {
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    clonefile: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  });
  try {
    const status = library.symbols.clonefile(
      Buffer.from(`${source}\0`),
      Buffer.from(`${target}\0`),
      1,
    );
    if (status === 0) return true;
    const location = library.symbols.__error();
    if (!location) throw new Error("Cannot read clonefile errno");
    const errno = read.i32(location, 0);
    if (errno === 45 || errno === 18) return false; // ENOTSUP, EXDEV on Darwin.
    throw new Error(`PGlite clonefile failed (errno ${errno})`);
  } finally {
    library.close();
  }
}

// Swapping names publishes the entire new directory atomically, even when the
// old target contains a database. The old directory becomes the temporary tree.
function exchange(source: string, target: string): boolean {
  const mac = process.platform === "darwin";
  const symbol = mac ? "renameatx_np" : "renameat2";
  const library = dlopen(mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    [mac ? "__error" : "__errno_location"]: { args: [], returns: FFIType.ptr },
    [symbol]: {
      args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
      returns: FFIType.i32,
    },
  });
  try {
    const cwd = mac ? -2 : -100;
    if (
      library.symbols[symbol](
        cwd,
        Buffer.from(`${source}\0`),
        cwd,
        Buffer.from(`${target}\0`),
        2,
      ) !== 0
    ) {
      const location = library.symbols[mac ? "__error" : "__errno_location"]();
      const errno = location ? read.i32(location, 0) : 0;
      if ([18, 22, mac ? 45 : 95, 38].includes(errno)) return false;
      throw new Error(`Cannot atomically replace PGlite fork target (errno ${errno})`);
    }
    return true;
  } finally {
    library.close();
  }
}

/** quiesce pauses writers and closes the source, returning a restart hook. */
export async function forkPgliteData(options: {
  source: string;
  target: string;
  ctx: Context;
  quiesce?: () => Promise<() => Promise<void>>;
  forceCopy?: boolean;
  replace?: boolean;
  publication?: { exchange?: () => boolean; afterBackup?: () => Promise<void> };
}): Promise<{ method: "clonefile" | "copy" }> {
  const { ctx } = options;
  if ((await lstat(options.source).catch(() => undefined))?.isSymbolicLink())
    throw new Error("Symlinks in PGlite data are unsupported");
  const source = await realpath(options.source).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return resolve(options.source);
  });
  const target = resolve(options.target);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const canonicalTarget = join(
    await realpath(dirname(target)),
    target.slice(dirname(target).length + 1),
  );
  if (
    source === canonicalTarget ||
    canonicalTarget.startsWith(`${source}/`) ||
    source.startsWith(`${canonicalTarget}/`)
  )
    throw new Error("PGlite fork paths must be separate");
  const resume = await options.quiesce?.();
  const releases: Array<() => Promise<void>> = [];
  const temporary = `${target}.fork-${randomUUID()}`;
  try {
    ctx.signal.throwIfAborted();
    for (const path of [source, canonicalTarget].sort()) releases.push(await lockPgliteData(path));
    await recoverPglitePublication(source);
    await recoverPglitePublication(target);
    if (!(await lstat(source)).isDirectory()) throw new Error("PGlite source must be a directory");
    const existing = await lstat(target).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (existing && (!options.replace || !existing.isDirectory() || existing.isSymbolicLink()))
      throw new Error("PGlite fork target already exists or is not a directory");
    await validateTree(ctx, source);
    let method: "clonefile" | "copy" = "copy";
    if (process.platform === "darwin" && !options.forceCopy) {
      if (clonefile(source, temporary)) method = "clonefile";
    }
    if (method === "copy") {
      await rm(temporary, { recursive: true, force: true });
      await copyTree(ctx, source, temporary);
      phase(ctx, "PGlite fork uses full copy; clonefile unavailable or disabled");
    }
    ctx.signal.throwIfAborted();
    if (existing) {
      if (!(options.publication?.exchange?.() ?? exchange(temporary, target))) {
        const backup = `${target}.pglite-previous`;
        await rename(target, backup);
        try {
          await syncPgliteParent(target);
          await options.publication?.afterBackup?.();
          await rename(temporary, target);
          await syncPgliteParent(target);
        } catch (error) {
          await rm(target, { recursive: true, force: true });
          await rename(backup, target);
          await syncPgliteParent(target);
          throw error;
        }
        await recoverPglitePublication(target);
      }
    } else await rename(temporary, target);
    return { method };
  } finally {
    try {
      await rm(temporary, { recursive: true, force: true });
    } finally {
      try {
        for (const release of releases.reverse()) await release();
      } finally {
        await resume?.();
      }
    }
  }
}
