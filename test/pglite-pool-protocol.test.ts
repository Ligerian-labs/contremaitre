import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { lockPgliteData } from "../packages/environments/src/pglite-data.js";
import { openPglite } from "../packages/environments/src/pglite-initialize.js";
import {
  type PgliteOutputLease,
  pgliteOutputFiles,
} from "../packages/environments/src/pglite-output.js";
import { createPglitePool } from "../packages/environments/src/pglite-pool.js";
import { startPglite } from "../packages/environments/src/pglite-server.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";
import { freePort } from "./ports.js";

checkPgliteCleanup();
const cstr = (text: string) => Buffer.from(`${text}\0`);
function packet(type: string, body = Buffer.alloc(0)) {
  const result = Buffer.alloc(body.length + 5);
  result[0] = type.charCodeAt(0);
  result.writeInt32BE(body.length + 4, 1);
  body.copy(result, 5);
  return result;
}
const query = (sql: string) => packet("Q", cstr(sql));
const parse = (name: string, sql: string) =>
  packet("P", Buffer.concat([cstr(name), cstr(sql), Buffer.alloc(2)]));
const bind = (name: string) =>
  packet("B", Buffer.concat([Buffer.from([0]), cstr(name), Buffer.alloc(6)]));
const execute = () => packet("E", Buffer.alloc(5));
const sync = () => packet("S");
const error = (packets: Buffer[]) => packets.find((p) => p[0] === 69)?.toString();
const state = (packets: Buffer[]) => String.fromCharCode(packets.at(-1)?.[5] ?? 0);
const value = (packets: Buffer[]) => {
  const row = packets.find((p) => p[0] === 68);
  if (!row) throw Error("Missing DataRow");
  return row.toString("utf8", 11, 11 + row.readInt32BE(7));
};
async function wire(port: number) {
  const socket = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
  const queue: Buffer[] = [];
  let input = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  socket.on("error", () => wake?.());
  socket.on("close", () => wake?.());
  socket.on("end", () => wake?.());
  socket.on("data", (data: Buffer) => {
    input = Buffer.concat([input, data]);
    while (input.length >= 5 && input.length >= input.readInt32BE(1) + 1) {
      const end = input.readInt32BE(1) + 1;
      queue.push(Buffer.from(input.subarray(0, end)));
      input = input.subarray(end);
    }
    wake?.();
  });
  const write = (...parts: Buffer[]) => socket.write(Buffer.concat(parts));
  const until = async (type: string, timeout = 10000) => {
    const seen: Buffer[] = [];
    const deadline = Date.now() + timeout;
    for (;;) {
      const next = queue.shift();
      if (next) {
        seen.push(next);
        if (type.includes(String.fromCharCode(next[0]))) return seen;
      } else {
        if (socket.destroyed || socket.readableEnded) {
          if (type.includes("!")) return seen;
          throw Error("Socket closed before response");
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("Wire response deadline")),
            Math.max(1, deadline - Date.now()),
          );
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          };
        });
      }
    }
  };
  const params = Buffer.from("user\0app\0database\0app\0\0");
  const startup = Buffer.alloc(8);
  startup.writeInt32BE(8 + params.length);
  startup.writeInt32BE(196608, 4);
  write(startup, params);
  expect(state(await until("Z"))).toBe("I");
  return {
    socket,
    write,
    until,
    pending: () => [...queue],
    query: async (sql: string) => {
      write(query(sql));
      return until("Z");
    },
  };
}
async function database(
  mode: "session" | "transaction",
  run: (server: Awaited<ReturnType<typeof startPglite>>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-protocol-"));
  const server = await startPglite({
    dataDir: join(root, "db"),
    port: await freePort(),
    poolMode: mode,
  });
  try {
    await run(server);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function observedPool(
  run: (port: number, sockets: Socket[]) => Promise<void>,
  openOutput?: () => Promise<PgliteOutputLease>,
) {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-observed-"));
  const dataDir = join(root, "db");
  await mkdir(dataDir);
  const unlock = await lockPgliteData(dataDir);
  const db = await openPglite(dataDir, () => true);
  let failure: unknown;
  const pool = createPglitePool(db, {
    openOutput,
    resetting() {},
    reset() {},
    fatal(error) {
      failure = error;
    },
  });
  const sockets: Socket[] = [];
  pool.server.on("connection", (socket) => sockets.push(socket));
  try {
    const listening = once(pool.server, "listening");
    pool.server.listen(0, "127.0.0.1");
    await listening;
    const address = pool.server.address();
    if (!address || typeof address === "string") throw Error("No pool port assigned");
    await run(address.port, sockets);
    expect(failure).toBeUndefined();
  } finally {
    for (const socket of sockets) socket.destroy();
    await pool.stop();
    await new Promise<void>((resolve) => pool.server.close(() => resolve()));
    await db.close();
    await unlock();
    await rm(root, { recursive: true, force: true });
  }
}

for (const mode of ["session", "transaction"] as const) {
  for (const failed of [false, true]) {
    test(`${mode} recovers an abandoned ${failed ? "failed explicit" : "unsynced implicit"} exchange without committing`, async () => {
      await database(mode, async (server) => {
        const a = await wire(server.port);
        try {
          await a.query("CREATE TABLE abandoned(i int)");
          if (failed) await a.query("BEGIN; INSERT INTO abandoned VALUES (1)");
          a.write(
            parse("", failed ? "SELEC" : "INSERT INTO abandoned VALUES (1)"),
            ...(failed ? [] : [bind(""), execute()]),
            packet("H"),
          );
          const response = await a.until(failed ? "E" : "C");
          if (failed) expect(error(response)).toContain("42601");
          a.socket.destroy();
          const b = await wire(server.port);
          try {
            const count = await b.query("SELECT count(*) FROM abandoned");
            expect(value(count)).toBe("0");
            expect(state(count)).toBe("I");
            expect(server.running).toBe(true);
          } finally {
            b.socket.destroy();
          }
        } finally {
          a.socket.destroy();
        }
      });
    }, 30000);
  }
}

for (const fin of [false, true]) {
  test(`transaction pool processes COMMIT before pipelined Terminate${fin ? " and FIN" : ""}`, async () => {
    await database("transaction", async (server) => {
      const a = await wire(server.port);
      try {
        await a.query("CREATE TABLE committed(i int)");
        await a.query("BEGIN; INSERT INTO committed VALUES (1)");
        const ended = once(a.socket, "end");
        a.write(query("COMMIT"), packet("X"));
        if (fin) a.socket.end();
        await ended;
        const b = await wire(server.port);
        try {
          expect(value(await b.query("SELECT count(*) FROM committed"))).toBe("1");
        } finally {
          b.socket.destroy();
        }
      } finally {
        a.socket.destroy();
      }
    });
  }, 30000);
}

test("replayed statements preserve their result shape and abort explicit transactions on change", async () => {
  await database("transaction", async (server) => {
    const a = await wire(server.port);
    try {
      await a.query("CREATE TABLE shaped(i int); INSERT INTO shaped VALUES (17)");
      a.write(parse("shape", "SELECT * FROM shaped"), sync());
      expect(error(await a.until("Z"))).toBeUndefined();
      await a.query("ALTER TABLE shaped ALTER COLUMN i TYPE text USING i::text");
      for (const transaction of [false, true]) {
        if (transaction) await a.query("BEGIN");
        a.write(bind("shape"), execute(), sync());
        const response = await a.until("Z");
        expect(error(response)).toContain("0A000");
        expect(response.some((p) => p[0] === 68)).toBe(false);
        expect(state(response)).toBe(transaction ? "E" : "I");
        if (transaction) {
          expect(error(await a.query("SELECT 1"))).toContain("25P02");
          await a.query("ROLLBACK");
        }
      }
      expect(server.running).toBe(true);
    } finally {
      a.socket.destroy();
    }
  });
}, 30000);

test("replayed inferred parameter types stay fixed after a column type changes", async () => {
  await database("transaction", async (server) => {
    const a = await wire(server.port);
    try {
      await a.query("CREATE TABLE inferred(i int)");
      a.write(parse("parameter", "INSERT INTO inferred VALUES ($1)"), sync());
      await a.until("Z");
      await a.query("ALTER TABLE inferred ALTER COLUMN i TYPE text");
      a.write(packet("D", Buffer.from("Sparameter\0")), sync());
      const description = await a.until("Z");
      expect(description.find((p) => p[0] === 116)?.readInt32BE(7)).toBe(23);
      const binary = Buffer.alloc(16);
      binary.writeInt16BE(1, 0); // one parameter format
      binary.writeInt16BE(1, 2); // binary
      binary.writeInt16BE(1, 4); // one parameter
      binary.writeInt32BE(4, 6);
      binary.writeInt32BE(17, 10);
      a.write(
        packet("B", Buffer.concat([Buffer.from("\0parameter\0"), binary])),
        execute(),
        sync(),
      );
      expect(error(await a.until("Z"))).toBeUndefined();
      expect(value(await a.query("SELECT i FROM inferred"))).toBe("17");
    } finally {
      a.socket.destroy();
    }
  });
}, 30000);

for (const sql of ["DEALLOCATE ALL", "DISCARD ALL"]) {
  test(`${sql} invalidates virtual prepared statements`, async () => {
    await database("transaction", async (server) => {
      const a = await wire(server.port);
      try {
        a.write(parse("gone", "SELECT 19"), sync());
        await a.until("Z");
        expect(error(await a.query(sql))).toBeUndefined();
        a.write(bind("gone"), execute(), sync());
        expect(error(await a.until("Z"))).toContain("26000");
      } finally {
        a.socket.destroy();
      }
    });
  }, 30000);
}

test("runtime Execute errors await Sync once and keep the backend leased until then", async () => {
  await database("transaction", async (server) => {
    const a = await wire(server.port);
    const b = await wire(server.port);
    try {
      a.write(
        parse("private_lock", "SELECT pg_advisory_lock(4242)"),
        bind("private_lock"),
        execute(),
        parse("", "SELECT 1/(i-i) FROM generate_series(1,1) i"),
        bind(""),
        execute(),
        packet("H"),
      );
      expect(error(await a.until("E"))).toContain("22012");
      let finished = false;
      const waiting = b
        .query(
          "SELECT concat((SELECT count(*) FROM pg_prepared_statements), ':', (SELECT count(*) FROM pg_locks WHERE locktype='advisory'))",
        )
        .then((response) => {
          finished = true;
          return response;
        });
      await Bun.sleep(50);
      expect(finished).toBe(false);
      a.write(sync());
      expect(state(await a.until("Z"))).toBe("I");
      expect(value(await waiting)).toBe("0:0");
      expect(value(await a.query("SELECT 43"))).toBe("43");
    } finally {
      a.socket.destroy();
      b.socket.destroy();
    }
  });
}, 30000);

test("large SELECT and COPY return complete results to their requester and keep both clients usable", async () => {
  await database("transaction", async (server) => {
    const a = await wire(server.port);
    const b = await wire(server.port);
    try {
      for (const copying of [false, true]) {
        a.write(
          query(
            copying
              ? "COPY (SELECT repeat('x',1048576) FROM generate_series(1,70)) TO STDOUT"
              : "SELECT repeat('x',1048576) FROM generate_series(1,70)",
          ),
        );
        const response = await a.until("Z");
        expect(error(response)).toBeUndefined();
        expect(state(response)).toBe("I");
        if (copying) {
          expect(
            response.filter((p) => p[0] === 100).reduce((sum, p) => sum + p.length - 5, 0),
          ).toBe(70 * (1048576 + 1));
          expect(response.find((p) => p[0] === 67)?.toString()).toContain("COPY 70");
        } else {
          const rows = response.filter((p) => p[0] === 68);
          expect(rows).toHaveLength(70);
          expect(rows.reduce((sum, p) => sum + p.readInt32BE(7), 0)).toBe(70 * 1048576);
        }
        expect(value(await a.query("SELECT 43"))).toBe("43");
        expect(value(await b.query("SELECT 44"))).toBe("44");
        expect(server.running).toBe(true);
      }
    } finally {
      a.socket.destroy();
      b.socket.destroy();
    }
  });
}, 60000);

test("Bun SQL receives every byte of a result larger than the socket output budget", async () => {
  await database("transaction", async (server) => {
    const sql = new SQL(server.url(), { max: 1, connectionTimeout: 5 });
    try {
      const rows = await sql.unsafe("SELECT repeat('x',1048576) AS v FROM generate_series(1,70)");
      expect(rows).toHaveLength(70);
      expect(rows.reduce((sum: number, row: { v: string }) => sum + row.v.length, 0)).toBe(
        70 * 1048576,
      );
      expect((await sql`SELECT ${47}::int AS value`)[0].value).toBe(47);
    } finally {
      await sql.close({ timeout: 0 });
    }
  });
}, 60000);

for (const mode of ["session", "transaction"] as const) {
  test(`${mode} emits no ReadyForQuery before Sync after an Execute error`, async () => {
    await database(mode, async (server) => {
      const a = await wire(server.port);
      try {
        a.write(
          parse("", "SELECT i, 10/(3-i) FROM generate_series(1,5) i"),
          bind(""),
          execute(),
          packet("H"),
        );
        const partial = await a.until("E");
        expect(partial.filter((p) => p[0] === 68)).toHaveLength(2);
        expect(error(partial)).toContain("22012");
        await Bun.sleep(30);
        expect(a.pending().some((p) => p[0] === 90)).toBe(false);
        a.write(sync());
        expect(state(await a.until("Z"))).toBe("I");
        expect(value(await a.query("SELECT 45"))).toBe("45");
      } finally {
        a.socket.destroy();
      }
    });
  }, 30000);
}

test("individual SQL DEALLOCATE is rejected without matching literal or quoted command text", async () => {
  await database("transaction", async (server) => {
    const a = await wire(server.port);
    try {
      for (const sql of [
        "SELECT 'DEALLOCATE other'",
        'SELECT 1 AS "DEALLOCATE"',
        "DO $$ BEGIN PERFORM 'DEALLOCATE other'; END $$",
      ]) {
        expect(error(await a.query(sql))).toBeUndefined();
      }
      for (const extended of [false, true]) {
        await a.query("BEGIN");
        let response: Buffer[];
        if (extended) {
          a.write(parse("", '/* comment */ DEALLOCATE PREPARE "ALL"'), bind(""), execute(), sync());
          response = await a.until("Z");
        } else response = await a.query("DEALLOCATE missing");
        expect(error(response)).toContain("0A000");
        expect(state(response)).toBe("E");
        expect(error(await a.query("SELECT 1"))).toContain("25P02");
        await a.query("ROLLBACK");
      }
    } finally {
      a.socket.destroy();
    }
  });
}, 30000);

test("transaction lease idle deadline excludes long native execution", async () => {
  await database("transaction", async (server) => {
    const a = await wire(server.port);
    try {
      await a.query("CREATE TABLE long_transaction(i int)");
      await a.query("BEGIN; INSERT INTO long_transaction VALUES (1)");
      a.write(query("SELECT pg_sleep(31)"));
      expect(state(await a.until("Z", 90000))).toBe("T");
      // Give an overdue timer a chance to fire before sending the next message.
      await Bun.sleep(50);
      expect(value(await a.query("SELECT 46"))).toBe("46");
      expect(state(await a.query("COMMIT"))).toBe("I");
      expect(value(await a.query("SELECT count(*) FROM long_transaction"))).toBe("1");
    } finally {
      a.socket.destroy();
    }
  });
}, 120000);

test("an oversized result packet disconnects only its owner and rolls back its transaction", async () => {
  await database("transaction", async (server) => {
    const a = await wire(server.port);
    const b = await wire(server.port);
    try {
      await a.query("CREATE TABLE oversized(i int)");
      await a.query("BEGIN; INSERT INTO oversized VALUES (1)");
      a.write(query("SELECT repeat('x',65*1024*1024)"));
      expect(error(await a.until("E"))).toContain("54000");
      expect(value(await b.query("SELECT count(*) FROM oversized"))).toBe("0");
      expect(server.running).toBe(true);
    } finally {
      a.socket.destroy();
      b.socket.destroy();
    }
  });
}, 60000);

test("released transaction owners yield to queued clients before their next transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-pglite-fairness-"));
  const dataDir = join(root, "db");
  await mkdir(dataDir);
  const unlock = await lockPgliteData(dataDir);
  const db = await openPglite(dataDir, () => true);
  let failure: unknown;
  const pool = createPglitePool(db, {
    resetting() {},
    reset() {},
    fatal(error) {
      failure = error;
    },
  });
  const accepted: Socket[] = [];
  pool.server.on("connection", (socket) => accepted.push(socket));
  let a: Awaited<ReturnType<typeof wire>> | undefined;
  let b: Awaited<ReturnType<typeof wire>> | undefined;
  try {
    const listening = once(pool.server, "listening");
    pool.server.listen(0, "127.0.0.1");
    await listening;
    const address = pool.server.address();
    if (!address || typeof address === "string") throw Error("No pool port assigned");
    a = await wire(address.port);
    expect(
      error(await a.query("CREATE TABLE turns(id serial PRIMARY KEY, actor text)")),
    ).toBeUndefined();
    b = await wire(address.port);
    // Setup finishes before B connects, so the frontend insertion order is A, B.
    expect(state(await a.query("BEGIN"))).toBe("T");
    const request = query("INSERT INTO turns(actor) VALUES ('B') RETURNING id");
    const backend = accepted[1];
    let bytes = 0;
    const queued = new Promise<void>((resolve) => {
      const observe = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes >= request.length) {
          backend.off("data", observe);
          resolve();
        }
      };
      // The real pool installs its framing listener in its connection callback.
      // This later listener runs after it has queued B's complete request while
      // A still owns BEGIN. A client-side write callback would not prove that.
      backend.on("data", observe);
    });
    b.write(request);
    await queued;
    a.write(query("COMMIT"), query("INSERT INTO turns(actor) VALUES ('A') RETURNING id"));
    expect(state(await a.until("Z"))).toBe("I");
    const following = await a.until("Z");
    const waiting = await b.until("Z");
    expect(error(following)).toBeUndefined();
    expect(error(waiting)).toBeUndefined();
    expect(value(waiting)).toBe("1");
    expect(value(following)).toBe("2");
    expect(
      value(
        await a.query("SELECT string_agg(id::text || ':' || actor, ',' ORDER BY id) FROM turns"),
      ),
    ).toBe("1:B,2:A");
    expect(failure).toBeUndefined();
  } finally {
    a?.socket.destroy();
    b?.socket.destroy();
    await pool.stop();
    await new Promise<void>((resolve) => pool.server.close(() => resolve()));
    await db.close();
    await unlock();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

for (const explicit of [false, true]) {
  test(`oversized streamed COPY discards its tail and recovers ${explicit ? "with same-client rollback" : "before a bystander query"}`, async () => {
    await observedPool(async (port, accepted) => {
      const a = await wire(port);
      const b = await wire(port);
      try {
        await a.query("CREATE TABLE copy_tail(t text)");
        if (explicit) await a.query("BEGIN");
        a.write(query("COPY copy_tail FROM STDIN"));
        await a.until("G");
        const chunk = packet("d", Buffer.from(`${"z".repeat(1048575)}\n`));
        const done = packet("c");
        // Confirm all 70 CopyData packets and CopyDone reached the actual
        // framing listener, even when TCP fragments the stream. This schedules
        // B after the tail, not after an arbitrary wait or an A recovery query.
        let received = 0;
        const tailQueued = new Promise<void>((resolve) => {
          const observe = (bytes: Buffer) => {
            received += bytes.length;
            if (received >= 70 * chunk.length + done.length) {
              accepted[0].off("data", observe);
              resolve();
            }
          };
          accepted[0].on("data", observe);
        });
        for (let i = 0; i < 70; i++) a.write(chunk);
        a.write(done);
        const response = await a.until("Z");
        expect(error(response)).toContain("54000");
        expect(state(response)).toBe(explicit ? "E" : "I");
        await tailQueued;
        const bystander = b.query("SELECT count(*) FROM copy_tail");
        if (explicit) {
          expect(error(await a.query("SELECT 1"))).toContain("25P02");
          expect(state(await a.query("ROLLBACK"))).toBe("I");
        }
        expect(value(await bystander)).toBe("0");
        expect(value(await a.query("SELECT count(*) FROM copy_tail"))).toBe("0");
        expect(value(await a.query("SELECT 48"))).toBe("48");
      } finally {
        a.socket.destroy();
        b.socket.destroy();
      }
    });
  }, 30000);
}

test("socket input gets a turn while another client drains an autocommit pipeline", async () => {
  await database("transaction", async (server) => {
    const busy = await wire(server.port);
    const late = await wire(server.port);
    try {
      await busy.query("CREATE TABLE socket_turns(id serial PRIMARY KEY, actor text)");
      const total = 300;
      for (let i = 0; i < total; i++)
        busy.write(
          query("INSERT INTO socket_turns(actor) SELECT 'busy' FROM pg_sleep(0.01) RETURNING id"),
        );
      // A real response proves the busy stream has begun. The late request
      // arrives over another socket after the first complete transaction.
      expect(state(await busy.until("Z"))).toBe("I");
      const response = await late.query(
        "INSERT INTO socket_turns(actor) VALUES ('late') RETURNING id",
      );
      expect(error(response)).toBeUndefined();
      expect(Number(value(response))).toBeLessThan(total + 1);
      for (let i = 1; i < total; i++) await busy.until("Z");
      expect(value(await late.query("SELECT count(*) FROM socket_turns"))).toBe(String(total + 1));
    } finally {
      busy.socket.destroy();
      late.socket.destroy();
    }
  });
}, 30000);

test("a readable spooled result survives another client's native execution beyond the drain deadline", async () => {
  await database("transaction", async (server) => {
    const a = await wire(server.port);
    const b = await wire(server.port);
    try {
      a.write(query("SELECT repeat('x',1048576) FROM generate_series(1,70)"));
      // Start the competing native execution only after A has received a real
      // row, while the rest of its large result is still being delivered.
      const prefix = await a.until("D");
      b.write(query("SELECT pg_sleep(31)"));
      const receiving = a.until("Z", 90000);
      const sleeping = b.until("Z", 90000);
      const response = [...prefix, ...(await receiving)];
      expect(error(response)).toBeUndefined();
      const rows = response.filter((p) => p[0] === 68);
      expect(rows).toHaveLength(70);
      expect(rows.reduce((sum, p) => sum + p.readInt32BE(7), 0)).toBe(70 * 1048576);
      expect(state(await sleeping)).toBe("I");
      expect(value(await a.query("SELECT 51"))).toBe("51");
    } finally {
      a.socket.destroy();
      b.socket.destroy();
    }
  });
}, 120000);

test("pipelined messages and Terminate wait for the prior complete spooled result", async () => {
  await database("transaction", async (server) => {
    const a = await wire(server.port);
    try {
      a.write(
        query("SELECT repeat('x',1048576) FROM generate_series(1,70)"),
        query("SELECT 53"),
        packet("X"),
      );
      a.socket.end();
      const response = await a.until("Z");
      expect(error(response)).toBeUndefined();
      expect(response.filter((p) => p[0] === 68)).toHaveLength(70);
      expect(value(await a.until("Z"))).toBe("53");
      expect(server.running).toBe(true);
    } finally {
      a.socket.destroy();
    }
  });
}, 60000);

test("output allocation failure refuses only that frontend before native execution", async () => {
  const files = pgliteOutputFiles();
  let id = 0;
  try {
    await observedPool(
      async (port) => {
        await expect(wire(port)).rejects.toThrow("Socket closed before response");
        const healthy = await wire(port);
        try {
          expect(value(await healthy.query("SELECT 54"))).toBe("54");
        } finally {
          healthy.socket.destroy();
        }
      },
      async () => {
        const request = ++id;
        if (request === 1) throw Error("ENOSPC: injected output allocation failure");
        const fd = await files.allocate(request);
        return { fd, release: () => files.release(request) };
      },
    );
  } finally {
    await files.close();
  }
});
