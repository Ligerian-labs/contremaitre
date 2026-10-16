import { createServer } from "node:net";

// Asks the OS for a loopback port that is free now. Concurrent test runs on one
// machine must never share fixed port numbers.
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (!address || typeof address === "string") throw Error("No loopback port assigned");
  return address.port;
}
