const http = require("node:http");
console.error(
  JSON.stringify({ event: "wasix.runtime", platform: process.platform, arch: process.arch }),
);
http
  .createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        greeting: process.env.GREETING,
        host: process.env.HOST,
        port: process.env.PORT,
        hostOnly: process.env.WASIX_HOST_ONLY,
      }),
    );
  })
  .listen(Number(process.env.PORT), process.env.HOST);
