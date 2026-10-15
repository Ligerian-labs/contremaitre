const worker = new Worker("./pglite-worker.ts");
worker.onerror = (event) => {
  console.error(event.message);
  process.exit(7);
};
worker.onmessage = (event) => {
  if (event.data.type === "started") {
    console.log("unexpected worker startup");
    process.exit(0);
  }
};
worker.postMessage({ type: "start", dataDir: process.argv[2], port: 48592, host: "127.0.0.1" });
setTimeout(() => process.exit(8), 10_000);
