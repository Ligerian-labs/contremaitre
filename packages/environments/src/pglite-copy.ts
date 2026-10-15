import type { PGlite } from "@electric-sql/pglite";

// Recognize SQL keywords only outside quoted strings/identifiers and comments.
function tokens(sql: string): { word: string; depth: number; literal?: boolean }[] {
  const result: { word: string; depth: number; literal?: boolean }[] = [];
  let depth = 0;
  for (let at = 0; at < sql.length; ) {
    if (sql.startsWith("--", at)) {
      const end = sql.indexOf("\n", at);
      at = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", at)) {
      let nesting = 1;
      at += 2;
      while (at < sql.length && nesting) {
        if (sql.startsWith("/*", at)) {
          nesting++;
          at += 2;
        } else if (sql.startsWith("*/", at)) {
          nesting--;
          at += 2;
        } else at++;
      }
      continue;
    }
    const quote = sql[at];
    if (quote === "'" || quote === '"') {
      const escapes = quote === "'" && sql[at - 1]?.toUpperCase() === "E";
      const begin = ++at;
      while (at < sql.length) {
        if (escapes && sql[at] === "\\") {
          at += 2;
          continue;
        }
        if (sql[at++] === quote) {
          if (sql[at] === quote) at++;
          else break;
        }
      }
      result.push({ word: sql.slice(begin, at - 1).toUpperCase(), depth, literal: true });
      continue;
    }
    const dollar = sql.slice(at).match(/^\$(?:[a-z_][a-z_0-9]*)?\$/i)?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, at + dollar.length);
      at = end < 0 ? sql.length : end + dollar.length;
      continue;
    }
    const word = sql.slice(at).match(/^[a-z_][a-z_0-9$]*/i)?.[0];
    if (word) {
      result.push({ word: word.toUpperCase(), depth });
      at += word.length;
      continue;
    }
    if (sql[at] === "(") depth++;
    if (sql[at] === ")") depth--;
    if (sql[at] === ";") result.push({ word: ";", depth });
    at++;
  }
  return result;
}
function copyInput(sql: string): { binary: boolean; single: boolean } | undefined {
  const words = tokens(sql);
  let copying = false;
  let first = true;
  let found = -1;
  for (let at = 0; at < words.length; at++) {
    const token = words[at];
    if (token.depth || token.literal) continue;
    if (token.word === ";") {
      copying = false;
      first = true;
      continue;
    }
    if (first) {
      copying = token.word === "COPY";
      first = false;
    }
    if (
      copying &&
      token.word === "FROM" &&
      words[at + 1]?.word === "STDIN" &&
      !words[at + 1].literal
    ) {
      found = at;
      break;
    }
  }
  if (found < 0) return;
  return {
    binary:
      (words[1]?.word === "BINARY" && !words[1].literal) ||
      words
        .slice(found + 2)
        .some(
          (token, index) =>
            token.word === "BINARY" &&
            (!token.literal || words[found + 1 + index]?.word === "FORMAT"),
        ),
    single:
      words[0]?.word === "COPY" &&
      !words.slice(0, -1).some((token) => token.word === ";" && !token.depth),
  };
}
/** PGlite reads COPY input synchronously: give it the complete wire exchange at once. */
export function bufferPgliteCopy(db: PGlite): { abort(): void } {
  const execute = db.execProtocolRawStream.bind(db);
  let input: Uint8Array[] = [];
  let size = 0;
  let readyAfterSync: Uint8Array | undefined;
  let discardCopy = false;
  let backendNeedsSync = false;
  const abort = () => {
    input = [];
    size = 0;
    readyAfterSync = undefined;
    discardCopy = false;
    backendNeedsSync = false;
  };
  // Let Postgres raise the error: this also marks an explicit transaction failed.
  const reject = async (
    code: string,
    text: string,
    options: Parameters<typeof execute>[1],
    extended = false,
  ) => {
    const sql = Buffer.from(
      `DO $cm$ BEGIN RAISE EXCEPTION USING ERRCODE = '${code}', MESSAGE = '${text}'; END $cm$;\0`,
    );
    const query = Buffer.alloc(sql.length + 5);
    query[0] = 81;
    query.writeInt32BE(sql.length + 4, 1);
    sql.copy(query, 5);
    const chunks: Uint8Array[] = [];
    await execute(query, { ...options, onRawData: (bytes) => chunks.push(bytes.slice()) });
    {
      const response = Buffer.concat(chunks);
      for (let at = 0; at < response.length; ) {
        const end = at + 1 + response.readInt32BE(at + 1);
        if (extended && response[at] === 90) readyAfterSync = response.subarray(at, end).slice();
        else options.onRawData(response.subarray(at, end));
        at = end;
      }
    }
  };
  db.execProtocolRawStream = async (message, options) => {
    if (discardCopy) {
      if (message[0] === 100) return;
      discardCopy = false;
      if (message[0] === 99 || message[0] === 102) return;
    }
    if (readyAfterSync) {
      if (message[0] === 83) {
        const ready = readyAfterSync;
        readyAfterSync = undefined;
        if (backendNeedsSync) {
          backendNeedsSync = false;
          await execute(message, options);
        } else options.onRawData(ready);
      }
      return;
    }
    if (!input.length && (message[0] === 81 || message[0] === 80)) {
      const start = message[0] === 80 ? message.indexOf(0, 5) + 1 : 5;
      const end = message.indexOf(0, start);
      const sql = new TextDecoder().decode(message.subarray(start, end));
      const copy = copyInput(sql);
      if (copy) {
        if (message[0] === 80 || !copy.single) {
          await reject(
            "0A000",
            "PGlite COPY input requires a single simple-query COPY statement",
            options,
            message[0] === 80,
          );
          return;
        }
        input.push(message.slice());
        size = message.length;
        // All columns use the overall format; input bytes are opaque to the relay.
        options.onRawData(new Uint8Array([71, 0, 0, 0, 7, copy.binary ? 1 : 0, 0, 0]));
        return;
      }
    }
    if (!input.length) {
      if (![80, 66, 68].includes(message[0])) return execute(message, options);
      const chunks: Uint8Array[] = [];
      await execute(message, { ...options, onRawData: (bytes) => chunks.push(bytes.slice()) });
      const response = Buffer.concat(chunks);
      const packets: Uint8Array[] = [];
      for (let at = 0; at < response.length; ) {
        const end = at + 1 + response.readInt32BE(at + 1);
        packets.push(response.subarray(at, end));
        at = end;
      }
      const failed = packets.some((packet) => packet[0] === 69);
      for (const packet of packets) {
        // PGlite emits ReadyForQuery early after a failed extended message. PostgreSQL
        // waits for Sync; forward that Sync to clear the backend protocol state.
        if (failed && packet[0] === 90) {
          readyAfterSync = packet.slice();
          backendNeedsSync = true;
        } else options.onRawData(packet);
      }
      return;
    }
    input.push(message.slice());
    size += message.length;
    if (size > 64 * 1024 * 1024) {
      abort();
      discardCopy = message[0] === 100;
      await reject("54000", "PGlite COPY input exceeds 64 MiB", options);
      return;
    }
    if (message[0] === 100) return; // CopyData
    if (message[0] !== 99 && message[0] !== 102) {
      abort();
      throw new Error("Expected CopyData, CopyDone or CopyFail during PGlite COPY input");
    }
    const batch = new Uint8Array(size);
    let offset = 0;
    for (const part of input) {
      batch.set(part, offset);
      offset += part.length;
    }
    abort();
    const output: Uint8Array[] = [];
    await execute(batch, { ...options, onRawData: (bytes) => output.push(bytes.slice()) });
    const response = Buffer.concat(output);
    // The client already received CopyInResponse before it supplied its data.
    for (let at = 0; at < response.length; ) {
      const end = at + 1 + response.readInt32BE(at + 1);
      if (response[at] !== 71) options.onRawData(response.subarray(at, end));
      at = end;
    }
  };
  return { abort };
}
