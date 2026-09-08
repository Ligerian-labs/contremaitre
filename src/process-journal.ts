import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { type Context, decode, fail } from "./model.js";
import { sleep } from "./process.js";
import { atomicWrite, removeFile } from "./store.js";

const recordSchema = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  token: Schema.String,
  identity: Schema.String,
});
function identity(pid: number): string | undefined {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart=,comm="], {
    encoding: "utf8",
    maxBuffer: 65536,
  });
  if (result.status === 1) return undefined;
  if (result.status !== 0) fail("Cannot inspect interrupted process identity");
  return result.stdout.trim() || undefined;
}
export function trackProcess(directory: string, pid: number, token: string): () => void {
  const path = join(directory, `${token}.json`),
    started = identity(pid);
  if (!started) return () => {};
  atomicWrite(path, JSON.stringify({ version: 1, pid, token, identity: started }));
  return () => removeFile(path);
}
export async function reapProcesses(ctx: Context, directory: string) {
  if (!existsSync(directory)) return;
  for (const file of readdirSync(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
    const r = decode(
      recordSchema,
      JSON.parse(readFileSync(join(directory, file), "utf8")),
      "process journal",
    );
    if (r.pid < 2 || file !== `${r.token}.json`) fail("Invalid process journal");
    if (identity(r.pid) === r.identity) {
      try {
        process.kill(-r.pid, "SIGTERM");
      } catch {}
      await sleep(250, ctx.signal);
      if (identity(r.pid) === r.identity)
        try {
          process.kill(-r.pid, "SIGKILL");
        } catch {}
    }
    removeFile(join(directory, file));
  }
}
