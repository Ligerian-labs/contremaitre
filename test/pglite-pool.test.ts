import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { waitPgliteReady } from "../packages/environments/src/pglite-ready.js";
import { startPglite } from "../packages/environments/src/pglite-server.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";
import { freePort } from "./ports.js";

checkPgliteCleanup();

async function wire(port: number) {
  const socket = createConnection({ port, host: "127.0.0.1", allowHalfOpen: true });
  let input = Buffer.alloc(0);
  const received: Buffer[] = [];
  let wake: (() => void) | undefined;
  socket.on("error", () => {});
  socket.on("data", (data: Buffer) => {
    input = Buffer.concat([input, data]);
    while (input.length >= 5) {
      const length = input.readInt32BE(1) + 1;
      if (input.length < length) break;
      received.push(Buffer.from(input.subarray(0, length)));
      input = input.subarray(length);
    }
    wake?.();
  });
  const next = async (type: string) => {
    const signal = AbortSignal.timeout(5000);
    const seen: Buffer[] = [];
    while (true) {
      signal.throwIfAborted();
      const packet = received.shift();
      if (packet) {
        seen.push(packet);
        if (type.includes(String.fromCharCode(packet[0]))) return seen;
      } else
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          wake = () => {
            signal.removeEventListener("abort", abort);
            wake = undefined;
            resolve();
          };
        });
    }
  };
  const send = (type: string, body = Buffer.alloc(0)) => {
    const packet = Buffer.alloc(body.length + 5);
    packet[0] = type.charCodeAt(0);
    packet.writeInt32BE(body.length + 4, 1);
    body.copy(packet, 5);
    socket.write(packet);
  };
  const startup = Buffer.from("0000000000030000", "hex");
  const body = Buffer.from("user\0app\0database\0app\0\0");
  startup.writeInt32BE(body.length + 8);
  socket.write(Buffer.concat([startup, body]));
  const greeting = await next("ZE");
  if (greeting.at(-1)?.[0] === 69) {
    socket.destroy();
    throw Error(greeting.at(-1)?.toString());
  }
  return {
    socket,
    send,
    next,
    query: async (sql: string) => {
      send("Q", Buffer.from(`${sql}\0`));
      return next("Z");
    },
  };
}

