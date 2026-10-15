import "../../../packages/environments/src/pglite-worker.js";

self.addEventListener("message", (event: MessageEvent) => {
  if (event.data.type === "inject-reset-failure") {
    self.postMessage({ type: "error", message: "injected session reset failure" });
  }
  if (event.data.type === "inject-reset-timeout") self.postMessage({ type: "resetting" });
});

const send = self.postMessage.bind(self);
self.postMessage = (message: unknown) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "stopped"
  ) {
    setTimeout(() => send(message), 2800);
  } else send(message);
};
