import { PGlite } from "../../../packages/environments/node_modules/@electric-sql/pglite/dist/index.js";
import { pgliteAssets } from "../../../packages/environments/src/pglite-assets.js";

const db = new PGlite({
  dataDir: process.argv[2],
  username: "postgres",
  database: "postgres",
  pgliteWasmModule: await WebAssembly.compile(await Bun.file(pgliteAssets.wasm).arrayBuffer()),
  initdbWasmModule: await WebAssembly.compile(await Bun.file(pgliteAssets.initdb).arrayBuffer()),
  fsBundle: Bun.file(pgliteAssets.bundle),
});
await db.waitReady;
await db.close();
