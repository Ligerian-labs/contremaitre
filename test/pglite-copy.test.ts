import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { startPglite } from "../packages/environments/src/pglite-server.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";
import { freePort } from "./ports.js";

checkPgliteCleanup();

async function wire(port: number) {
  const socket = createConnection(port, "127.0.0.1");
  let pending = Buffer.alloc(0);
  const listeners = new Map<string, (packet: Buffer) => void>();
  socket.on("error", () => {});
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const size = pending.readInt32BE(1) + 1;
      if (pending.length < size) return;
      const type = String.fromCharCode(pending[0]);
      const packet = pending.subarray(0, size);
      pending = pending.subarray(size);
      listeners.get(type)?.(packet);
      listeners.delete(type);
    }
  });
  const next = (type: string) =>
    new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(type);
        reject(new Error(`waiting for ${type}`));
      }, 5000);
      listeners.set(type, (packet) => {
        clearTimeout(timer);
        resolve(packet);
      });
    });
  const send = (type: string, text: string | Buffer) => {
    const body = typeof text === "string" ? Buffer.from(text) : text;
    const packet = Buffer.alloc(5 + body.length);
    packet[0] = type.charCodeAt(0);
    packet.writeInt32BE(body.length + 4, 1);
    body.copy(packet, 5);
    socket.write(packet);
  };
  const ready = next("Z");
  const parameters = Buffer.from("user\0app\0database\0app\0\0");
  const startup = Buffer.alloc(parameters.length + 8);
  startup.writeInt32BE(startup.length, 0);
  startup.writeInt32BE(196608, 4);
  parameters.copy(startup, 8);
  socket.write(startup);
  await ready;
  return { socket, next, send };
}

