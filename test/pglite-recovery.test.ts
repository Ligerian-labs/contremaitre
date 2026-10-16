import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context } from "@contremaitre/execution/context";
import { parseManifest } from "@contremaitre/projects/config";
import { SQL } from "bun";
import { lockPgliteData } from "../packages/environments/src/pglite-data.js";
import { PGliteRuntime } from "../packages/environments/src/pglite-runtime.js";
import * as pgliteServer from "../packages/environments/src/pglite-server.js";
import { startPglite } from "../packages/environments/src/pglite-server.js";
import { terminatePgliteWorker } from "../packages/environments/src/pglite-worker-lifecycle.js";
import { checkPgliteCleanup } from "./fixtures/pglite-resources/monitor.js";
import { freePort } from "./ports.js";

checkPgliteCleanup();

const directory = () => mkdtemp(join(tmpdir(), "cm-pglite-recovery-"));

test("V2-F2: first and subsequent sessions retain app identity after RESET ROLE and own their tables", async () => {
  const root = await directory();
  const server = await startPglite({ dataDir: join(root, "db"), port: await freePort() });
  try {
    for (const name of ["first_table", "second_table"]) {
      const sql = new SQL(server.url(), { max: 1, prepare: false });
      try {
        expect((await sql.unsafe("SELECT session_user AS s, current_user AS c"))[0]).toEqual({
          s: "app",
          c: "app",
        });
        await sql.unsafe(`RESET ROLE; CREATE TABLE ${name} (id int)`);
        expect(
          (await sql.unsafe(`SELECT tableowner FROM pg_tables WHERE tablename='${name}'`))[0]
            .tableowner,
        ).toBe("app");
      } finally {
        await sql.close();
      }
    }
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("V2-F4: a published database removes stale initialization staging without resetting data", async () => {
  const root = await directory();
  const dataDir = join(root, "db");
  const port = await freePort();
  let server = await startPglite({ dataDir, port });
  try {
    const sql = new SQL(server.url(), { max: 1 });
    await sql`CREATE TABLE preserved AS SELECT 42 AS id`;
    await sql.close();
    await server.stop();
    await mkdir(`${dataDir}.pglite-init`);
    await writeFile(join(`${dataDir}.pglite-init`, "PG_VERSION"), "partial");
    server = await startPglite({ dataDir, port });
    expect(existsSync(`${dataDir}.pglite-init`)).toBe(false);
    const check = new SQL(server.url(), { max: 1 });
    try {
      expect((await check`SELECT id FROM preserved`)[0].id).toBe(42);
    } finally {
      await check.close();
    }
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["failure", "timeout"])
  test(`V2-F3: reset ${mode} terminates the worker, cleans sockets and permits direct restart`, async () => {
    const root = await directory();
    const dataDir = join(root, "db");
    const port = await freePort();
    let worker: Worker | undefined;
    let socketDirectory = "";
    const logs: string[] = [];
    let server = await startPglite({
      dataDir,
      port,
      log: (line) => logs.push(line),
      createWorker: () => {
        worker = new Worker(
          new URL("./fixtures/pglite-compiled/lifecycle-worker.ts", import.meta.url),
        );
        worker.addEventListener("message", (event: MessageEvent) => {
          if (event.data.socketDirectory) socketDirectory = event.data.socketDirectory;
        });
        return worker;
      },
    });
    try {
      worker?.postMessage({ type: `inject-reset-${mode}` });
      const deadline = Date.now() + 6000;
      while (server.running && Date.now() < deadline) await Bun.sleep(10);
      expect(server.running).toBe(false);
      // stop must await automatic termination, without replaying the reset error.
      await server.stop();
      expect(
        logs.some((line) =>
          line.includes(
            mode === "failure" ? "injected session reset failure" : "session reset timed out",
          ),
        ),
      ).toBe(true);
      expect(socketDirectory).not.toBe("");
      expect(existsSync(socketDirectory)).toBe(false);
      server = await startPglite({ dataDir, port });
      const sql = new SQL(server.url(), { max: 1 });
      try {
        expect((await sql`SELECT 1 AS n`)[0].n).toBe(1);
      } finally {
        await sql.close();
      }
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);

test("V2-F5: the directory lock remains held until the actual worker close event", async () => {
  const root = await directory();
  const dataDir = join(root, "db");
  const unlock = await lockPgliteData(dataDir);
  const worker = new Worker(new URL("./fixtures/pglite-compiled/idle-worker.ts", import.meta.url));
  let didExit = false;
  const exited = new Promise<void>((resolve) =>
    worker.addEventListener(
      "close",
      () => {
        didExit = true;
        resolve();
      },
      { once: true },
    ),
  );
  await new Promise<void>((resolve) =>
    worker.addEventListener("message", () => resolve(), { once: true }),
  );
  const released: boolean[] = [];
  const termination = terminatePgliteWorker(
    {
      terminate: () => {
        setTimeout(() => worker.terminate(), 150);
      },
    },
    exited,
    async () => {
      released.push(didExit);
      await unlock();
    },
  );
  try {
    await Bun.sleep(30);
    expect(didExit).toBe(false);
    await expect(lockPgliteData(dataDir)).rejects.toThrow("locked");
    await termination;
    expect(released).toEqual([true]);
    const reacquired = await lockPgliteData(dataDir);
    await reacquired();
  } finally {
    worker.terminate();
    await termination;
    await rm(root, { recursive: true, force: true });
  }
});

test("V2-F3: Runtime.start directly awaits failed worker teardown and restarts its database", async () => {
  const root = await directory();
  const runtime = new PGliteRuntime({ home: root });
  const ctx = context();
  const envFile = join(root, "env");
  const port = await freePort();
  await writeFile(envFile, "POSTGRES_USER=app\nPOSTGRES_DB=app\nPOSTGRES_PASSWORD=test\n");
  let worker: Worker | undefined;
  const original = pgliteServer.startPglite;
  const launch = spyOn(pgliteServer, "startPglite").mockImplementationOnce((options) =>
    original({
      ...options,
      createWorker: () => {
        worker = new Worker(
          new URL("./fixtures/pglite-compiled/lifecycle-worker.ts", import.meta.url),
        );
        return worker;
      },
    }),
  );
  try {
    await runtime.run(ctx, {
      name: "db",
      image: "",
      network: "",
      volumes: {},
      envFile,
      data: join(root, "db"),
      ports: { "5432": port },
      service: parseManifest(
        "version: 1\nproject: test\nservices:\n  db: {kind: postgres, runtime: wasm}\n",
      ).services.db,
    });
    launch.mockRestore();
    worker?.postMessage({ type: "inject-reset-failure" });
    const deadline = Date.now() + 3000;
    while ((await runtime.inspect(ctx, "db"))?.Running && Date.now() < deadline) await Bun.sleep(5);
    expect((await runtime.inspect(ctx, "db"))?.Running).toBe(false);
    await runtime.start(ctx, "db");
    const sql = new SQL(`postgresql://app:test@127.0.0.1:${port}/app?sslmode=disable`, { max: 1 });
    try {
      expect((await sql`SELECT 42 AS n`)[0].n).toBe(42);
    } finally {
      await sql.close();
    }
  } finally {
    launch.mockRestore();
    await runtime.remove(ctx, "db");
    await rm(root, { recursive: true, force: true });
  }
});

test("clean shutdown with a retained client does not arm the session reset watchdog", async () => {
  const root = await directory();
  const logs: string[] = [];
  const server = await startPglite({
    dataDir: join(root, "db"),
    port: await freePort(),
    log: (line) => logs.push(line),
    createWorker: () =>
      new Worker(new URL("./fixtures/pglite-compiled/lifecycle-worker.ts", import.meta.url)),
  });
  const sql = new SQL(server.url(), { max: 1 });
  try {
    await sql`SELECT 1`;
    // This worker delays its stopped acknowledgement past the reset deadline.
    await server.stop();
    expect(logs.some((line) => line.includes("session reset timed out"))).toBe(false);
    expect(logs.some((line) => line.includes("PGlite stopped; data retained"))).toBe(true);
  } finally {
    await sql.close({ timeout: 0 });
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
