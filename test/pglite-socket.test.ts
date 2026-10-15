import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";

checkPgliteCleanup();

function response(
  worker: Worker,
  expected: string,
): Promise<{ socketDirectory: string; message?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Worker response timeout"));
    }, 15_000);
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message));
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data.type !== expected) return;
      cleanup();
      resolve(event.data);
    };
    function cleanup() {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    }
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

test("internal socket is always inside a private directory, cleaned on stop and bind failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-private-"));
  const blocker = createServer();
  const workers: Worker[] = [];
  const exits: Promise<void>[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(48534, "127.0.0.1", resolve);
    });
    for (const fail of [false, true]) {
      const dataDir = join(root, fail ? "failure" : "success");
      await mkdir(dataDir);
      const worker = new Worker(
        new URL("../packages/environments/src/pglite-worker.ts", import.meta.url),
      );
      workers.push(worker);
      exits.push(
        new Promise<void>((resolve) =>
          worker.addEventListener("close", () => resolve(), { once: true }),
        ),
      );
      const result = response(worker, fail ? "error" : "started");
      worker.postMessage({ type: "start", dataDir, host: "127.0.0.1", port: fail ? 48534 : 48535 });
      const { socketDirectory, message } = await result;
      expect(socketDirectory).toContain("cm-pglite-socket-");
      if (fail) expect(message).toContain("EADDRINUSE");
      else {
        expect((await stat(socketDirectory)).mode & 0o777).toBe(0o700);
        expect((await stat(join(socketDirectory, "postgres.sock"))).isSocket()).toBe(true);
        const stopped = response(worker, "stopped");
        worker.postMessage({ type: "stop" });
        await stopped;
      }
      expect(existsSync(socketDirectory)).toBe(false);
    }
  } finally {
    for (const worker of workers) worker.terminate();
    await Promise.all(exits);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
