import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { bufferPgliteCopy } from "./pglite-copy.js";
import { openPglite } from "./pglite-initialize.js";
import { createPglitePool } from "./pglite-pool.js";

declare const self: Worker;
let front: Server | undefined;
let socketDirectory: string | undefined;
const sockets = new Set<Socket>();
let db: PGlite | undefined;
let pool: ReturnType<typeof createPglitePool> | undefined;
let server: PGLiteSocketServer | undefined;
let stopping = false;
let resetting = Promise.resolve();
let closeClient: (() => Promise<void>) | undefined;
const waiters = new Map<Socket, { timer: ReturnType<typeof setTimeout>; deadline: number }>();
self.onmessage = async (event: MessageEvent) => {
  try {
    if (event.data.type === "start") {
      db = await openPglite(event.data.dataDir, (text) => {
        self.postMessage({ type: "log", text });
        return true;
      });
      if (event.data.poolMode === "transaction") {
        pool = createPglitePool(db, {
          resetting: () => self.postMessage({ type: "resetting" }),
          reset: () => self.postMessage({ type: "reset" }),
          fatal: (error) =>
            self.postMessage({ type: "error", message: `PGlite pool failed: ${String(error)}` }),
        });
        front = pool.server;
        await new Promise<void>((resolve, reject) => {
          front?.once("error", reject);
          front?.listen(event.data.port, event.data.host, resolve);
        });
        self.postMessage({ type: "started" });
        return;
      }
      const copy = bufferPgliteCopy(db);
      // mkdtemp creates the parent with mode 0700 before the socket can exist.
      socketDirectory = await mkdtemp(join(tmpdir(), "cm-pglite-socket-"));
      self.postMessage({ type: "resources", socketDirectory });
      const path = join(socketDirectory, "postgres.sock");
      server = new PGLiteSocketServer({ db, path, maxConnections: 1 });
      await server.start();
      await chmod(path, 0o600);
      let occupied = false;
      const startBackend = async () => {
        if (!db) throw new Error("PGlite database is not open");
        server = new PGLiteSocketServer({ db, path, maxConnections: 1 });
        await server.start();
        await chmod(path, 0o600);
      };
      const refuse = (socket: Socket) => {
        const fields = Buffer.from(
          "SFATAL\0C53300\0MPGlite allows one connection; use pool size 1\0\0",
        );
        const packet = Buffer.alloc(5 + fields.length);
        packet[0] = 69;
        packet.writeInt32BE(4 + fields.length, 1);
        fields.copy(packet, 5);
        socket.end(packet);
        socket.setTimeout(1000, () => socket.destroy());
      };
      const admitNext = () => {
        if (stopping || occupied) return;
        for (const [socket, waiter] of waiters) {
          waiters.delete(socket);
          clearTimeout(waiter.timer);
          if (socket.destroyed) continue;
          if (Date.now() >= waiter.deadline) {
            refuse(socket);
            continue;
          }
          admit(socket);
          break;
        }
      };
      const admit = (socket: Socket) => {
        occupied = true;
        const backend = createConnection(path);
        sockets.add(backend);
        socket.on("error", () => {
          void disconnect();
        });
        backend.on("error", () => socket.destroy());
        const closed = new Promise<void>((resolve) => backend.once("close", resolve));
        const disconnect = () => {
          if (!stopping) self.postMessage({ type: "resetting" });
          copy.abort();
          backend.destroy();
          return closed;
        };
        closeClient = disconnect;
        socket.on("close", () => {
          void disconnect();
        });
        backend.on("close", () => {
          sockets.delete(backend);
          socket.destroy();
          closeClient = undefined;
          if (stopping) return;
          self.postMessage({ type: "resetting" });
          // Stop the previous wire handler and drain its rollback before resetting.
          // A fresh wire server also discards its private protocol/query queue.
          resetting = (async () => {
            await server?.stop();
            if (!db) throw new Error("PGlite database is not open");
            if (db.isInTransaction()) await db.exec("ROLLBACK");
            await db.exec("DISCARD ALL");
            // PGlite initially applies its username as a role; DISCARD restores
            // the bootstrap session authorization, so re-establish app explicitly.
            await db.exec("SET SESSION AUTHORIZATION app");
            if (!stopping) await startBackend();
            occupied = false;
            self.postMessage({ type: "reset" });
            admitNext();
          })();
          void resetting.catch((error) => {
            // Never hand an unreset session to another client.
            stopping = true;
            for (const connection of sockets) connection.destroy();
            self.postMessage({
              type: "error",
              message: `PGlite session reset failed: ${String(error)}`,
            });
          });
        });
        socket.pipe(backend, { end: false }).pipe(socket);
      };
      front = createServer((socket) => {
        sockets.add(socket);
        socket.pause();
        socket.on("error", () => socket.destroy());
        socket.on("close", () => {
          sockets.delete(socket);
          const waiter = waiters.get(socket);
          if (waiter) {
            clearTimeout(waiter.timer);
            waiters.delete(socket);
          }
        });
        if (stopping) refuse(socket);
        else if (!occupied) admit(socket);
        else {
          const timer = setTimeout(() => {
            waiters.delete(socket);
            refuse(socket);
          }, 2000);
          waiters.set(socket, { timer, deadline: Date.now() + 2000 });
        }
      });
      await new Promise<void>((resolve, reject) => {
        front?.once("error", reject);
        front?.listen(event.data.port, event.data.host, resolve);
      });
      self.postMessage({ type: "started", socketDirectory });
    } else if (event.data.type === "stop") {
      stopping = true;
      await pool?.stop();
      for (const waiter of waiters.values()) clearTimeout(waiter.timer);
      waiters.clear();
      await closeClient?.();
      for (const socket of sockets) socket.destroy();
      if (front) await new Promise<void>((resolve) => front?.close(() => resolve()));
      await resetting;
      await server?.stop();
      await db?.close();
      if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
      self.postMessage({ type: "stopped" });
    }
  } catch (error) {
    stopping = true;
    await pool?.stop().catch(() => {});
    for (const waiter of waiters.values()) clearTimeout(waiter.timer);
    waiters.clear();
    for (const socket of sockets) socket.destroy();
    front?.close();
    await server?.stop().catch(() => {});
    let closed = true;
    await db?.close().catch(() => {
      closed = false;
    });
    if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
    self.postMessage({
      type: "error",
      closed,
      socketDirectory,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
