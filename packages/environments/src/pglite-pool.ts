import { createServer, type Socket } from "node:net";
import type { PGlite } from "@electric-sql/pglite";
import { bufferPgliteCopy, pgliteTokens } from "./pglite-copy.js";
import {
  PGLITE_MAX_BYTES,
  pgliteMessage,
  pglitePackets,
  rejectPglite,
  rollbackPglite,
} from "./pglite-protocol.js";

// PGlite has one backend. Lease it through ReadyForQuery, retaining ownership
// while a transaction or an extended-protocol exchange is still open.
const MAX_CLIENTS = 100;
const MAX_BYTES = PGLITE_MAX_BYTES;
const WAIT_MS = 30_000;
interface Client {
  socket: Socket;
  input: Buffer;
  messages: Buffer[];
  bytes: number;
  startup: boolean;
  closed: boolean;
  ending: boolean;
  statements: Map<string, { parse: Buffer; signature: string; bytes: number }>;
  timer?: ReturnType<typeof setTimeout>;
}

// Ignore source table OIDs and attribute positions. PostgreSQL's fixed row
// contract covers names, types, lengths, modifiers and formats.
function signature(packet: Buffer): string {
  if (packet[0] === 110) return "NoData";
  const fields: string[] = [];
  for (let at = 7; at < packet.length; ) {
    const end = packet.indexOf(0, at);
    fields.push(`${packet.toString("hex", at, end)}:${packet.toString("hex", end + 7, end + 19)}`);
    at = end + 19;
  }
  return fields.join("|");
}
function individualDeallocate(message: Buffer): boolean {
  if (message[0] !== 81 && message[0] !== 80) return false;
  const start = message[0] === 81 ? 5 : message.indexOf(0, 5) + 1;
  const words = pgliteTokens(message.toString("utf8", start, message.indexOf(0, start)));
  let first = true;
  for (let at = 0; at < words.length; at++) {
    const token = words[at];
    if (token.depth) continue;
    if (token.word === ";" && !token.literal) {
      first = true;
      continue;
    }
    if (first && !token.literal && token.word === "DEALLOCATE") {
      const target =
        words[at + 1]?.word === "PREPARE" && !words[at + 1].literal ? words[at + 2] : words[at + 1];
      if (!target || target.literal || target.word !== "ALL") return true;
    }
    first = false;
  }
  return false;
}

