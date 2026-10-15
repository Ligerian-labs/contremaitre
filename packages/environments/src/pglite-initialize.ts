import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgliteAssets } from "./pglite-assets.js";

export const pgliteCompletionFile = ".pglite-complete";
export const pgliteInitializationDir = (dataDir: string): string =>
  `${resolve(dataDir)}.pglite-init`;

/** Called only on the worker while the owner holds the published directory's lock. */
export async function openPglite(dataDir: string, log: (text: string) => boolean): Promise<PGlite> {
  const options = {
    onStdout: log,
    onStderr: log,
    pgliteWasmModule: await WebAssembly.compile(await Bun.file(pgliteAssets.wasm).arrayBuffer()),
    initdbWasmModule: await WebAssembly.compile(await Bun.file(pgliteAssets.initdb).arrayBuffer()),
    fsBundle: Bun.file(pgliteAssets.bundle),
  };
  // Manager pre-creates an empty directory. A nonempty published tree is always
  // treated as user data, including legacy databases without our marker.
  const contents = await readdir(dataDir);
  if (contents.length) await rm(pgliteInitializationDir(dataDir), { recursive: true, force: true });
  if (contents.length && !contents.includes("PG_VERSION"))
    throw new Error("Nonempty PGlite directory lacks PG_VERSION; refusing to reset data");
  if (contents.length === 0) {
    const staging = pgliteInitializationDir(dataDir);
    const complete = await readFile(join(staging, pgliteCompletionFile), "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    if (complete !== "1\n") {
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { mode: 0o700 });
      const initial = new PGlite({
        ...options,
        dataDir: staging,
        username: "postgres",
        database: "postgres",
      });
      try {
        await initial.waitReady;
        await initial.exec("CREATE ROLE app LOGIN SUPERUSER");
        await initial.exec("CREATE DATABASE app OWNER app");
      } finally {
        await initial.close();
      }
      // A marker is meaningful only in the unpublished staging tree. Write and
      // sync it after clean close; a crash before publication can then resume.
      const marker = await open(join(staging, pgliteCompletionFile), "wx", 0o600);
      try {
        await marker.writeFile("1\n");
        await marker.sync();
      } finally {
        await marker.close();
      }
      const directory = await open(staging, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    // rename atomically replaces an existing empty directory, without rm+rename.
    await rename(staging, dataDir);
    const parent = await open(dirname(dataDir), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  const db = new PGlite({ ...options, dataDir, username: "app", database: "app" });
  try {
    await db.waitReady;
    await db.exec("SET SESSION AUTHORIZATION app");
    return db;
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
}
