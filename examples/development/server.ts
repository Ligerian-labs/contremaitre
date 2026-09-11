Bun.serve({
  hostname: "0.0.0.0",
  port: 3000,
  fetch: () => Response.json({ message: "API running in the shared application container" }),
});
Bun.serve({
  hostname: "0.0.0.0",
  port: 3001,
  fetch: () => new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Contremaitre development example</title><h1>One container, two endpoints</h1><p><a href="${Bun.escapeHTML(process.env.API_URL ?? "")}">Open the API</a></p></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  ),
});
