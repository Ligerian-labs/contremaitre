import { sleep } from "@contremaitre/execution/sleep";

export async function waitPgliteReady(
  url: string,
  options: { signal?: AbortSignal; timeout?: number } = {},
): Promise<void> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeout ?? 10_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  while (true) {
    signal.throwIfAborted();
    const sql = new Bun.SQL(url, { max: 1, connectionTimeout: 3, prepare: false });
    let abort: () => void = () => {};
    try {
      await Promise.race([
        sql`SELECT 1`,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
      signal.throwIfAborted();
      return;
    } catch {
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", abort);
      await sql.close({ timeout: 0 });
    }
    await sleep(50, signal);
  }
}
