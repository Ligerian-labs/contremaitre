import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Context } from "@contremaitre/execution/context";
import { lockPgliteData, recoverPglitePublication } from "./pglite-data.js";
import { terminatePgliteWorker } from "./pglite-worker-lifecycle.js";

export interface PgliteHandle {
  host: string;
  port: number;
  readonly running: boolean;
  url(password?: string): string;
  stop(): Promise<void>;
}
export async function startPglite(options: {
  dataDir: string;
  port: number;
  host?: string;
  poolMode?: "session" | "transaction";
  signal?: AbortSignal;
  ctx?: Context;
  log?: (text: string) => void;
  createWorker?: (url: URL) => Worker;
}): Promise<PgliteHandle> {
  const host = options.host ?? "127.0.0.1";
  const dataDir = resolve(options.dataDir);
  if (host !== "127.0.0.1") throw new Error("PGlite requires loopback address 127.0.0.1");
  if (options.poolMode !== undefined && !["session", "transaction"].includes(options.poolMode))
    throw new Error("Invalid PGlite pool mode");
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
    throw new Error("Invalid PGlite port");
  const signal = options.signal ?? options.ctx?.signal;
  signal?.throwIfAborted();
  const unlock = await lockPgliteData(dataDir);
  let worker: Worker;
  try {
    await recoverPglitePublication(dataDir);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    // Bun flattens the main entry but preserves the extra worker entry's path.
    worker = (options.createWorker ?? ((url: URL) => new Worker(url)))(
      new URL(
        import.meta.url.includes("/$bunfs/")
          ? "./packages/environments/src/pglite-worker.ts"
          : "./pglite-worker.ts",
        import.meta.url,
      ),
    );
  } catch (error) {
    await unlock();
    throw error;
  }
  let running = false;
  let failed = false;
  let socketDirectory: string | undefined;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<void>((resolve) => {
    worker.addEventListener(
      "close",
      () => {
        running = false;
        resolve();
      },
      { once: true },
    );
  });
  const log = (text: string) => options.log?.(`${text.replace(/\n$/, "")}\n`);
  const fatal = (message: string) => {
    failed = true;
    running = false;
    log(message);
    void terminate().catch((error) => log(String(error)));
  };
  worker.addEventListener("message", (event: MessageEvent) => {
    if (event.data.socketDirectory) socketDirectory = event.data.socketDirectory;
    if (event.data.type === "log") log(event.data.text);
    if (event.data.type === "error") fatal(event.data.message);
    if (event.data.type === "resetting") {
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => fatal("PGlite session reset timed out"), 2500);
    }
    if (event.data.type === "reset") clearTimeout(resetTimer);
  });
  worker.addEventListener("error", (event: ErrorEvent) => {
    fatal(`PGlite worker failed: ${event.message}`);
  });
  function request(type: "start" | "stop"): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`PGlite ${type} timed out`)), 30_000);
      const onError = (event: ErrorEvent) => finish(new Error(event.message));
      const onClose = () => finish(new Error(`PGlite worker exited during ${type}`));
      const onMessage = (event: MessageEvent) => {
        if (event.data.type === "error") {
          finish(new Error(event.data.message));
        } else if (event.data.type === (type === "start" ? "started" : "stopped")) finish();
      };
      function finish(error?: Error) {
        clearTimeout(timer);
        worker.removeEventListener("error", onError);
        worker.removeEventListener("close", onClose);
        worker.removeEventListener("message", onMessage);
        error ? reject(error) : resolve();
      }
      worker.addEventListener("error", onError);
      worker.addEventListener("close", onClose);
      worker.addEventListener("message", onMessage);
      worker.postMessage({ type, dataDir, port: options.port, host, poolMode: options.poolMode });
    });
  }
  let termination: Promise<void> | undefined;
  function terminate(): Promise<void> {
    termination ??= (async () => {
      clearTimeout(resetTimer);
      await terminatePgliteWorker(worker, exited, async () => {
        try {
          if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
        } finally {
          await unlock();
        }
      });
    })();
    return termination;
  }
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      signal?.removeEventListener("abort", onAbort);
      try {
        if (!failed) await request("stop");
        log("PGlite stopped; data retained");
      } catch (error) {
        if (!failed) throw error;
      } finally {
        running = false;
        await terminate();
      }
    })();
    return stopping;
  };
  const onAbort = () => {
    void stop().catch((error) => options.ctx?.log(String(error)));
  };
  try {
    await request("start");
    running = true;
    log(`PGlite listening on ${host}:${options.port}`);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      await stop();
      signal.throwIfAborted();
    }
  } catch (error) {
    if (!stopping) {
      await terminate();
    }
    throw error;
  }
  return {
    host,
    port: options.port,
    get running() {
      return running;
    },
    url: (password = "") =>
      `postgresql://app:${encodeURIComponent(password)}@${host}:${options.port}/app?sslmode=disable`,
    stop,
  };
}