test("retained pools share PGlite and reuse parameterized statements between transactions", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-pool-"));
  const options = {
    dataDir: join(root, "db"),
    port: await freePort(),
    poolMode: "transaction" as const,
  };
  const server = await startPglite(options);
  const a = new SQL(server.url(), { max: 4, connectionTimeout: 5 });
  const b = new SQL(server.url(), { max: 2, connectionTimeout: 5 });
  try {
    await a`CREATE TABLE pooled (id integer PRIMARY KEY)`;
    await a`INSERT INTO pooled VALUES (${1})`;
    expect((await b`SELECT ${42}::int AS value`)[0].value).toBe(42);
    await waitPgliteReady(server.url(), { timeout: 1000 });
    for (let round = 0; round < 3; round++) {
      const values = await Promise.all(
        Array.from({ length: 16 }, async (_, id) => {
          const sql = id % 2 ? a : b;
          const rows = await sql`SELECT ${id + round * 100}::int AS value`;
          return rows[0].value;
        }),
      );
      expect(values).toEqual(Array.from({ length: 16 }, (_, id) => id + round * 100));
    }
    expect(Number((await b`SELECT count(*) AS n FROM pooled`)[0].n)).toBe(1);
  } finally {
    await Promise.all([a.close({ timeout: 0 }), b.close({ timeout: 0 })]);
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("Terminate releases capacity even if the client leaves its write side open", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-pool-limit-"));
  const server = await startPglite({
    dataDir: join(root, "db"),
    port: await freePort(),
    poolMode: "transaction",
  });
  const sockets: Socket[] = [];
  const first = await wire(server.port);
  sockets.push(first.socket);
  try {
    for (let i = 0; i < 99; i++) {
      const socket = createConnection(server.port, "127.0.0.1");
      sockets.push(socket);
      socket.on("error", () => {});
      await once(socket, "connect");
    }
    const end = once(first.socket, "end");
    first.send("X");
    await end;
    // A half-open peer has sent no FIN. Its Terminate still must free the slot.
    const admitted = await wire(server.port);
    sockets.push(admitted.socket);
    expect((await admitted.query("SELECT 42")).some((packet) => packet[0] === 68)).toBe(true);
  } finally {
    for (const socket of sockets) socket.destroy();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("transactions own the backend through errors, rollback and disconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-pool-tx-"));
  const server = await startPglite({
    dataDir: join(root, "db"),
    port: await freePort(),
    poolMode: "transaction",
  });
  const a = await wire(server.port);
  const b = new SQL(server.url(), { max: 1 });
  try {
    const originalPath = (await b.unsafe("SHOW search_path"))[0].search_path;
    await b`CREATE TABLE tx (id int)`;
    await a.query("BEGIN; INSERT INTO tx VALUES (1); SET LOCAL search_path TO pg_catalog");
    let finished = false;
    const waiting = b`SELECT count(*)::int AS n FROM tx`.then((rows) => {
      finished = true;
      return rows;
    });
    await Bun.sleep(50);
    expect(finished).toBe(false);
    const error = await a.query("SELECT 1/0");
    expect(error.find((packet) => packet[0] === 69)?.toString()).toContain("22012");
    expect(error.at(-1)?.[5]).toBe(69);
    await Bun.sleep(20);
    expect(finished).toBe(false);
    await a.query("ROLLBACK");
    expect((await waiting)[0].n).toBe(0);
    await a.query("BEGIN; INSERT INTO tx VALUES (2)");
    a.socket.destroy();
    expect((await b`SELECT count(*)::int AS n FROM tx`)[0].n).toBe(0);
    expect((await b.unsafe("SHOW search_path"))[0].search_path).toBe(originalPath);
    expect(server.running).toBe(true);
  } finally {
    a.socket.destroy();
    await b.close({ timeout: 0 });
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("pool resets session state, retains COPY ownership, and rolls back partial COPY", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-pool-copy-"));
  const server = await startPglite({
    dataDir: join(root, "db"),
    port: await freePort(),
    poolMode: "transaction",
  });
  const a = await wire(server.port);
  const b = new SQL(server.url(), { max: 1 });
  try {
    await a.query(
      "SET application_name='leak'; CREATE TEMP TABLE leak(i int); LISTEN leak; SELECT pg_advisory_lock(123)",
    );
    expect(
      (
        await b`SELECT current_setting('application_name') AS name, to_regclass('pg_temp.leak')::text AS temp`
      )[0],
    ).toEqual({ name: "", temp: null });
    expect((await b`SELECT pg_listening_channels()`).length).toBe(0);
    expect((await b`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory'`)[0].n).toBe(
      0,
    );
    await b`CREATE TABLE copied (id int)`;
    a.send("Q", Buffer.from("COPY copied FROM STDIN\0"));
    await a.next("G");
    a.send("d", Buffer.from("7\n8\n"));
    let finished = false;
    const waiting = b`SELECT count(*)::int AS n FROM copied`.then((rows) => {
      finished = true;
      return rows;
    });
    await Bun.sleep(30);
    expect(finished).toBe(false);
    a.send("c");
    await a.next("Z");
    expect((await waiting)[0].n).toBe(2);
    a.send("Q", Buffer.from("COPY copied FROM STDIN\0"));
    await a.next("G");
    a.send("d", Buffer.from("9\n"));
    a.socket.destroy();
    expect((await b`SELECT count(*)::int AS n FROM copied`)[0].n).toBe(2);
  } finally {
    a.socket.destroy();
    await b.close({ timeout: 0 });
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("prepared names are private and a stale cached query does not poison other queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-pool-parse-"));
  const server = await startPglite({
    dataDir: join(root, "db"),
    port: await freePort(),
    poolMode: "transaction",
  });
  const a = await wire(server.port);
  const b = await wire(server.port);
  const parse = async (client: typeof a, sql: string) => {
    client.send("P", Buffer.from(`same\0${sql}\0\0\0`));
    client.send("H");
    await client.next("1");
    client.send("S");
    await client.next("Z");
  };
  const bind = async (client: typeof a) => {
    client.send("B", Buffer.concat([Buffer.from("\0same\0"), Buffer.alloc(6)]));
    client.send("E", Buffer.alloc(5));
    client.send("S");
    return client.next("Z");
  };
  try {
    await a.query("CREATE TABLE prepared (id int); INSERT INTO prepared VALUES (17)");
    await parse(a, "SELECT id FROM prepared");
    await parse(b, "SELECT 23 AS id");
    for (let round = 0; round < 2; round++) {
      for (const [client, value] of [
        [a, "17"],
        [b, "23"],
      ] as const) {
        const response = await bind(client);
        expect(response.find((packet) => packet[0] === 68)?.toString()).toContain(value);
        expect(response.some((packet) => packet[0] === 69)).toBe(false);
      }
    }
    await b.query("DROP TABLE prepared");
    expect((await a.query("SELECT 1")).some((packet) => packet[0] === 69)).toBe(false);
    expect((await bind(a)).find((packet) => packet[0] === 69)?.toString()).toContain("42P01");
    expect((await b.query("SELECT 2")).some((packet) => packet[0] === 69)).toBe(false);
    // PostgreSQL destroys the previous unnamed statement as soon as a new Parse
    // arrives, including when the replacement fails to parse.
    a.send("P", Buffer.concat([Buffer.from("\0SELECT 19\0"), Buffer.alloc(2)]));
    a.send("S");
    await a.next("Z");
    a.send("P", Buffer.concat([Buffer.from("\0SELECT FROM\0"), Buffer.alloc(2)]));
    a.send("S");
    expect((await a.next("Z")).find((packet) => packet[0] === 69)?.toString()).toContain("42601");
    a.send("B", Buffer.alloc(8));
    a.send("E", Buffer.alloc(5));
    a.send("S");
    expect((await a.next("Z")).find((packet) => packet[0] === 69)?.toString()).toContain("26000");
    expect(server.running).toBe(true);
  } finally {
    a.socket.destroy();
    b.socket.destroy();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
