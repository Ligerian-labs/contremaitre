import { randomUUID } from "node:crypto";
import { promises as fs, readFileSync, renameSync } from "node:fs";
import type { Context } from "@contremaitre/execution/context";
import { atomicWrite } from "@contremaitre/execution/files";
import { sleep } from "@contremaitre/execution/sleep";

export interface LogTail {
  generation: string;
  start: number;
  text: string;
}
export function readPgliteLog(path: string): LogTail {
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (
      !record ||
      typeof record.generation !== "string" ||
      !Number.isSafeInteger(record.start) ||
      record.start < 0 ||
      typeof record.text !== "string"
    )
      throw new SyntaxError("Invalid PGlite log record");
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { generation: "", start: 0, text: "" };
    if (!(error instanceof SyntaxError)) throw error;
    renameSync(path, `${path}.corrupt`);
    const record = {
      generation: randomUUID(),
      start: 0,
      text: `PGlite log was corrupt; saved to ${path}.corrupt; starting a new log\n`,
    };
    atomicWrite(path, JSON.stringify(record));
    return record;
  }
}
export function appendPgliteLog(path: string, text: string): void {
  const record = readPgliteLog(path);
  atomicWrite(path, addLine(record, text));
}
function addLine(record: LogTail, text: string): string {
  record.generation ||= randomUUID();
  record.text += text.endsWith("\n") ? text : `${text}\n`;
  // Keep complete lines and absolute byte offsets even as the retained tail rotates.
  let encoded = JSON.stringify(record);
  while (Buffer.byteLength(encoded) > 65536) {
    const bytes = Buffer.from(record.text);
    const excess = Buffer.byteLength(encoded) - 65536;
    const newline = bytes.indexOf(10, Math.min(bytes.length - 1, excess - 1));
    const end = newline < 0 ? bytes.length : newline + 1;
    record.start += end;
    record.text = bytes.subarray(end).toString();
    encoded = JSON.stringify(record);
  }
  return encoded;
}
export class PgliteLogWriter {
  private record: LogTail;
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  private error?: unknown;
  constructor(private path: string) {
    this.record = readPgliteLog(path);
    this.record.generation ||= randomUUID();
  }
  cursor(): LogTail {
    return {
      ...this.record,
      start: this.record.start + Buffer.byteLength(this.record.text),
      text: "",
    };
  }
  append(text: string): void {
    addLine(this.record, text);
    this.dirty = true;
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch((error) => {
        this.error = error;
      });
    }, 100);
  }
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.error) throw this.error;
    if (this.dirty) {
      this.dirty = false;
      const encoded = JSON.stringify(this.record);
      this.writing = this.writing.then(async () => {
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, encoded, { mode: 0o600 });
          await fs.rename(temporary, this.path);
        } finally {
          await fs.rm(temporary, { force: true });
        }
      });
    }
    await this.writing;
  }
  async close(): Promise<void> {
    await this.flush();
  }
}

export async function tailPgliteLog(
  ctx: Context,
  path: string,
  follow: boolean,
  from?: LogTail,
): Promise<void> {
  const initial = readPgliteLog(path);
  let generation = from?.generation ?? initial.generation;
  let cursor =
    from?.start ?? (follow ? initial.start + Buffer.byteLength(initial.text) : initial.start);
  do {
    const record = readPgliteLog(path);
    if (record.generation !== generation) {
      generation = record.generation;
      cursor = record.start;
    }
    const bytes = Buffer.from(record.text);
    const offset = Math.max(0, cursor - record.start);
    if (offset < bytes.length) ctx.log(bytes.subarray(offset));
    cursor = record.start + bytes.length;
    if (!follow) return;
    await sleep(100, ctx.signal);
  } while (follow);
}
