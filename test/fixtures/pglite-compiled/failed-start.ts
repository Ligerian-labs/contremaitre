import { startPglite } from "../../../packages/environments/src/pglite-server.js";

const errors: string[] = [];
for (let i = 0; i < 3; i++) {
  try {
    const server = await startPglite({ dataDir: process.argv[2], port: Number(process.argv[3]) });
    await server.stop();
    errors.push("unexpected success");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}
Bun.gc(true);
await Bun.sleep(100);
console.log(JSON.stringify(errors));
