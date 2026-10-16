import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bufferPgliteCopy } from "../packages/environments/src/pglite-copy.js";
import { startPglite } from "../packages/environments/src/pglite-server.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";
import { freePort } from "./ports.js";

checkPgliteCleanup();
type PGlite = Parameters<typeof bufferPgliteCopy>[0];
type Packet = { type: string; body: Buffer };
async function connect(port: number) {
  const socket = createConnection(port, "127.0.0.1");
  const queue: Packet[] = [];
  let pending = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  socket.on("error", () => wake?.());
  socket.on("close", () => wake?.());
  socket.on("data", (bytes: Buffer) => {
    pending = Buffer.concat([pending, bytes]);
    while (pending.length >= 5 && pending.length >= pending.readInt32BE(1) + 1) {
      const end = pending.readInt32BE(1) + 1;
      queue.push({ type: String.fromCharCode(pending[0]), body: pending.subarray(5, end) });
      pending = pending.subarray(end);
    }
    wake?.();
  });
  const next = async (): Promise<Packet> => {
    while (!queue.length) {
      if (socket.destroyed) throw new Error("wire closed before response");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          wake = undefined;
          reject(new Error("wire response deadline"));
        }, 5000);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
    }
    return queue.shift() as Packet;
  };
  const send = (type: string, body: string | Buffer = "") => {
    const bytes = typeof body === "string" ? Buffer.from(body) : body;
    const packet = Buffer.alloc(5 + bytes.length);
    packet[0] = type.charCodeAt(0);
    packet.writeInt32BE(bytes.length + 4, 1);
    bytes.copy(packet, 5);
    socket.write(packet);
  };
  const until = async (type: string) => {
    const packets: Packet[] = [];
    do {
      packets.push(await next());
    } while (packets.at(-1)?.type !== type);
    return packets;
  };
  const parameters = Buffer.from("user\0app\0database\0app\0\0");
  const startup = Buffer.alloc(8 + parameters.length);
  startup.writeInt32BE(startup.length);
  startup.writeInt32BE(196608, 4);
  parameters.copy(startup, 8);
  socket.write(startup);
  expect(status(await until("Z"))).toBe("I");
  return {
    socket,
    send,
    until,
    async query(sql: string, extended = false) {
      if (extended) {
        send("P", Buffer.concat([Buffer.from(`\0${sql}\0`), Buffer.alloc(2)]));
        send("B", Buffer.alloc(8)); // unnamed portal/statement; no parameters, text results
        send("E", Buffer.alloc(5));
        send("S");
      } else send("Q", `${sql}\0`);
      return until("Z");
    },
  };
}
function status(packets: Packet[]): string {
  return (
    packets
      .filter((p) => p.type === "Z")
      .at(-1)
      ?.body.toString() ?? "absent"
  );
}
function fields(packet: Packet): Record<string, string> {
  const result: Record<string, string> = {};
  for (let at = 0; packet.body[at]; ) {
    const key = String.fromCharCode(packet.body[at++]);
    const end = packet.body.indexOf(0, at);
    result[key] = packet.body.subarray(at, end).toString();
    at = end + 1;
  }
  return result;
}
const errors = (packets: Packet[]) => packets.filter((p) => p.type === "E").map(fields);
const tags = (packets: Packet[]) =>
  packets.filter((p) => p.type === "C").map((p) => p.body.toString().replace(/\0$/, ""));
