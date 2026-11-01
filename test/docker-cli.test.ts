import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection, createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use the persisted runtime, even when the CLI runs on a different test host.
test("Docker CLI exec, logs and TCP proxy use the recorded container engine", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-docker-cli-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "container"), "#!/bin/sh\necho wrong-container-engine >&2\nexit 99\n", {
    mode: 0o700,
  });
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='exec')console.log('docker-exec-ok');
else if(args[0]==='logs')console.log('docker-logs-ok');
else if(args[0]==='inspect')console.log(JSON.stringify([{State:{Running:true},NetworkSettings:{Networks:{private:{IPAddress:'127.0.0.1'}}}}]));
else process.exit(88);
`,
    { mode: 0o700 },
  );
  const upstream = tcpServer((socket) => socket.end("docker-proxy-ok"));
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  const address = upstream.address();
  if (!address || typeof address === "string") throw Error("Expected TCP address");
  const hub = createServer(async (request, response) => {
    for await (const _ of request) {
      /* consume the request */
    }
    if (request.url === "/v1/activity") {
      response.writeHead(200);
      response.flushHeaders();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        version: 1,
        data: {
          Identity: { ID: "docker-cli" },
          Services: {
            web: {
              Name: "web",
              Runtime: "docker",
              Container: "cm-web",
              Host: "127.0.0.1",
              Port: address.port,
              Spec: { kind: "app" },
            },
          },
        },
      }),
    );
  });
  await new Promise<void>((done) => hub.listen(join(home, "hub.sock"), done));
  const env = { ...process.env, CONTREMAITRE_HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const cli = join(import.meta.dir, "../apps/cli/src/cli.ts");
  const start = (args: string[]) =>
    Bun.spawn([process.execPath, cli, ...args], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
  let proxy: ReturnType<typeof start> | undefined;
  try {
    for (const [args, expected] of [
      [["exec", "web", "--", "echo", "ok"], "docker-exec-ok"],
      [["logs", "web"], "docker-logs-ok"],
    ] as const) {
      const child = start([...args]);
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout.trim()).toBe(expected);
    }
    proxy = start(["proxy", "web", String(address.port), "--json"]);
    const reader = proxy.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    const record = JSON.parse(new TextDecoder().decode(ready.value));
    const port = Number(record.data.address.split(":")[1]);
    const result = await new Promise<string>((done, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      let data = "";
      socket.setTimeout(3000, () => socket.destroy(Error("Proxy timed out")));
      socket.on("data", (value) => {
        data += value;
      });
      socket.on("error", reject);
      socket.on("end", () => done(data));
    });
    expect(result).toBe("docker-proxy-ok");
  } finally {
    proxy?.kill();
    if (proxy) await proxy.exited;
    hub.closeAllConnections();
    await new Promise<void>((done) => hub.close(() => done()));
    await new Promise<void>((done) => upstream.close(() => done()));
    rmSync(home, { recursive: true, force: true });
  }
});
