import { fail } from "./context.js";
export class Semaphore {
  private available: number;
  private readonly waiting: Array<{
    resolve: (release: () => void) => void;
    reject: (reason: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];
  constructor(readonly capacity: number) {
    if (capacity < 1) fail("Concurrency must be positive");
    this.available = capacity;
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.available > 0) {
      this.available--;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const item = {
        resolve,
        reject,
        signal,
        abort: () => {
          const i = this.waiting.indexOf(item);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(signal.reason);
        },
      };
      this.waiting.push(item);
      signal.addEventListener("abort", item.abort, { once: true });
    });
  }
  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        next.signal.removeEventListener("abort", next.abort);
        next.resolve(this.releaseOnce());
      } else this.available++;
    };
  }
  async use<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await work();
    } finally {
      release();
    }
  }
}
export class EnvironmentLocks {
  private readonly locks = new Map<string, Semaphore>();
  async use<T>(ids: string[], signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const releases: Array<() => void> = [];
    try {
      for (const id of [...new Set(ids)].sort()) {
        let lock = this.locks.get(id);
        if (!lock) {
          lock = new Semaphore(1);
          this.locks.set(id, lock);
        }
        releases.push(await lock.acquire(signal));
      }
      return await work();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
}
