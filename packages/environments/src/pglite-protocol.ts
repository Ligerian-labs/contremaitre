import type { PGlite } from "@electric-sql/pglite";

export const PGLITE_MAX_BYTES = 64 * 1024 * 1024;

export function pgliteMessage(type: string, body = Buffer.alloc(0)): Buffer {
  const message = Buffer.alloc(body.length + 5);
  message[0] = type.charCodeAt(0);
  message.writeInt32BE(body.length + 4, 1);
  body.copy(message, 5);
  return message;
}

// PGlite's callback runs inside WASM. Never throw through it, including for a
// client limit. Retain at most one packet, and report engine framing errors only
// after native execution has unwound normally.
export function pglitePackets(
  packet: (bytes: Buffer) => void,
  oversized?: () => void,
  stream?: (bytes: Uint8Array) => void,
) {
  let header = Buffer.alloc(5);
  let at = 0;
  let frame: Buffer | undefined;
  let end = 5;
  let error: unknown;
  let streaming = false;
  return {
    data(chunk: Uint8Array) {
      if (error) return;
      try {
        for (let offset = 0; offset < chunk.length; ) {
          // Forward complete row packets directly, preserving native chunks and
          // avoiding a second allocation. Split packets use the same state below.
          if (
            !at &&
            stream &&
            chunk.length - offset >= 5 &&
            (chunk[offset] === 68 || chunk[offset] === 100)
          ) {
            const length =
              new DataView(chunk.buffer, chunk.byteOffset + offset + 1, 4).getInt32(0) + 1;
            if (length >= 5 && length <= chunk.length - offset) {
              stream(chunk.subarray(offset, offset + length));
              offset += length;
              continue;
            }
          }
          const count = Math.min(end - at, chunk.length - offset);
          if (at < 5) header.set(chunk.subarray(offset, offset + count), at);
          else if (streaming) stream?.(chunk.subarray(offset, offset + count));
          else frame?.set(chunk.subarray(offset, offset + count), at);
          at += count;
          offset += count;
          if (at !== end) continue;
          if (end === 5 && !frame) {
            end = header.readInt32BE(1) + 1;
            if (end < 5) throw Error("Invalid PGlite response length");
            streaming = Boolean(stream && (header[0] === 68 || header[0] === 100));
            if (streaming) stream?.(header);
            else if (end > PGLITE_MAX_BYTES + 5 && oversized) oversized();
            else {
              if (end > PGLITE_MAX_BYTES + 5) throw Error("PGlite response packet exceeds 64 MiB");
              frame = Buffer.alloc(end);
              header.copy(frame);
            }
            if (end > 5) continue;
          }
          if (frame) packet(frame);
          header = Buffer.alloc(5);
          frame = undefined;
          streaming = false;
          end = 5;
          at = 0;
        }
      } catch (failure) {
        error ??= failure;
      }
    },
    finish() {
      if (error) throw error;
      if (at) throw Error("Incomplete PGlite response");
    },
  };
}

// A Query before Sync can commit an unfinished implicit exchange. Roll it back
// first. If an extended error makes PostgreSQL ignore that Query, exec's finally
// sends Sync, then a second ROLLBACK clears the aborted explicit transaction.
export async function rollbackPglite(db: PGlite) {
  await db.exec("ROLLBACK");
  if (db.isInTransaction()) await db.exec("ROLLBACK");
}

// Use an extended exchange so a synthetic error cannot commit earlier Executes.
// PostgreSQL itself marks explicit transactions failed and skips until Sync.
export async function rejectPglite(
  db: PGlite,
  code: string,
  text: string,
  output: (packet: Buffer) => void,
  extended = true,
) {
  const sql = `DO $cm$ BEGIN RAISE EXCEPTION USING ERRCODE = '${code}', MESSAGE = '${text}'; END $cm$;`;
  for (const message of [
    pgliteMessage("P", Buffer.concat([Buffer.from(`\0${sql}\0`), Buffer.alloc(2)])),
    pgliteMessage("B", Buffer.alloc(8)),
    pgliteMessage("E", Buffer.alloc(5)),
    ...(extended ? [] : [pgliteMessage("S")]),
  ]) {
    const frames = pglitePackets((packet) => {
      if (packet[0] !== 49 && packet[0] !== 50) output(packet);
    });
    await db.execProtocolRawStream(message, { onRawData: frames.data });
    frames.finish();
  }
}
