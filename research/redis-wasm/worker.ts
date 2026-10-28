import { createServer } from "node:net";
import { WadisServer } from "wadis";

// Experimental bridge. Redis owns parsing and per-client state; the host only
// transports bytes. The entire engine and listener stay off the hub's thread.
self.onmessage = async () => {
  try {
    const engine = await WadisServer.new({ maxmemory: "64mb", loglevel: "warning" });
    const server = createServer((socket) => {
      const connection = engine.createConnection();
      let closed = false;
      let writable = true;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        connection.close();
      };
      const drain = () => {
        if (closed || !writable) return;
        try {
          let bytes = connection.read();
          while (bytes) {
            writable = socket.write(bytes);
            if (!writable) break;
            bytes = connection.read();
          }
          if (connection.wantsClose()) {
            close();
            socket.end();
          }
        } catch (error) {
          socket.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const unsubscribe = connection.onOutput(drain);
      socket.on("data", (bytes) => {
        try {
          connection.write(typeof bytes === "string" ? Buffer.from(bytes) : bytes);
          drain();
        } catch (error) {
          socket.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("drain", () => {
        writable = true;
        drain();
      });
      socket.on("error", () => {});
      socket.on("close", close);
    });
    server.on("error", (error) => self.postMessage({ error: error.message }));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing TCP address");
      self.postMessage({ port: address.port });
    });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.stack : String(error) });
  }
};