function value(packets: Packet[]): string {
  const row = packets.find((p) => p.type === "D");
  if (!row) throw new Error("missing DataRow");
  return row.body.subarray(6, 6 + row.body.readInt32BE(2)).toString();
}
const scenarios = [
  "text",
  "csv",
  "binary",
  "bad-row",
  "disconnect",
  "cap",
  "unsupported",
  "identifiers",
  "literal",
  "comment",
  "dollar",
  "DO",
] as const;
const falseSql = {
  identifiers: "SELECT s.copy FROM public.stdin s",
  literal: "SELECT 'COPY matrix FROM STDIN'",
  comment: "/* COPY matrix FROM STDIN */ SELECT 42 -- COPY matrix FROM STDIN",
  dollar: "SELECT $$COPY matrix FROM STDIN$$",
  DO: "DO $$ BEGIN PERFORM 'COPY matrix FROM STDIN'; END $$",
};
function binaryRows(): Buffer {
  const row = (id: number) => {
    const b = Buffer.alloc(10);
    b.writeInt16BE(1);
    b.writeInt32BE(4, 2);
    b.writeInt32BE(id, 6);
    return b;
  };
  return Buffer.concat([
    Buffer.from([80, 71, 67, 79, 80, 89, 10, 255, 13, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    row(1),
    row(2),
    Buffer.from([255, 255]),
  ]);
}

test("systematic COPY matrix: protocol × transaction × scenario, wire status and committed data", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-copy-matrix-"));
  const server = await startPglite({ dataDir: join(root, "db"), port: await freePort() });
  const outcomes: object[] = [];
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    for (const extended of [false, true])
      for (const transaction of [false, true])
        for (const scenario of scenarios) {
          const cell = `${extended ? "extended" : "simple"}/${transaction ? "BEGIN" : "autocommit"}/${scenario}`;
          client = await connect(server.port);
          try {
            expect(
              errors(
                await client.query(
                  "DROP TABLE IF EXISTS matrix; CREATE TABLE matrix(id int); DROP TABLE IF EXISTS stdin; CREATE TABLE stdin(copy int); INSERT INTO stdin VALUES(42)",
                ),
              ),
              cell,
            ).toEqual([]);
            if (transaction) await client.query("BEGIN; INSERT INTO matrix VALUES (999)");
            const nonCopy = scenario in falseSql;
            let packets: Packet[];
            let disconnected = false;
            const rejected = !nonCopy && (extended || scenario === "unsupported");
            if (nonCopy)
              packets = await client.query(falseSql[scenario as keyof typeof falseSql], extended);
            else if (rejected)
              packets = await client.query(
                scenario === "unsupported"
                  ? "SELECT 1; COPY matrix FROM STDIN"
                  : `COPY matrix FROM STDIN${scenario === "csv" ? " WITH (FORMAT csv, HEADER true)" : scenario === "binary" ? " WITH (FORMAT binary)" : ""}`,
                extended,
              );
            else {
              const format =
                scenario === "csv"
                  ? " WITH (FORMAT csv, HEADER true)"
                  : scenario === "binary"
                    ? " WITH (FORMAT binary)"
                    : "";
              client.send("Q", `COPY matrix FROM STDIN${format}\0`);
              expect((await client.until("G")).at(-1)?.type, cell).toBe("G");
              if (scenario === "disconnect") {
                client.send("d", "1\n2\n");
                // Ensure the worker has received partial CopyData before disconnecting.
                await Bun.sleep(20);
                client.socket.destroy();
                disconnected = true;
                packets = [];
              } else {
                if (scenario === "cap") {
                  // Even if the cap is removed, bad input must not satisfy the required 54000.
                  const chunk = Buffer.from("bad\n".repeat(256 * 1024));
                  for (let n = 0; n < 65; n++) client.send("d", chunk);
                } else if (scenario === "binary") client.send("d", binaryRows());
                else if (scenario === "bad-row") {
                  client.send("d", "1\n");
                  client.send("d", "bad\n2\n");
                } else client.send("d", scenario === "csv" ? 'id\n"1"\n"2"\n' : "1\n2\n");
                client.send("c");
                packets = await client.until("Z");
              }
            }
            const failed = rejected || scenario === "bad-row" || scenario === "cap";
            const expectedRows =
              failed || disconnected ? 0 : (nonCopy ? 0 : 2) + (transaction ? 1 : 0);
            let commit = "unobservable: connection destroyed";
            let ready = "unobservable: connection destroyed";
            if (!disconnected) {
              ready = status(packets);
              expect(ready, cell).toBe(transaction ? (failed ? "E" : "T") : "I");
              if (failed) {
                const expectedCode = rejected ? "0A000" : scenario === "cap" ? "54000" : "22P02";
                const expectedMessage = rejected
                  ? "PGlite COPY input requires a single simple-query COPY statement"
                  : scenario === "cap"
                    ? "PGlite COPY input exceeds 64 MiB"
                    : 'invalid input syntax for type integer: "bad"';
                expect(
                  errors(packets).map((e) => [e.C, e.M]),
                  cell,
                ).toEqual([[expectedCode, expectedMessage]]);
              } else {
                expect(errors(packets), cell).toEqual([]);
                expect(tags(packets), cell).toEqual([
                  nonCopy ? (scenario === "DO" ? "DO" : "SELECT 1") : "COPY 2",
                ]);
              }
              const probe = await client.query("SELECT 42", extended);
              if (failed && transaction) {
                expect(errors(probe)[0]?.C, cell).toBe("25P02");
                expect(status(probe), cell).toBe("E");
              } else {
                expect(value(probe), cell).toBe("42");
                expect(status(probe), cell).toBe(transaction ? "T" : "I");
              }
              const committed = await client.query("COMMIT");
              commit = failed && transaction ? "ROLLBACK" : "COMMIT";
              expect(errors(committed), cell).toEqual([]);
              expect(tags(committed), cell).toEqual([commit]);
              expect(status(committed), cell).toBe("I");
              expect(value(await client.query("SELECT count(*) FROM matrix")), cell).toBe(
                String(expectedRows),
              );
              expect(value(await client.query("SELECT 42", extended)), cell).toBe("42");
              client.socket.destroy();
            }
            client = await connect(server.port);
            expect(value(await client.query("SELECT count(*) FROM matrix")), cell).toBe(
              String(expectedRows),
            );
            expect(value(await client.query("SELECT 42", extended)), cell).toBe("42");
            client.socket.destroy();
            outcomes.push({
              cell,
              outcome: disconnected
                ? "discarded partial input"
                : failed
                  ? errors(packets)[0]?.C
                  : tags(packets)[0],
              ready,
              commit,
              rows: expectedRows,
            });
          } finally {
            client.socket.destroy();
          }
        }
    console.log(`COPY_MATRIX ${JSON.stringify(outcomes)}`);
    // psql exercises its client-side \copy and single-transaction file driver too.
    if (Bun.which("psql")) {
      const run = async (args: string[], input?: Buffer) => {
        const child = Bun.spawn(["psql", server.url(), "-X", ...args], {
          stdin: input ?? "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, stderr).toBe(0);
        return { stdout, stderr };
      };
      await run(["-c", "TRUNCATE matrix"]);
      expect(
        (await run(["-c", "\\copy matrix FROM STDIN WITH (FORMAT csv)"], Buffer.from("1\n2\n")))
          .stdout,
      ).toContain("COPY 2");
      expect((await run(["-Atc", "SELECT count(*) FROM matrix"])).stdout.trim()).toBe("2");
      const dump = join(root, "dump.sql");
      await writeFile(
        dump,
        Buffer.concat([
          Buffer.from(
            "CREATE TABLE dump_a(id int); INSERT INTO dump_a VALUES(1);\nCREATE TABLE dump_b(id int);\nCOPY dump_b FROM STDIN;\n",
          ),
          Buffer.from("1\n".repeat(65 * 512 * 1024)),
          Buffer.from("\\.\nCREATE TABLE dump_c(id int);\n"),
        ]),
      );
      const restore = await run(["-1", "-f", dump]);
      expect(restore.stderr).toContain("PGlite COPY input exceeds 64 MiB");
      expect(restore.stderr).toContain("current transaction is aborted");
      expect(
        (
          await run([
            "-Atc",
            "SELECT count(*) FROM pg_tables WHERE tablename IN ('dump_a','dump_b','dump_c')",
          ])
        ).stdout.trim(),
      ).toBe("0");
    } else
      console.log(
        "COPY_MATRIX psql cells skipped: psql is not installed; raw protocol cells remain mandatory",
      );
  } finally {
    client?.socket.destroy();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

test("V5 extended error differential cells: Execute/Bind/Describe, Flush, Close and multiple Syncs", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-pipeline-"));
  const server = await startPglite({ dataDir: join(root, "db"), port: await freePort() });
  const client = await connect(server.port);
  const pipeline = (sql: string) => {
    client.send("P", Buffer.concat([Buffer.from(`\0${sql}\0`), Buffer.alloc(2)]));
    client.send("B", Buffer.alloc(8));
    client.send("E", Buffer.alloc(5));
  };
  try {
    await client.query("CREATE TABLE piped(id int)");
    for (const transaction of [false, true])
      for (const scenario of ["execute", "bind", "describe", "parse-flush-close"]) {
        await client.query("TRUNCATE piped");
        if (transaction) await client.query("BEGIN; INSERT INTO piped VALUES(999)");
        let response: Packet[];
        if (scenario === "execute") {
          pipeline("INSERT INTO piped VALUES(1)");
          pipeline("SELECT 1/0");
          pipeline("INSERT INTO piped VALUES(3)");
          client.send("S");
          response = await client.until("Z");
        } else if (scenario === "bind") {
          client.send("P", Buffer.concat([Buffer.from("\0SELECT $1::int\0"), Buffer.alloc(2)]));
          client.send("B", Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 3, 98, 97, 100, 0, 0]));
          client.send("E", Buffer.alloc(5));
          client.send("S");
          response = await client.until("Z");
        } else if (scenario === "describe") {
          client.send("D", "Smissing\0");
          client.send("S");
          response = await client.until("Z");
        } else {
          client.send("P", Buffer.concat([Buffer.from("\0SELECT FROM\0"), Buffer.alloc(2)]));
          client.send("H");
          const beforeSync = await client.until("E");
          expect(beforeSync.some((p) => p.type === "Z")).toBe(false);
          client.send("D", "Smissing\0");
          client.send("C", "Smissing\0");
          client.send("S");
          response = [...beforeSync, ...(await client.until("Z"))];
        }
        expect(errors(response).map((e) => e.C)).toEqual([
          scenario === "execute"
            ? "22012"
            : scenario === "bind"
              ? "22P02"
              : scenario === "describe"
                ? "26000"
                : "42601",
        ]);
        expect(status(response)).toBe(transaction ? "E" : "I");
        const committed = await client.query("COMMIT");
        expect(tags(committed)).toEqual([transaction ? "ROLLBACK" : "COMMIT"]);
        expect(status(committed)).toBe("I");
        expect(value(await client.query("SELECT count(*) FROM piped"))).toBe("0");
        expect(value(await client.query("SELECT 42", true))).toBe("42");
      }
    for (const transaction of [false, true]) {
      await client.query("TRUNCATE piped");
      if (transaction) await client.query("BEGIN; INSERT INTO piped VALUES(999)");
      pipeline("INSERT INTO piped VALUES(1)");
      client.send("S");
      pipeline("SELECT 1/0");
      client.send("S");
      pipeline("INSERT INTO piped VALUES(3)");
      client.send("S");
      const groups = [await client.until("Z"), await client.until("Z"), await client.until("Z")];
      expect(groups.map(status)).toEqual(transaction ? ["T", "E", "E"] : ["I", "I", "I"]);
      expect(groups.map((g) => errors(g).map((e) => e.C))).toEqual([
        [],
        ["22012"],
        transaction ? ["25P02"] : [],
      ]);
      expect(tags(await client.query("COMMIT"))).toEqual([transaction ? "ROLLBACK" : "COMMIT"]);
      expect(value(await client.query("SELECT count(*) FROM piped"))).toBe(transaction ? "0" : "2");
    }
    await client.query("INSERT INTO piped VALUES(1),(3)");
    await client.query("BEGIN; TRUNCATE piped");
    client.send("Q", "COPY piped FROM STDIN\0");
    await client.until("G");
    client.send("d", "1\n");
    client.send("c");
    expect(status(await client.until("Z"))).toBe("T");
    client.send("Q", "COPY piped FROM STDIN\0");
    await client.until("G");
    client.send("d", "bad\n");
    client.send("c");
    expect(errors(await client.until("Z"))[0].C).toBe("22P02");
    expect(tags(await client.query("COMMIT"))).toEqual(["ROLLBACK"]);
    expect(value(await client.query("SELECT count(*) FROM piped"))).toBe("2");
    await client.query("BEGIN");
    client.send("Q", "COPY piped TO STDOUT\0");
    const output = await client.until("Z");
    expect(output.some((p) => p.type === "H")).toBe(true);
    expect(tags(output)).toEqual(["COPY 2"]);
    expect(status(output)).toBe("T");
    expect(tags(await client.query("COMMIT"))).toEqual(["COMMIT"]);
  } finally {
    client.socket.destroy();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("V5 COPY statement errors and client CopyFail, autocommit and BEGIN", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-copy-errors-"));
  const server = await startPglite({ dataDir: join(root, "db"), port: await freePort() });
  const client = await connect(server.port);
  try {
    await client.query("CREATE TABLE statement_errors(id int)");
    for (const transaction of [false, true])
      for (const scenario of ["missing", "option", "copyfail"]) {
        await client.query("TRUNCATE statement_errors");
        if (transaction) await client.query("BEGIN; INSERT INTO statement_errors VALUES(999)");
        client.send(
          "Q",
          `${scenario === "missing" ? "COPY missing_table FROM STDIN" : scenario === "option" ? "COPY statement_errors FROM STDIN WITH(FORMAT nonsense)" : "COPY statement_errors FROM STDIN"}\0`,
        );
        // Statement validation is deferred until the complete exchange: documented limit.
        await client.until("G");
        client.send(
          scenario === "copyfail" ? "f" : "d",
          scenario === "copyfail" ? "matrix client aborted\0" : "1\n",
        );
        if (scenario !== "copyfail") client.send("c");
        const response = await client.until("Z");
        const error = errors(response)[0];
        expect(error.C).toBe(
          scenario === "missing" ? "42P01" : scenario === "option" ? "22023" : "57014",
        );
        expect(error.M).toContain(
          scenario === "missing"
            ? 'relation "missing_table" does not exist'
            : scenario === "option"
              ? 'COPY format "nonsense" not recognized'
              : "matrix client aborted",
        );
        expect(status(response)).toBe(transaction ? "E" : "I");
        expect(tags(await client.query("COMMIT"))).toEqual([transaction ? "ROLLBACK" : "COMMIT"]);
        expect(value(await client.query("SELECT count(*) FROM statement_errors"))).toBe("0");
        expect(value(await client.query("SELECT 42", true))).toBe("42");
      }
  } finally {
    client.socket.destroy();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("V6-F3: large Execute DataRows are forwarded incrementally before the source completes", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let completed = false;
  // A controlled protocol source makes streaming observable without RSS/GC timing.
  // This is the same onRawData contract the socket server forwards to its client.
  const row = Buffer.alloc(65547, 120);
  row[0] = 68;
  row.writeInt32BE(row.length - 1, 1);
  row.writeInt16BE(1, 5);
  row.writeInt32BE(65536, 7);
  const db = {
    execProtocolRawStream: async (
      _message: Uint8Array,
      options: { onRawData: (bytes: Uint8Array) => void },
    ) => {
      for (let n = 0; n < 512; n++) options.onRawData(row);
      await gate;
      completed = true;
    },
  } as unknown as PGlite;
  bufferPgliteCopy(db);
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw Error("No listener port assigned");
  const accepted = once(listener, "connection");
  const client = createConnection(address.port, "127.0.0.1");
  const [socket] = await accepted;
  socket.on("error", () => {});
  client.on("error", () => {});
  let firstRow!: () => void;
  const delivered = new Promise<void>((resolve) => {
    firstRow = resolve;
  });
  let networkBytes = 0;
  client.on("data", (chunk) => {
    networkBytes += chunk.length;
    if (networkBytes >= row.length) firstRow();
  });
  let bytes = 0,
    rows = 0;
  const pending = db.execProtocolRawStream(new Uint8Array([69, 0, 0, 0, 9, 0, 0, 0, 0, 0]), {
    onRawData: (chunk) => {
      bytes += chunk.length;
      rows++;
      socket.write(chunk);
    },
  });
  try {
    expect(completed).toBe(false);
    expect(rows).toBe(512);
    expect(bytes).toBe(512 * row.length); // >32 MiB forwarded while completion is held.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        delivered,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("first DataRow was buffered")), 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    expect(completed).toBe(false); // An actual loopback client received a DataRow before completion.
  } finally {
    finish();
    await pending;
    socket.destroy();
    client.destroy();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
