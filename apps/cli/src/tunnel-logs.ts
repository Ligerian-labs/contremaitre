import { type FileHandle, open } from "node:fs/promises";
import { type Environment, httpEndpoints } from "@contremaitre/environments/model";
import { tunnelLogPath } from "@contremaitre/environments/tunnel";
import { fail, isCode } from "@contremaitre/execution/context";

interface TunnelLog {
  path: string;
  exists: boolean;
  output: string;
  truncated: boolean;
}

export async function tunnelLogs(home: string, env: Environment, service?: string) {
  const names = [
    ...new Set([...Object.keys(httpEndpoints(env)), ...Object.keys(env.tunnels ?? {})]),
  ].sort();
  if (service && !names.includes(service)) fail(`Unknown HTTP service ${service}`);
  return Object.fromEntries<TunnelLog>(
    await Promise.all(
      (service ? [service] : names).map(async (name) => {
        const path = tunnelLogPath(home, env.Identity.ID, name);
        let file: FileHandle;
        try {
          file = await open(path, "r");
        } catch (error) {
          if (!isCode(error, "ENOENT")) throw error;
          return [name, { path, exists: false, output: "", truncated: false }] as const;
        }
        try {
          const size = (await file.stat()).size;
          const start = Math.max(0, size - 65536);
          const buffer = Buffer.alloc(Math.min(size, 65536));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
          let tail = buffer.subarray(0, bytesRead);
          // A tail may start inside a UTF-8 code point. Skip continuation bytes.
          while (tail.length && (tail[0] & 0xc0) === 0x80) tail = tail.subarray(1);
          return [
            name,
            { path, exists: true, output: tail.toString("utf8"), truncated: start > 0 },
          ] as const;
        } finally {
          await file.close();
        }
      }),
    ),
  );
}
