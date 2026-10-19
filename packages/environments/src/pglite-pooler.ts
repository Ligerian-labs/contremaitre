import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { context } from "@contremaitre/execution/context";
import { reapProcesses, trackProcess } from "@contremaitre/execution/process-journal";
import { waitPgliteReady } from "./pglite-ready.js";

const directory = (dataDir: string) => `${dataDir}.pgbouncer`;

export function checkPglitePooler(): string {
  const binary = Bun.which("pgbouncer");
  if (!binary) throw Error("Transaction pooling requires PgBouncer 1.26+ on the hub's PATH");
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
  const match = /^PgBouncer (\d+)\.(\d+)/m.exec(version.stdout);
  if (
    version.status !== 0 ||
    !match ||
    Number(match[1]) < 1 ||
    (Number(match[1]) === 1 && Number(match[2]) < 26)
  )
    throw Error("Transaction pooling requires PgBouncer 1.26 or newer");
  return binary;
}

/** Called under the database ownership lock, including when switching back to session mode. */
export async function recoverPglitePooler(dataDir: string): Promise<void> {
  await reapProcesses(context(), directory(dataDir));
  await rm(directory(dataDir), { recursive: true, force: true });
}

export async function startPglitePooler(options: {
  dataDir: string;
  socketDirectory: string;
  port: number;
  signal?: AbortSignal;
  log: (text: string) => void;
  failed: (message: string) => void;
}): Promise<{ stop(): Promise<void> }> {
  const binary = checkPglitePooler();
  const root = directory(options.dataDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const config = join(root, "pgbouncer.ini");
  await writeFile(join(root, "users.txt"), '"app" ""\n', { mode: 0o600 });
  await writeFile(
    config,
    `[databases]
app = host=${options.socketDirectory} port=5432 dbname=app user=app
[pgbouncer]
listen_addr = 127.0.0.1
listen_port = ${options.port}
unix_socket_dir =
auth_type = trust
auth_file = users.txt
pool_mode = transaction
default_pool_size = 1
reserve_pool_size = 0
max_db_connections = 1
max_client_conn = 128
max_prepared_statements = 100
server_reset_query = DISCARD ALL
server_reset_query_always = 1
query_wait_timeout = 30
idle_transaction_timeout = 30
server_connect_timeout = 5
client_tls_sslmode = disable
server_tls_sslmode = disable
log_connections = 0
log_disconnections = 0
`,
    { mode: 0o600 },
  );
  const child = spawn(binary, [config], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const failure = new AbortController();
  let stopping = false;
  let started = false;
  let exited = false;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const onFailure = (message: string) => {
    failure.abort(Error(message));
    if (started && !stopping) options.failed(message);
  };
  child.once("error", (error) => onFailure(`PgBouncer failed: ${error.message}`));
  child.once("exit", (code, signal) => {
    exited = true;
    onFailure(`PgBouncer exited (${signal ?? code})`);
  });
  child.stdout?.on("data", (chunk) => options.log(String(chunk)));
  child.stderr?.on("data", (chunk) => options.log(String(chunk)));
  let untrack = () => {};
  let stopped: Promise<void> | undefined;
  const waitClosed = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        closed.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const stop = () => {
    stopped ??= (async () => {
      stopping = true;
      if (!exited) child.kill("SIGINT");
      if (!(await waitClosed())) {
        if (!exited) child.kill("SIGKILL");
        if (!(await waitClosed()))
          throw Error("PgBouncer termination timed out; ownership retained");
      }
      untrack();
      await rm(root, { recursive: true, force: true });
    })();
    return stopped;
  };
  try {
    if (child.pid) untrack = trackProcess(root, child.pid, randomUUID());
    await waitPgliteReady(`postgresql://app@127.0.0.1:${options.port}/app?sslmode=disable`, {
      timeout: 5000,
      signal: AbortSignal.any([failure.signal, ...(options.signal ? [options.signal] : [])]),
    });
    failure.signal.throwIfAborted();
    started = true;
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
