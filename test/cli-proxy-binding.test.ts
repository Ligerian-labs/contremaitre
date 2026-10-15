import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection, createServer as createTCPServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("host-runtime proxy stays bound while following its environment's current service", async () => {
  const home = mkdtempSync(join(tmpdir(), "cm-proxy-"));
  const upstreams = ["A", "B", "A-redeployed"].map((label) =>
    createTCPServer((socket) => socket.end(label)),
  );
  const ports = await Promise.all(
    upstreams.map(
      (server) =>
        new Promise<number>((resolve) => {
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address && typeof address !== "string") resolve(address.port);
          });
        }),
    ),
  );
  let switched = false;
  let portA = ports[0];
  let state: "running" | "stopped" | "missing" | "deleted" = "running";
  const requests: { env?: string }[] = [];
  const hub = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    if (req.url === "/v1/activity") {
      expect(payload.env).toBe("environment-a");
      res.writeHead(200);
      res.flushHeaders();
      return;
    }
    if (req.url !== "/v1/resolve") {
      res.writeHead(404).end();
      return;
    }
    requests.push(payload);
    const isA = payload.env === "environment-a" || !switched;
    const service = {
      Name: "web",
      Runtime: "wasm",
      Container: "web",
      Host: isA && state === "stopped" ? "" : "127.0.0.1",
      Ports: { "9000": isA ? portA : ports[1] },
      Spec: { kind: "app", wasm: "app.wasm" },
    };
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        isA && state === "deleted"
          ? { version: 1, error: "Environment not found" }
          : {
              version: 1,
              data: {
                Identity: { ID: isA ? "environment-a" : "environment-b" },
                Services: isA && state === "missing" ? {} : { web: service },
              },
            },
      ),
    );
  });
  await new Promise<void>((resolve) => hub.listen(join(home, "hub.sock"), resolve));
  const cliPath = fileURLToPath(new URL("../apps/cli/src/cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cliPath, "proxy", "web", "9000", "--json"], {
    cwd: home,
    env: { ...process.env, CONTREMAITRE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  let stderrOutput = "";
  const stderr = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) stderrOutput += decoder.decode(chunk, { stream: true });
    stderrOutput += decoder.decode();
  })();
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    const output = JSON.parse(new TextDecoder().decode(ready.value));
    const proxyPort = Number(output.data.address.split(":")[1]);
    const connect = () =>
      new Promise<string>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: proxyPort });
        let data = "";
        socket.setTimeout(3000, () => socket.destroy(Error("proxy connection timed out")));
        socket.on("data", (chunk) => {
          data += chunk;
        });
        socket.on("error", (error) => {
          if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
        });
        socket.on("close", () => resolve(data));
      });
    expect(await connect()).toBe("A");
    switched = true;
    expect(await connect()).toBe("A");
    portA = ports[2];
    expect(await connect()).toBe("A-redeployed");
    for (const unavailable of ["stopped", "missing", "deleted"] as const) {
      state = unavailable;
      expect(await connect()).toBe("");
      expect(child.exitCode).toBeNull();
      const reason = unavailable === "deleted" ? "Environment not found" : "Service is not running";
      const line = `[contremaitre] web: ${reason}\n`;
      const deadline = Date.now() + 1000;
      while (!stderrOutput.includes(line) && Date.now() < deadline) await Bun.sleep(10);
      expect(stderrOutput).toContain(line);
      stderrOutput = "";
    }
    state = "running";
    expect(await connect()).toBe("A-redeployed");
    expect(requests[0].env).toBe("");
    expect(requests.slice(1).every((request) => request.env === "environment-a")).toBe(true);
  } finally {
    child.kill();
    await child.exited;
    await stderr;
    hub.closeAllConnections();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    await Promise.all(
      upstreams.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
