import { afterAll, afterEach, expect } from "bun:test";

/** Check real close events, rather than treating terminate() as synchronous. */
export function checkPgliteCleanup(): void {
  const NativeWorker = globalThis.Worker;
  const nativeTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const nativeInterval = globalThis.setInterval;
  const nativeClearInterval = globalThis.clearInterval;
  let created = 0;
  let closed = 0;
  const workers = new Map<Worker, string>();
  const timers = new Map<unknown, string>();
  const intervals = new Map<unknown, string>();
  // Tests allocate ephemeral ports; remember every port a worker was told to bind.
  const ports = new Set<number>();
  globalThis.Worker = class extends NativeWorker {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args);
      created++;
      workers.set(this, String(args[0]));
      const post = this.postMessage.bind(this) as (...message: unknown[]) => void;
      this.postMessage = ((...message: unknown[]) => {
        const port = (message[0] as { port?: unknown } | null | undefined)?.port;
        if (typeof port === "number") ports.add(port);
        post(...message);
      }) as Worker["postMessage"];
      this.addEventListener(
        "close",
        () => {
          closed++;
          workers.delete(this);
        },
        { once: true },
      );
    }
  } as typeof Worker;
  globalThis.setTimeout = ((
    callback: Parameters<typeof setTimeout>[0],
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer = nativeTimeout(() => {
      timers.delete(timer);
      callback(...args);
    }, delay);
    timers.set(timer, new Error(`timeout ${delay}ms`).stack ?? "timeout");
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
    timers.delete(timer);
    nativeClearTimeout(timer);
  }) as typeof clearTimeout;
  globalThis.setInterval = ((
    callback: Parameters<typeof setInterval>[0],
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer = nativeInterval(callback, delay, ...args);
    intervals.set(timer, new Error(`interval ${delay}ms`).stack ?? "interval");
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: Parameters<typeof clearInterval>[0]) => {
    intervals.delete(timer);
    nativeClearInterval(timer);
  }) as typeof clearInterval;
  const assertClosed = () => {
    expect([...workers.values()], "PGlite workers must exit before returning from a test").toEqual(
      [],
    );
    expect([...timers.values()], "PGlite parent timers must be cleared").toEqual([]);
    expect([...intervals.values()], "PGlite parent intervals must be cleared").toEqual([]);
  };
  afterEach(assertClosed);
  afterAll(async () => {
    globalThis.Worker = NativeWorker;
    globalThis.setTimeout = nativeTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
    globalThis.setInterval = nativeInterval;
    globalThis.clearInterval = nativeClearInterval;
    assertClosed();
    if (ports.size > 0 && Bun.which("lsof")) {
      const sockets = Bun.spawnSync(
        [
          "lsof",
          "-a",
          "-p",
          String(process.pid),
          `-iTCP:${[...ports].join(",")}`,
          "-sTCP:LISTEN",
          "-P",
          "-n",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(sockets.exitCode, sockets.stderr.toString()).toBe(1);
      expect(sockets.stdout.toString(), "No PGlite test listener may survive its file").toBe("");
    }
    const idle = process.cpuUsage();
    const at = performance.now();
    await Bun.sleep(100);
    const cpu = process.cpuUsage(idle);
    console.log(
      JSON.stringify({
        pglite_cleanup: {
          created,
          closed,
          timers: timers.size,
          intervals: intervals.size,
          idle_ms: Math.round(performance.now() - at),
          idle_cpu_us: cpu.user + cpu.system,
          rss: process.memoryUsage().rss,
        },
      }),
    );
  });
}
