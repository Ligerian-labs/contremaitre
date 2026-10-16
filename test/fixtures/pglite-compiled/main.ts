import { SQL } from "bun";
import { startPglite } from "../../../packages/environments/src/pglite-server.js";

const server = await startPglite({ dataDir: process.argv[2], port: Number(process.argv[3]) });
const sql = new SQL(server.url("anything"), { max: 1 });
try {
  const rows =
    await sql`SELECT 42 AS answer, current_user AS username, current_database() AS database`;
  if (rows[0].answer !== 42 || rows[0].username !== "app" || rows[0].database !== "app")
    throw new Error(JSON.stringify(rows));
  console.log("compiled PGlite query passed");
} finally {
  await sql.close();
  await server.stop();
}
