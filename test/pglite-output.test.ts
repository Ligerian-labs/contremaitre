import { expect, test } from "bun:test";
import { once } from "node:events";
import { closeSync, fstatSync, openSync, type Stats } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { pgliteOutput, pgliteOutputFiles } from "../packages/environments/src/pglite-output.js";
import { startPglite } from "../packages/environments/src/pglite-server.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";
import { freePort } from "./ports.js";

checkPgliteCleanup();
async function until(check: () => boolean, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (!check()) {
    if (performance.now() >= deadline) throw Error("Output condition deadline");
    await Bun.sleep(10);
  }
}
function closed(fd: number, identity: { ino: number; dev: number }) {
  try {
    const current = fstatSync(fd);
    return current.ino !== identity.ino || current.dev !== identity.dev;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EBADF") return true;
    throw error;
  }
}
async function wire(port: number) {
  const socket = createConnection(port, "127.0.0.1");
  socket.on("error", () => {});
  const parameters = Buffer.from("user\0app\0database\0app\0\0");
  const head = Buffer.alloc(8);
  head.writeInt32BE(8 + parameters.length);
  head.writeInt32BE(196608, 4);
  let input = Buffer.alloc(0);
  const ready = new Promise<void>((resolve) => {
    const data = (bytes: Buffer) => {
      input = Buffer.concat([input, bytes]);
      while (input.length >= 5 && input.length >= input.readInt32BE(1) + 1) {
        const end = input.readInt32BE(1) + 1;
        const type = input[0];
        input = input.subarray(end);
        if (type === 90) {
          socket.off("data", data);
          resolve();
          return;
        }
      }
    };
    socket.on("data", data);
  });
  socket.write(Buffer.concat([head, parameters]));
  await ready;
  return socket;
}
function query(socket: Socket, sql: string) {
  const body = Buffer.from(`${sql}\0`);
  const packet = Buffer.alloc(body.length + 5);
  packet[0] = 81;
  packet.writeInt32BE(body.length + 4, 1);
  body.copy(packet, 5);
  socket.write(packet);
}

test("native output spills under real TCP backpressure with bounded pending memory and complete delivery", async () => {
  const files = pgliteOutputFiles();
  const fd = await files.allocate(1);
  const identity = fstatSync(fd);
  expect(identity.mode & 0o777).toBe(0o600);
  expect(identity.nlink).toBe(0);
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw Error("No output listener port");
  const accepted = once(listener, "connection");
  const reader = createConnection(address.port, "127.0.0.1");
  const [sender] = (await accepted) as [Socket];
  reader.pause();
  reader.on("error", () => {});
  sender.on("error", () => {});
  const output = pgliteOutput(sender, { fd, release: () => files.release(1) });
  let received = 0;
  reader.on("data", (bytes) => {
    received += bytes.length;
  });
  try {
    // Distinct buffers run synchronously, like native row packets. No socket
    // I/O turn is possible, and unbounded writes would retain all their bytes.
    for (let n = 0; n < 70; n++) output.write(Buffer.alloc(1048576, 120));
    expect(output.failure).toBeUndefined();
    expect(sender.writableLength).toBeLessThanOrEqual(64 * 1048576);
    expect(fstatSync(fd).size).toBeGreaterThan(64 * 1048576);
    const flushed = output.flush();
    reader.resume();
    await flushed;
    await until(() => received === 70 * 1048576);
    expect(received).toBe(70 * 1048576);
    expect(fstatSync(fd).size).toBe(0);
  } finally {
    await output.close();
    reader.destroy();
    sender.destroy();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await files.close();
  }
  expect(closed(fd, identity)).toBe(true);
});

for (const how of ["disconnect", "stop", "terminate", "stall", "disk-error"] as const) {
  test(`output lease is reclaimed after actual Worker ${how} and other clients stay isolated`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cm-pglite-output-test-"));
    const records: {
      id: number;
      fd: number;
      identity: Stats;
      released: Promise<void>;
      release(): void;
    }[] = [];
    let worker: Worker | undefined;
    let brokenFd: number | undefined;
    if (how === "disk-error") {
      const path = join(root, "read-only");
      await writeFile(path, "");
      brokenFd = openSync(path, "r");
    }
    const server = await startPglite({
      dataDir: join(root, "db"),
      port: await freePort(),
      poolMode: "transaction",
      createWorker(url) {
        worker = new Worker(url);
        const send = worker.postMessage.bind(worker);
        worker.postMessage = (...args) => {
          const message = args[0] as { type: string; id: number; fd?: number; error?: string };
          if (message.type === "output-opened" && message.fd !== undefined) {
            let release = () => {};
            const released = new Promise<void>((resolve) => {
              release = resolve;
            });
            records.push({
              id: message.id,
              fd: message.fd,
              identity: fstatSync(message.fd),
              released,
              release,
            });
            // A real read-only descriptor makes native spilling fail with EBADF.
            // This test owns it until the worker is gone; the parent still owns
            // and closes the actual allocated lease descriptor.
            if (how === "disk-error" && records.length === 1)
              args[0] = { ...message, fd: brokenFd };
          }
          if (message.type === "output-released")
            records.find((record) => record.id === message.id)?.release();
          const transfer = args[1];
          if (Array.isArray(transfer)) send(args[0], transfer);
          else send(args[0], transfer);
        };
        return worker;
      },
    });
    const reader = await wire(server.port);
    const lease = records[0];
    const other = new SQL(server.url(), { max: 1 });
    try {
      expect((await other`SELECT 1::int AS n`)[0].n).toBe(1);
      reader.pause();
      query(reader, "SELECT repeat('x',1048576) FROM generate_series(1,70)");
      if (how !== "disk-error") await until(() => fstatSync(lease.fd).size > 1048576);
      if (how === "disconnect") reader.destroy();
      else if (how === "stop") await server.stop();
      else if (how === "terminate") {
        const actual = worker;
        if (!actual) throw Error("No actual worker");
        const exited = new Promise<void>((resolve) =>
          actual.addEventListener("close", () => resolve(), { once: true }),
        );
        actual.terminate();
        await exited;
        await server.stop();
      }
      if (how === "stop" || how === "terminate") {
        expect(records.every((record) => closed(record.fd, record.identity))).toBe(true);
      } else {
        // Engine ownership is released after safe reset, while the blocked
        // frontend's spool can wait for its reader independently.
        expect((await other`SELECT 49::int AS n`)[0].n).toBe(49);
        if (how === "stall") {
          const began = performance.now();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              lease.released,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(Error("Stalled output did not close")), 40000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          expect(performance.now() - began).toBeGreaterThan(20000);
        } else await lease.released;
        expect(closed(lease.fd, lease.identity)).toBe(true);
        expect((await other`SELECT 50::int AS n`)[0].n).toBe(50);
        expect(server.running).toBe(true);
      }
    } finally {
      reader.destroy();
      await other.close({ timeout: 0 });
      await server.stop();
      if (brokenFd !== undefined) closeSync(brokenFd);
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
}

test("parent allocator bounds pending opens and reclaims allocations racing worker termination", async () => {
  const files = pgliteOutputFiles();
  const pending = Array.from({ length: 100 }, (_, id) => files.allocate(id));
  await expect(files.allocate(101)).rejects.toThrow("at most 100");
  const closing = files.close();
  const fds = await Promise.all(pending);
  await closing;
  for (const fd of fds) expect(() => fstatSync(fd)).toThrow();
  await expect(files.allocate(102)).rejects.toThrow();
});
