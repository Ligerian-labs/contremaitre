import { dlopen, FFIType } from "bun:ffi";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

// Keep the sibling inode stable: unlinking a lock file lets another process lock
// a different inode. The kernel releases the advisory lock if its owner dies.
export async function lockPgliteData(dataDir: string): Promise<() => Promise<void>> {
  const absolute = resolve(dataDir);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const canonical = await realpath(absolute).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return realpath(dirname(absolute)).then((parent) => join(parent, basename(absolute)));
  });
  const path = `${canonical}.pglite-lock`;
  const library = dlopen(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
    {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    },
  );
  const file = await open(path, "a+", 0o600).catch((error) => {
    library.close();
    throw error;
  });
  if (library.symbols.flock(file.fd, 2 | 4) !== 0) {
    await file.close();
    library.close();
    throw new Error(`PGlite data directory is locked: ${dataDir}`);
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await file.close();
    } finally {
      library.close();
    }
  };
}

export function pgliteDataDir(environmentDataDir: string, service: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(service)) throw new Error("Invalid PGlite service name");
  return join(environmentDataDir, ".services", service);
}

/** Call only for an explicit data deletion request, after stopping the runtime. */
export async function removePgliteData(dataDir: string): Promise<void> {
  const unlock = await lockPgliteData(dataDir);
  try {
    await rm(dataDir, { recursive: true, force: true });
    await rm(`${resolve(dataDir)}.pglite-log`, { force: true });
    await rm(`${resolve(dataDir)}.pglite-log.corrupt`, { force: true });
    await rm(`${resolve(dataDir)}.pglite-previous`, { recursive: true, force: true });
    await rm(`${resolve(dataDir)}.pglite-init`, { recursive: true, force: true });
  } finally {
    await unlock();
  }
}

/** Caller holds the data lock. A missing target means publication never completed. */
export async function recoverPglitePublication(dataDir: string): Promise<void> {
  const absolute = resolve(dataDir);
  for (const name of await readdir(dirname(absolute))) {
    if (name.startsWith(`${basename(absolute)}.fork-`))
      await rm(join(dirname(absolute), name), { recursive: true, force: true });
  }
  const backup = `${absolute}.pglite-previous`;
  if (
    !(await lstat(backup).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    }))
  )
    return;
  const target = await lstat(dataDir).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (
    target &&
    (await lstat(join(dataDir, "PG_VERSION")).then(
      () => true,
      (error) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    ))
  )
    await rm(backup, { recursive: true });
  else {
    if (target) await rm(dataDir, { recursive: true });
    await rename(backup, dataDir);
  }
  await syncPgliteParent(dataDir);
}

export async function syncPgliteParent(path: string): Promise<void> {
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
