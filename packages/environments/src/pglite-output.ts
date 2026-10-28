import { ftruncateSync, readSync, writeSync } from "node:fs";
import { type FileHandle, mkdtemp, open, rm, unlink } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGLITE_MAX_BYTES } from "./pglite-protocol.js";

export interface PgliteOutputLease {
  fd: number;
  release(): Promise<void>;
}

// This allocator lives on the parent. Bun does not close even FileHandle-owned
// descriptors when a Worker terminates. Only the parent closes these handles,
// after a release request or observed worker termination.
export function pgliteOutputFiles() {
  const files = new Map<number, { opening: Promise<FileHandle>; closing?: Promise<void> }>();
  let stopped = false;
  let closing: Promise<void> | undefined;
  const release = (id: number): Promise<void> => {
    const entry = files.get(id);
    if (!entry) return Promise.resolve();
    entry.closing ??= (async () => {
      let file: FileHandle;
      try {
        file = await entry.opening;
      } catch {
        files.delete(id);
        return;
      } // Failed allocation owns no descriptor.
      try {
        await file.close();
      } finally {
        files.delete(id);
      }
    })();
    return entry.closing;
  };
  return {
    async allocate(id: number): Promise<number> {
      if (stopped || files.size >= 100 || files.has(id))
        throw Error("PGlite output storage allows at most 100 active clients");
      const pending = (async () => {
        const directory = await mkdtemp(join(tmpdir(), "cm-pglite-output-"));
        let file: FileHandle | undefined;
        try {
          const path = join(directory, "output");
          file = await open(path, "wx+", 0o600);
          await unlink(path);
          await rm(directory, { recursive: true, force: true });
          return file;
        } catch (error) {
          await file?.close();
          await rm(directory, { recursive: true, force: true });
          throw error;
        }
      })();
      files.set(id, { opening: pending }); // Pending allocations count toward the limit.
      try {
        return (await pending).fd;
      } catch (error) {
        files.delete(id);
        throw error;
      }
    },
    release,
    close(): Promise<void> {
      stopped = true;
      closing ??= Promise.all([...files.keys()].map(release)).then(() => {});
      return closing;
    },
  };
}

// Native output cannot await TCP backpressure. Spill synchronously after the
// first blocked write, then drain bounded chunks outside WASM. The lease's parent
// is the sole closer of its descriptor; this writer never closes or transfers it.
export function pgliteOutput(socket: Socket, lease: PgliteOutputLease, waitMs = 30_000) {
  let length = 0;
  let closed = false;
  let failure: unknown;
  let flushing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let cancelDrain: (() => void) | undefined;
  let paused = false;
  let deadline:
    | { remaining: number; started: number; timer?: ReturnType<typeof setTimeout>; expire(): void }
    | undefined;
  const armDeadline = () => {
    if (!deadline || paused) return;
    deadline.started = performance.now();
    deadline.timer = setTimeout(deadline.expire, Math.max(0, deadline.remaining));
  };
  const drain = () => {
    if (closed || socket.destroyed) return Promise.resolve();
    if (!socket.writableNeedDrain) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(deadline?.timer);
        deadline = undefined;
        socket.off("drain", complete);
        socket.off("close", complete);
        socket.off("error", fail);
        cancelDrain = undefined;
        if (error) reject(error);
        else resolve();
      };
      const complete = () => finish();
      const fail = (error: Error) => finish(error);
      deadline = {
        remaining: waitMs,
        started: performance.now(),
        expire: () => finish(Error("PGlite output made no socket progress for 30 seconds")),
      };
      armDeadline();
      socket.once("drain", complete);
      socket.once("close", complete);
      socket.once("error", fail);
      cancelDrain = complete;
    });
  };
  return {
    pauseDeadline() {
      if (paused) return;
      paused = true;
      if (deadline?.timer) {
        clearTimeout(deadline.timer);
        deadline.remaining -= performance.now() - deadline.started;
        deadline.timer = undefined;
      }
    },
    resumeDeadline() {
      if (!paused) return;
      paused = false;
      armDeadline();
    },
    write(packet: Buffer) {
      if (closed || failure) return;
      try {
        if (
          !length &&
          !socket.writableNeedDrain &&
          socket.writableLength + packet.length <= PGLITE_MAX_BYTES
        ) {
          socket.write(packet);
          return;
        }
        let at = 0;
        while (at < packet.length) {
          const count = writeSync(lease.fd, packet, at, packet.length - at, length);
          if (!count) throw Error("PGlite output storage write made no progress");
          length += count;
          at += count;
        }
      } catch (error) {
        // Recording only: handling this inside onRawData would unwind WASM.
        failure = error;
      }
    },
    get failure() {
      return failure;
    },
    flush(): Promise<void> {
      if (flushing) return flushing;
      flushing = (async () => {
        if (failure) throw failure;
        await drain();
        if (!length || closed || socket.destroyed) return;
        const bytes = Buffer.alloc(64 * 1024);
        let at = 0;
        while (!closed && !socket.destroyed && at < length) {
          const count = readSync(lease.fd, bytes, 0, Math.min(bytes.length, length - at), at);
          if (!count) throw Error("PGlite output storage ended before its response");
          // Own each queued buffer until TCP has consumed it.
          socket.write(Buffer.from(bytes.subarray(0, count)));
          at += count;
          await drain();
        }
        if (!closed && !socket.destroyed) {
          ftruncateSync(lease.fd, 0);
          length = 0;
        }
      })().finally(() => {
        flushing = undefined;
      });
      return flushing;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      cancelDrain?.();
      closing = (async () => {
        await flushing?.catch(() => {});
        // No synchronous callback or asynchronous drain can touch the fd now.
        await lease.release();
      })();
      return closing;
    },
  };
}
