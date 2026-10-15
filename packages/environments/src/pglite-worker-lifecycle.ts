/** Release ownership only after the kernel can no longer see the worker's open database. */
export async function terminatePgliteWorker(
  worker: Pick<Worker, "terminate">,
  exited: Promise<void>,
  unlock: () => Promise<void>,
): Promise<void> {
  // Retain the callback even when termination exceeds the grace period.
  const released = exited.then(unlock);
  let timer: ReturnType<typeof setTimeout> | undefined;
  worker.terminate();
  try {
    await Promise.race([
      released,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("PGlite worker termination timed out")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
