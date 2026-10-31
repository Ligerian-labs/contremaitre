const sql = new Bun.SQL(process.env.DATABASE_URL);
const redis = new Bun.RedisClient(process.env.REDIS_URL);
Bun.serve({
  hostname: "0.0.0.0",
  port: 3000,
  async fetch() {
    const messages = await sql`SELECT id, body FROM messages ORDER BY id`;
    const visits = await redis.incr("visits");
    return Response.json({ runtime: "docker", messages, visits });
  },
});
console.log("Listening on port 3000");
