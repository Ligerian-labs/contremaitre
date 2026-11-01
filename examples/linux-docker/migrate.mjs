const sql = new Bun.SQL(process.env.DATABASE_URL);
try {
  await sql`CREATE TABLE IF NOT EXISTS messages (id integer PRIMARY KEY, body text NOT NULL)`;
  await sql`INSERT INTO messages VALUES (1, 'Hello from Linux Docker') ON CONFLICT (id) DO NOTHING`;
  console.log("Database ready");
} finally {
  await sql.close();
}