export function createPglitePool(
  db: PGlite,
  events: { resetting(): void; reset(): void; fatal(error: unknown): void },
) {
  const copy = bufferPgliteCopy(db);
  const clients = new Set<Client>();
  let owner: Client | undefined;
  let processing: Promise<void> | undefined;
  let stopped = false;
  const loaded = new Set<string>();
  const clearTimer = (client: Client) => {
    clearTimeout(client.timer);
    client.timer = undefined;
  };
  const fail = (client: Client, message: string, code = "53300") => {
    if (client.closed) return;
    client.closed = true;
    clearTimer(client);
    clients.delete(client);
    client.input = Buffer.alloc(0);
    client.messages = [];
    client.bytes = 0;
    client.statements.clear();
    const fields = Buffer.from(`SFATAL\0C${code}\0M${message}\0\0`);
    const packet = Buffer.alloc(fields.length + 5);
    packet[0] = 69;
    packet.writeInt32BE(fields.length + 4, 1);
    fields.copy(packet, 5);
    // A stalled reader cannot be allowed to retain a full output budget while
    // waiting for the fatal packet to flush. Disconnect it immediately.
    if (client.socket.writableLength) client.socket.destroy();
    else client.socket.end(packet, () => client.socket.destroy());
    void pump();
  };
  const arm = (client: Client) => {
    clearTimer(client);
    client.timer = setTimeout(
      () => fail(client, "PGlite transaction pool wait or lease exceeded 30 seconds"),
      WAIT_MS,
    );
  };
  const reset = async (abandoned = false) => {
    events.resetting();
    copy.abort();
    if (abandoned) await rollbackPglite(db);
    await db.exec("DISCARD ALL");
    await db.exec("SET SESSION AUTHORIZATION app");
    loaded.clear();
    events.reset();
  };
  const execute = async (message: Buffer, output: (packet: Buffer) => void, limit?: () => void) => {
    const frames = pglitePackets(output, limit);
    await db.execProtocolRawStream(message, { onRawData: frames.data });
    frames.finish();
  };
  const describe = async (name: string) => {
    const packets: Buffer[] = [];
    await execute(pgliteMessage("D", Buffer.from(`S${name}\0`)), (packet) => packets.push(packet));
    return packets;
  };
  async function drain() {
    while (!stopped) {
      if (owner?.closed) {
        await reset(true);
        owner = undefined;
      }
      if (!owner) {
        const next = [...clients].find((client) => !client.closed && client.messages.length);
        if (!next) return;
        owner = next;
      }
      const client = owner;
      const message = client.messages.shift();
      if (!message) return;
      client.bytes -= message.length;
      // The lease timer measures idle frontend time, never native execution.
      clearTimer(client);
      if (message[0] === 88) {
        client.closed = true;
        clients.delete(client);
        client.socket.end(() => client.socket.destroy());
        continue;
      }
      let ready: Buffer | undefined;
      let parsed = false;
      let failed = false;
      let closedStatement = false;
      const output = (packet: Buffer) => {
        if (packet[0] === 90 && packet[5] === 73) {
          ready = packet;
          return;
        }
        if (packet[0] === 49) parsed = true;
        if (packet[0] === 69) failed = true;
        if (packet[0] === 51) closedStatement = true;
        if (packet[0] === 67) {
          const tag = packet.toString("utf8", 5, packet.length - 1);
          if (tag === "DEALLOCATE ALL" || tag === "DISCARD ALL") {
            client.statements.clear();
            loaded.clear();
          }
        }
        if (!client.closed) {
          if (client.socket.writableLength + packet.length > MAX_BYTES)
            fail(client, "PGlite transaction pool output buffer exceeds 64 MiB", "54000");
          else client.socket.write(packet);
        }
      };
      const reject = async (code: string, text: string, extended = true) => {
        loaded.delete(""); // The private error exchange uses the unnamed statement.
        await rejectPglite(db, code, text, output, extended);
      };
      let replayFailed = false;
      const skipping = copy.waitingForSync;
      const statementStart =
        message[0] === 66
          ? message.indexOf(0, 5) + 1
          : message[0] === 68 && message[5] === 83
            ? 6
            : undefined;
      if (!skipping && statementStart !== undefined) {
        const name = message.toString("utf8", statementStart, message.indexOf(0, statementStart));
        const statement = client.statements.get(name);
        if (statement && !loaded.has(name)) {
          // Restore only the referenced statement, with its original inferred OIDs.
          let restored = false;
          await execute(statement.parse, (packet) => {
            if (packet[0] === 49) restored = true;
            else output(packet);
          });
          if (restored) {
            const description = await describe(name);
            const result = description.find((packet) => packet[0] === 84 || packet[0] === 110);
            if (result && signature(result) !== statement.signature) {
              await reject("0A000", "cached plan must not change result type");
              replayFailed = true;
            } else if (result) loaded.add(name);
            else {
              for (const packet of description)
                if (packet[0] === 69 || packet[0] === 90) output(packet);
              replayFailed = true;
            }
          } else replayFailed = true;
        }
      }
      if (!skipping && message[0] === 81) {
        client.statements.delete("");
        loaded.delete("");
      }
      if (!replayFailed) {
        if (!skipping && individualDeallocate(message))
          await reject(
            "0A000",
            "PGlite transaction pooling supports only DEALLOCATE ALL",
            message[0] !== 81,
          );
        else
          await execute(message, output, () =>
            fail(client, "PGlite transaction pool response packet exceeds 64 MiB", "54000"),
          );
      }
      if (message[0] === 80 && message[5] === 0 && (parsed || failed)) {
        client.statements.delete("");
        loaded.delete("");
      }
      if (message[0] === 80 && parsed && !client.closed) {
        const end = message.indexOf(0, 5);
        const name = message.toString("utf8", 5, end);
        const description = await describe(name);
        const parameters = description.find((packet) => packet[0] === 116);
        const result = description.find((packet) => packet[0] === 84 || packet[0] === 110);
        if (parameters && result) {
          const queryEnd = message.indexOf(0, end + 1);
          const frozen = pgliteMessage(
            "P",
            Buffer.concat([message.subarray(5, queryEnd + 1), parameters.subarray(5)]),
          );
          const shape = signature(result);
          const bytes = frozen.length + Buffer.byteLength(shape);
          const previous = client.statements.get(name)?.bytes ?? 0;
          const total = [...client.statements.values()].reduce(
            (sum, value) => sum + value.bytes,
            0,
          );
          if (
            total - previous + bytes > MAX_BYTES ||
            (client.statements.size >= 1000 && !client.statements.has(name))
          )
            fail(client, "PGlite transaction pool prepared statement limit exceeded", "54000");
          else {
            client.statements.set(name, { parse: frozen, signature: shape, bytes });
            loaded.add(name);
          }
        } else
          for (const packet of description)
            if (packet[0] === 69 || packet[0] === 90) output(packet);
      }
      if (message[0] === 67 && message[5] === 83 && closedStatement) {
        const name = message.toString("utf8", 6, message.indexOf(0, 6));
        client.statements.delete(name);
        loaded.delete(name);
      }
      if (ready) {
        await reset();
        owner = undefined;
        clients.delete(client);
        if (!client.closed) {
          clients.add(client);
          client.socket.write(ready);
          if (client.messages.length) arm(client);
        }
      } else if (!client.closed && !client.messages.length) arm(client);
    }
  }
  function pump(): Promise<void> {
    if (!processing) {
      processing = Promise.resolve()
        .then(drain)
        .catch((error) => {
          stopped = true;
          for (const client of clients) {
            clearTimer(client);
            client.socket.destroy();
          }
          events.fatal(error);
        })
        .finally(() => {
          processing = undefined;
        });
    }
    return processing;
  }
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const client: Client = {
      socket,
      input: Buffer.alloc(0),
      messages: [],
      bytes: 0,
      startup: true,
      closed: false,
      ending: false,
      statements: new Map(),
    };
    socket.on("error", () => socket.destroy());
    socket.on("end", () => {
      // Keep queued work preceding Terminate alive through an immediate FIN.
      if (!client.ending) socket.destroy();
    });
    socket.on("close", () => {
      client.closed = true;
      clearTimer(client);
      clients.delete(client);
      void pump();
    });
    if (stopped || clients.size >= MAX_CLIENTS) {
      fail(client, "PGlite transaction pool allows at most 100 connections");
      return;
    }
    clients.add(client);
    arm(client);
    socket.setNoDelay(true);
    socket.on("data", (data: Buffer) => {
      if (client.closed || client.ending) return;
      if (client.input.length + client.bytes + data.length > MAX_BYTES + 5) {
        fail(client, "PGlite transaction pool input buffer exceeds 64 MiB", "54000");
        return;
      }
      client.input = Buffer.concat([client.input, data]);
      while (client.input.length >= (client.startup ? 8 : 5)) {
        const length = client.startup
          ? client.input.readInt32BE(0)
          : 1 + client.input.readInt32BE(1);
        if (length < (client.startup ? 8 : 5) || length > MAX_BYTES + 5) {
          fail(client, "Invalid PGlite transaction pool packet length", "08P01");
          return;
        }
        if (client.input.length < length) break;
        const message = Buffer.from(client.input.subarray(0, length));
        client.input = client.input.subarray(length);
        if (client.startup) {
          const code = message.readInt32BE(4);
          if (length === 8 && (code === 80877103 || code === 80877104)) {
            socket.write("N");
            continue;
          }
          if (length === 16 && code === 80877102) {
            socket.destroy();
            return;
          }
          if (code !== 196608) {
            fail(client, "PGlite requires protocol version 3.0", "08P01");
            return;
          }
          client.startup = false;
        } else if (message[0] === 88) client.ending = true;
        client.messages.push(message);
        client.bytes += message.length;
        if (owner !== client && !client.timer) arm(client);
        if (client.ending) break;
      }
      void pump();
    });
  });
  return {
    server,
    async stop() {
      stopped = true;
      for (const client of clients) {
        clearTimer(client);
        client.socket.destroy();
      }
      await processing;
      copy.abort();
      await rollbackPglite(db);
    },
  };
}
