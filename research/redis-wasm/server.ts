export async function startServer(): Promise<{ port: number; stop(): void }> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url));
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Redis worker startup timed out")), 5000);
      worker.onerror = (event) => {
        clearTimeout(timeout);
        reject(new Error(event.message));
      };
      worker.onmessage = (event: MessageEvent<{ port?: number; error?: string }>) => {
        clearTimeout(timeout);
        if (event.data.port) resolve(event.data.port);
        else reject(new Error(event.data.error ?? "Unexpected Redis worker response"));
      };
      worker.postMessage("start");
    });
    return { port, stop: () => worker.terminate() };
  } catch (error) {
    worker.terminate();
    throw error;
  }
}
