import { createServer, type Socket } from "node:net";
import type { PGlite } from "@electric-sql/pglite";
import { bufferPgliteCopy } from "./pglite-copy.js";

// PGlite has one backend. Lease it through ReadyForQuery, retaining ownership
// while a transaction or an extended-protocol exchange is still open.
const MAX_CLIENTS = 100;
const MAX_BYTES = 64 * 1024 * 1024;
const WAIT_MS = 30_000;
interface Client {
  socket: Socket;
  input: Buffer;
  messages: Buffer[];
  bytes: number;
  startup: boolean;
  closed: boolean;
  statements: Map<string, Buffer>;
  timer?: ReturnType<typeof setTimeout>;
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
    const fields = Buffer.from(`SFATAL\0C${code}\0M${message}\0\0`);
    const packet = Buffer.alloc(fields.length + 5);
    packet[0] = 69;
    packet.writeInt32BE(fields.length + 4, 1);
    fields.copy(packet, 5);
    client.socket.end(packet, () => client.socket.destroy());
    void pump();
  };
  const arm = (client: Client) => {
    clearTimer(client);
    client.timer = setTimeout(
      () => fail(client, "PGlite transaction pool wait or lease exceeded 30 seconds"),
      WAIT_MS,
    );
  };
  const reset = async () => {
    events.resetting();
    copy.abort();
    if (db.isInTransaction()) await db.exec("ROLLBACK");
    await db.exec("DISCARD ALL");
    await db.exec("SET SESSION AUTHORIZATION app");
    loaded.clear();
    events.reset();
  };
  const execute = async (message: Buffer) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    await db.execProtocolRawStream(message, {
      onRawData: (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) throw Error("PGlite transaction pool response exceeds 64 MiB");
        chunks.push(chunk.slice());
      },
    });
    return Buffer.concat(chunks);
  };
  const packets = (response: Buffer) => {
    const result: Buffer[] = [];
    for (let at = 0; at < response.length; ) {
      if (at + 5 > response.length) throw Error("Incomplete PGlite response");
      const end = at + 1 + response.readInt32BE(at + 1);
      if (end <= at + 4 || end > response.length) throw Error("Invalid PGlite response");
      result.push(response.subarray(at, end));
      at = end;
    }
    return result;
  };
  async function drain() {
    while (!stopped) {
      if (owner?.closed) {
        await reset();
        owner = undefined;
      }
      if (!owner) {
        const next = [...clients].find((client) => !client.closed && client.messages.length);
        if (!next) return;
        owner = next;
        arm(next);
      }
      const client = owner;
      const message = client.messages.shift();
      if (!message) return;
      client.bytes -= message.length;
      arm(client);
      let replay: Buffer | undefined;
      const statementStart =
        message[0] === 66
          ? message.indexOf(0, 5) + 1
          : message[0] === 68 && message[5] === 83
            ? 6
            : undefined;
      if (statementStart !== undefined) {
        const name = message.toString("utf8", statementStart, message.indexOf(0, statementStart));
        const statement = client.statements.get(name);
        if (statement && !loaded.has(name)) {
          // Restore only the referenced statement. An unrelated cached statement
          // may no longer parse after a migration and must not poison the pool.
          const restored = await execute(statement);
          if (packets(restored).some((packet) => packet[0] === 49)) loaded.add(name);
          else replay = restored;
        }
      }
      if (message[0] === 81) {
        client.statements.delete("");
        loaded.delete("");
      }
      const response = replay ?? (await execute(message));
      const output = packets(response);
      if (message[0] === 80 && output.some((packet) => packet[0] === 49)) {
        const end = message.indexOf(0, 5);
        const name = message.toString("utf8", 5, end);
        const previous = client.statements.get(name)?.length ?? 0;
        const total = [...client.statements.values()].reduce((sum, value) => sum + value.length, 0);
        if (
          total - previous + message.length > MAX_BYTES ||
          (client.statements.size >= 1000 && !client.statements.has(name))
        ) {
          fail(client, "PGlite transaction pool prepared statement limit exceeded", "54000");
        } else {
          client.statements.set(name, message);
          loaded.add(name);
        }
      }
      if (message[0] === 67 && message[5] === 83 && output.some((packet) => packet[0] === 51)) {
        const name = message.toString("utf8", 6, message.indexOf(0, 6));
        client.statements.delete(name);
        loaded.delete(name);
      }
      if (output.some((packet) => packet[0] === 90 && packet[5] === 73)) {
        await reset();
        clearTimer(client);
        owner = undefined;
        // Move the previous owner behind clients already waiting for a turn.
        clients.delete(client);
        if (!client.closed) clients.add(client);
        if (client.messages.length && !client.closed) arm(client);
      }
      if (!client.closed) {
        if (client.socket.writableLength + response.length > MAX_BYTES)
          fail(client, "PGlite transaction pool output buffer exceeds 64 MiB", "54000");
        else client.socket.write(response);
      }
    }
  }
  function pump(): Promise<void> {
    if (!processing) {
      processing = drain()
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
  const server = createServer((socket) => {
    const client: Client = {
      socket,
      input: Buffer.alloc(0),
      messages: [],
      bytes: 0,
      startup: true,
      closed: false,
      statements: new Map(),
    };
    socket.on("error", () => socket.destroy());
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
      if (client.closed) return;
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
        } else if (message[0] === 88) {
          socket.end();
          return;
        }
        client.messages.push(message);
        client.bytes += message.length;
        if (owner !== client && !client.timer) arm(client);
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
      if (db.isInTransaction()) await db.exec("ROLLBACK");
    },
  };
}
