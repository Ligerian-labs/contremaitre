import { createHash } from "node:crypto";
import { SQL } from "bun";
import { startPglite } from "../../../packages/environments/src/pglite-server.js";

const server = await startPglite({ dataDir: process.argv[2], port: Number(process.argv[3]) });
const sql = new SQL(server.url("anything"), { max: 1 });
try {
  const rows =
    await sql`SELECT 42 AS answer, current_user AS username, current_database() AS database`;
  if (rows[0].answer !== 42 || rows[0].username !== "app" || rows[0].database !== "app")
    throw new Error(JSON.stringify(rows));
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  const crypto = await sql`SELECT encode(digest('bigatelier', 'sha256'), 'hex') AS digest`;
  if (crypto[0].digest !== createHash("sha256").update("bigatelier").digest("hex"))
    throw new Error("compiled pgcrypto digest failed");
  console.log("compiled PGlite query passed");
} finally {
  await sql.close();
  await server.stop();
}
