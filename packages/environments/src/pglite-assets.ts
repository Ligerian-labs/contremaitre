// PGlite does not export its binary assets as package subpaths.
// @ts-expect-error Bun's file loader returns an embedded path at build time.
import initdb from "../node_modules/@electric-sql/pglite/dist/initdb.wasm" with { type: "file" };
// @ts-expect-error Bun's file loader returns an embedded path at build time.
import pgcrypto from "../node_modules/@electric-sql/pglite/dist/pgcrypto.tar.gz" with {
  type: "file",
};
// @ts-expect-error Bun's file loader returns an embedded path at build time.
import bundle from "../node_modules/@electric-sql/pglite/dist/pglite.data" with { type: "file" };
// @ts-expect-error Bun's file loader returns an embedded path at build time.
import wasm from "../node_modules/@electric-sql/pglite/dist/pglite.wasm" with { type: "file" };

export const pgliteAssets = {
  initdb: String(initdb),
  bundle: String(bundle),
  wasm: String(wasm),
  pgcrypto: String(pgcrypto),
};

/** Read only the headers; compiling the modules belongs on the database worker. */
export async function checkPgliteAssets(): Promise<void> {
  for (const [name, path] of Object.entries(pgliteAssets)) {
    const file = Bun.file(path);
    try {
      if (!file.size) throw new Error("empty asset");
      const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if ((name === "wasm" || name === "initdb") && header.join(",") !== "0,97,115,109")
        throw new Error("invalid WASM header");
      if (name === "pgcrypto" && (header[0] !== 31 || header[1] !== 139))
        throw new Error("invalid gzip header");
    } catch (error) {
      throw new Error(`PGlite ${name} asset is unavailable or invalid`, { cause: error });
    }
  }
}