test("V2-F1/V3-F3/F4: COPY disconnect recovery, SQL size error and statement detection", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-copy-"));
  const server = await startPglite({ dataDir: join(root, "db"), port: await freePort() });
  const query = async (text: string) => {
    const sql = new SQL(server.url(), { max: 1, prepare: false, connectionTimeout: 5 });
    try {
      return await sql.unsafe(text);
    } finally {
      await sql.close();
    }
  };
  try {
    await query("CREATE TABLE copied (id int)");
    for (const data of [false, true]) {
      const client = await wire(server.port);
      const copy = client.next("G");
      client.send("Q", "COPY copied FROM STDIN\0");
      await copy;
      if (data) {
        client.send("d", "1\n2\n");
        await Bun.sleep(20);
      }
      client.socket.destroy();
      expect((await query("SELECT count(*)::int AS n FROM copied"))[0].n).toBe(0);
      expect(server.running).toBe(true);
    }
    // A completed COPY still commits; this is not a blanket COPY rejection.
    const complete = await wire(server.port);
    const accepted = complete.next("G");
    complete.send("Q", "/* import */ COPY copied FROM STDIN\0");
    await accepted;
    complete.send("d", "7\n8\n");
    const done = complete.next("Z");
    complete.send("c", "");
    await done;
    complete.socket.destroy();
    expect((await query("SELECT count(*)::int AS n FROM copied"))[0].n).toBe(2);
    if (Bun.which("psql")) {
      const psql = Bun.spawn(
        ["psql", server.url(), "-X", "-v", "ON_ERROR_STOP=1", "-c", "\\copy copied FROM STDIN"],
        { stdin: Buffer.from("9\n10\n"), stdout: "pipe", stderr: "pipe" },
      );
      const [code, output, error] = await Promise.all([
        psql.exited,
        new Response(psql.stdout).text(),
        new Response(psql.stderr).text(),
      ]);
      expect(code, error).toBe(0);
      expect(output).toContain("COPY 2");
    }
    const binary = await wire(server.port);
    const binaryAccepted = binary.next("G");
    binary.send("Q", "COPY copied FROM STDIN WITH (FORMAT binary)\0");
    await binaryAccepted;
    const row = Buffer.alloc(10);
    row.writeInt16BE(1, 0);
    row.writeInt32BE(4, 2);
    row.writeInt32BE(11, 6);
    binary.send(
      "d",
      Buffer.concat([
        Buffer.from([80, 71, 67, 79, 80, 89, 10, 255, 13, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        row,
        Buffer.from([255, 255]),
      ]),
    );
    const binaryDone = binary.next("Z");
    binary.send("c", "");
    await binaryDone;
    binary.socket.destroy();
    expect((await query("SELECT id FROM copied WHERE id=11"))[0].id).toBe(11);
    await query('CREATE TABLE "binary" (id int)');
    const text = await wire(server.port);
    const textAccepted = text.next("G");
    text.send("Q", `COPY "binary" FROM STDIN WITH (NULL 'binary')\0`);
    expect((await textAccepted)[5]).toBe(0);
    text.send("d", "12\n");
    const textDone = text.next("Z");
    text.send("c", "");
    await textDone;
    text.socket.destroy();
    expect((await query('SELECT id FROM "binary"'))[0].id).toBe(12);
    await query("CREATE TABLE stdin (copy int)");
    await query("INSERT INTO stdin VALUES (4)");
    expect((await query("SELECT copy FROM stdin"))[0].copy).toBe(4);
    expect((await query("SELECT s.copy FROM public.stdin s"))[0].copy).toBe(4);
    await query("INSERT INTO stdin SELECT copy FROM stdin");
    const prepared = new SQL(server.url(), { max: 1 });
    try {
      expect((await prepared`SELECT s.copy FROM public.stdin s LIMIT 1`)[0].copy).toBe(4);
    } finally {
      await prepared.close();
    }
    const overflow = await wire(server.port);
    const overflowAccepted = overflow.next("G");
    overflow.send("Q", "COPY copied FROM STDIN\0");
    await overflowAccepted;
    const overflowError = overflow.next("E");
    const overflowReady = overflow.next("Z");
    const chunk = Buffer.alloc(1024 * 1024, 10);
    for (let n = 0; n < 65; n++) overflow.send("d", chunk);
    overflow.send("c", "");
    expect((await overflowError).toString()).toContain("C54000\0MPGlite COPY input exceeds 64 MiB");
    await overflowReady;
    const usable = overflow.next("Z");
    const rowAfterLimit = overflow.next("D");
    overflow.send("Q", "SELECT 42\0");
    expect((await rowAfterLimit).toString()).toContain("42");
    await usable;
    overflow.socket.destroy();
    // COPY-looking literals and a SELECT from a table named stdin are not input COPY.
    expect((await query("SELECT 'COPY copied FROM STDIN' AS text"))[0].text).toBe(
      "COPY copied FROM STDIN",
    );
    await expect(query("SELECT 1; COPY copied FROM STDIN")).rejects.toMatchObject({
      errno: "0A000",
    });
    const extended = await wire(server.port);
    const rejected = extended.next("E");
    extended.send("P", "named\0COPY copied FROM STDIN\0\0\0");
    await rejected;
    const synchronized = extended.next("Z");
    extended.send("S", "");
    await synchronized;
    extended.socket.destroy();
    const client = await wire(server.port);
    const copy = client.next("H");
    client.send("Q", "COPY (SELECT generate_series(1, 1000000)) TO STDOUT\0");
    await copy;
    client.socket.destroy();
    expect((await query("SELECT 42 AS n"))[0].n).toBe(42);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("V4-F1: COPY rejections abort explicit transactions and COMMIT rolls back the restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-copy-tx-"));
  const server = await startPglite({ dataDir: join(root, "db"), port: await freePort() });
  const client = await wire(server.port);
  const simple = async (sql: string) => {
    const ready = client.next("Z");
    client.send("Q", `${sql}\0`);
    return ready;
  };
  try {
    await simple("BEGIN; CREATE TABLE restored (id int); INSERT INTO restored VALUES (1)");
    const accepted = client.next("G");
    client.send("Q", "COPY restored FROM STDIN\0");
    await accepted;
    const error = client.next("E"),
      failed = client.next("Z");
    for (let n = 0; n < 65; n++) client.send("d", Buffer.alloc(1024 * 1024, 10));
    client.send("c", "");
    expect((await error).toString()).toContain("54000");
    expect((await failed)[5]).toBe(69); // Failed transaction, not T.
    const rollback = client.next("C");
    await simple("COMMIT");
    expect((await rollback).toString()).toContain("ROLLBACK");
    const absent = client.next("D");
    await simple("SELECT to_regclass('restored') IS NULL");
    expect((await absent).toString()).toContain("t");
    await simple("CREATE TABLE existing (id int)");
    for (const extended of [false, true]) {
      await simple("BEGIN; INSERT INTO existing VALUES (1)");
      const rejected = client.next("E");
      const state = client.next("Z");
      if (extended) {
        client.send("P", "named\0COPY existing FROM STDIN\0\0\0");
        await rejected;
        client.send("S", "");
      } else client.send("Q", "SELECT 1; COPY existing FROM STDIN\0");
      expect((await rejected).toString()).toContain("0A000");
      expect((await state)[5]).toBe(69);
      const rolled = client.next("C");
      await simple("COMMIT");
      expect((await rolled).toString()).toContain("ROLLBACK");
      const rows = client.next("D");
      await simple("SELECT count(*) FROM existing");
      expect((await rows).toString()).toContain("0");
    }
    client.socket.destroy();
    if (Bun.which("psql")) {
      const dump = join(root, "dump.sql");
      await writeFile(
        dump,
        Buffer.concat([
          Buffer.from(
            "CREATE TABLE restore_a (id int); INSERT INTO restore_a VALUES (1);\nCREATE TABLE restore_b (id int);\nCOPY restore_b FROM stdin;\n",
          ),
          Buffer.alloc(65 * 1024 * 1024, 10),
          Buffer.from("\\.\nCREATE TABLE restore_c (id int); INSERT INTO restore_c VALUES (2);\n"),
        ]),
      );
      const psql = Bun.spawn(["psql", server.url(), "-X", "-1", "-f", dump], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, _output, errors] = await Promise.all([
        psql.exited,
        new Response(psql.stdout).text(),
        new Response(psql.stderr).text(),
      ]);
      expect(code).toBe(0); // psql continues without ON_ERROR_STOP, but the transaction must roll back.
      expect(errors).toContain("PGlite COPY input exceeds 64 MiB");
      expect(errors).toContain("current transaction is aborted");
      const sql = new SQL(server.url(), { max: 1 });
      try {
        expect(
          (
            await sql`SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('restore_a', 'restore_b', 'restore_c')`
          )[0].n,
        ).toBe(0);
      } finally {
        await sql.close();
      }
    }
  } finally {
    client.socket.destroy();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
