import { dlopen, FFIType } from "bun:ffi";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fail, isCode, keys } from "./context.js";
export function atomicWrite(path: string, data: string | Uint8Array, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.write-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", mode);
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {}
  }
}
export function lockHome(home: string): () => void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const library = dlopen(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
    { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
  );
  const fd = openSync(join(home, "daemon.lock"), "a+", 0o600);
  if (library.symbols.flock(fd, 2 | 4) !== 0) {
    closeSync(fd);
    library.close();
    return fail("Hub already running or state is locked", "conflict");
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    library.symbols.flock(fd, 8);
    closeSync(fd);
    library.close();
  };
}
export function privateFile(dir: string, body: string | Uint8Array, prefix = "tmp"): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${prefix}-${randomUUID()}`);
  atomicWrite(file, body);
  chmodSync(file, 0o600);
  return file;
}
export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if (!isCode(e, "ENOENT")) throw e;
  }
}
export function privateEnv(dir: string, values: Record<string, string>): string {
  const rows = keys(values).map((key) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n]/.test(values[key]))
      fail("Invalid environment entry");
    return `${key}=${values[key]}\n`;
  });
  return privateFile(dir, rows.join(""), "env");
}
