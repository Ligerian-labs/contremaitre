import { SQL } from "bun";
import { startPglite } from "../../../packages/environments/src/pglite-server.js";

const server = await startPglite({ dataDir: process.argv[2], port: 48530 });
const sql = new SQL(server.url(), { max: 1 });
await sql`CREATE TABLE durable_records (id integer PRIMARY KEY)`;
await sql`INSERT INTO durable_records VALUES (42)`;
await sql.close();
console.log("lock owner ready");
setInterval(() => {}, 1000);
