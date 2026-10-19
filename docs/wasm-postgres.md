# Postgres with PGlite

PGlite runs Postgres in a Bun worker and serves the Postgres wire protocol through a stable loopback activation listener. The backend suspends after 60 seconds without open client connections and wakes on a new connection; set service-level `idle_timeout_seconds: 0` to keep it running. The database needs no container or separate Postgres installation. WASM-only environments make no Apple container calls, including hub startup and network cleanup.

The runtime is selected by `runtime: wasm`; see the [service runtime reference](reference.md#service-runtime).

The [complete Wasm runtime guide](wasm-runtime.md) explains application packaging, engine selection and setup alongside this database backend.

## Setup

Declare a managed Postgres service without an image:

```yaml
version: 1
project: example
services:
  db:
    kind: postgres
    runtime: wasm
```

Contremaitre reserves the port. Applications use `{{db.url}}` through the normal environment reference and declare `depends_on: [db]`. The URL is `postgresql://app:<generated-password>@127.0.0.1:<reserved-port>/app?sslmode=disable`. The runtime creates the `app` role and `app` database on first initialization.

Apple container services cannot depend on WASM services because container loopback cannot reach the host listener. Give the application a compatible host runtime. Manifest validation rejects this dependency.

Managed databases reject `init`, `migrate`, custom commands, environment overrides and volumes with the existing message `managed databases cannot override storage, credentials, command or initialization`. Run migrations from the application using its ordinary database client. Runtime task commands and builds are also rejected explicitly.

## Connections and limits

The default `postgres.pooling: session` mode requires an application pool size of **1**. One connection occupies the database until it disconnects, including while idle. A connection arriving while the slot is occupied waits up to two seconds for it to become available. After that deadline it receives a PostgreSQL fatal error with SQLSTATE `53300` and the exact message `PGlite allows one connection; use pool size 1`. Configure the client connection timeout above two seconds if it needs to receive that server error. Before admitting the next client, the runtime rolls back any open transaction and runs `DISCARD ALL`, clearing prepared statements, session settings, temporary objects, listeners and advisory locks. Readiness also needs a connection, so an application's retained connection can make a readiness probe fail.

In session mode the loopback server accepts **any password, user and database name**. Every connection maps to the single `app` role and `app` database regardless of the names in the URL. Transaction mode accepts role `app` and database `app` with any password. The URL carries the generated password for compatibility with managed Postgres configuration, but the PGlite wire layer does not authenticate it. Any local process that can reach the port can access the database. Binding is restricted to `127.0.0.1`; TLS is disabled. This runtime is for local environments.

The runtime bundles PGlite's `pgcrypto` extension. Applications can install it with `CREATE EXTENSION IF NOT EXISTS pgcrypto`, including in startup migrations. Other extensions must already be available in the base PGlite filesystem; the server does not load extension peer packages or arbitrary native Postgres extensions. PGlite is a single-session Postgres build; tools that require overlapping transactions, backend processes or query cancellation may not work. The socket package ignores PostgreSQL cancellation requests, so a client timeout does not reliably cancel an executing query.

`COPY FROM STDIN` accepts a single simple-query COPY statement, including `psql \copy`. Input above 64 MiB receives SQLSTATE `54000`, `PGlite COPY input exceeds 64 MiB`, followed by ReadyForQuery. Postgres raises these errors itself: an explicit transaction becomes failed (`E`), and `COMMIT` rolls it back. Outside a transaction the connection remains usable. Input is buffered up to 64 MiB and passed to Postgres only after `CopyDone`; disconnecting discards unfinished input before rollback and session reset. Extended-protocol COPY input and COPY input mixed with other statements are rejected with SQLSTATE `0A000` and `PGlite COPY input requires a single simple-query COPY statement`. COPY output remains supported. A reset error or a reset exceeding 2.5 seconds marks the server stopped and terminates its worker. Starting it again waits for teardown and reopens the retained data.

Each database has its own worker, keeping synchronous WASM execution off the hub's event loop. Its internal Unix socket lives in a temporary directory created with mode 0700, removed on stop and startup failure. Readiness requires a successful `SELECT 1` through an ordinary SQL client, with a deadline and cancellation. A listening TCP socket alone is insufficient.

## Transaction pooling

To use ordinary application pools, install PgBouncer 1.26 or newer on the hub's PATH, then opt in:

```yaml
services:
  db:
    kind: postgres
    runtime: wasm
    postgres:
      pooling: transaction
```

On macOS, `brew install pgbouncer` supplies the helper. Only this mode requires it. Contremaitre starts a native host PgBouncer process for each database. PGlite remains the Wasm database engine. The worker exposes its managed connection through a private Unix socket, and PgBouncer listens on a private backend TCP port behind the activation listener. Applications keep using `{{db.url}}`; their pools can retain multiple idle connections without monopolizing PGlite.

PgBouncer admits up to 128 clients and uses exactly one backend connection, with no reserve connections. It pins that connection until the transaction commits or rolls back. Other work queues for up to 30 seconds; an idle transaction is disconnected after 30 seconds. Protocol-level prepared statements are tracked with a cache of 100 server statements. A standalone `DISCARD ALL` resets the backend after every transaction. PgBouncer restores tracked parameters, including session authorization, before reuse.

This mode serializes transactions. Two transactions cannot make progress at once, so code that holds one transaction while waiting for a second transaction will stall. Session settings, temporary objects, `LISTEN`, session advisory locks and SQL-level `PREPARE` must not span transaction boundaries. Use `SET LOCAL` and transaction-level advisory locks inside explicit transactions. These restrictions follow [PgBouncer's transaction-pooling contract](https://www.pgbouncer.org/features.html).

The private `<service-data>.pgbouncer` sibling contains configuration, the local trust user list and process ownership records. Contremaitre removes these after stopping the pooler. A pooler failure marks the database stopped and terminates its worker. Starting the database reaps a pooler left by an interrupted hub before binding its port, while holding the database ownership lock. Forks stop the pooler and worker, copy only database data, then start independent poolers for source and target.

## Data and forks

First initialization builds initdb, role `app` and database `app` in a private `.pglite-init` sibling. After clean close, a synced completion marker allows atomic publication over the Manager's empty service directory. An interrupted, incomplete staging tree is rebuilt on the next start. A completed staging tree is published intact. A nonempty published directory causes stale initialization staging to be removed while the data lock is held. Nonempty published directories are never reset, including older databases without the completion marker; corruption is reported rather than silently deleting user data.

The runtime uses the private service directory supplied by Contremaitre, `<home>/data/<environment-id>/.services/<service>`. Stop, start, redeploy and runtime removal retain this directory. Only an explicit data deletion request removes it. The runtime's `remove` method stops the server and forgets its restart state, without deleting data.

A kernel advisory lock held on an open sibling `.pglite-lock` file prevents two workers from opening the same directory, including two workers in one process. Clean shutdown closes client connections, closes PGlite to flush data, and closes the lock descriptor. The kernel releases ownership if the hub crashes or is killed. The empty lock file stays in place; its existence does not indicate ownership. Do not unlink it while a runtime may be using it.

In session mode, close external database clients and GUI tools before creating a branch environment. If an external client holds or immediately reclaims the single connection while the source database restarts, readiness can time out and the fork can fail.

Before a fork, Contremaitre pauses application writers and stops both databases. The helper can alternatively call a `quiesce` hook that stops the source and returns an async restart hook. It invokes that restart hook after copying, including when copying fails. Callers must make writer shutdown and restart safe if quiescing itself fails before returning the hook.

On APFS, the runtime calls `clonefile(2)` with `CLONE_NOFOLLOW` to clone the quiesced directory. The files initially share storage, and later writes remain isolated. `ENOTSUP` and `EXDEV` fall back to `copyTree` and report a full copy. macOS `cp -c` silently copies on HFS+, so its exit status cannot identify a clone. Other copy failures remain errors. Symlinks and special files are rejected. Tests can force the full-copy path through an option.

The runtime copies into a temporary sibling and publishes the completed directory by rename. Replacing an existing stopped target uses an atomic directory exchange. A failure before publication preserves the previous target. Both source and target are locked during the copy. Atomic replacement uses macOS `renameatx_np` or Linux `renameat2` where supported. If exchange is unsupported (including HFS+), publication renames the old target to a `.pglite-previous` sibling, syncs the parent, renames the completed copy into place, syncs again, and removes the backup. The target name is briefly absent between those renames; both services remain stopped and locked. Failure restores the old target. After a crash, the next start or fork restores the backup if the target lacks `PG_VERSION` (including an empty directory or Finder metadata), or keeps the published database and removes the backup. Recovery also removes abandoned `.fork-*` copy siblings under the data lock. This fallback is recoverable rather than an atomic exchange.

PGlite output is retained in a bounded, private `<service-data>.pglite-log` sibling inside the environment’s `.services` directory. Records retain complete lines within 64 KiB. A malformed or empty log is moved to `.pglite-log.corrupt` (replacing the previous copy), and a fresh log records the recovery; it does not prevent the database from starting. Explicit environment data deletion removes these logs as well. `contremaitre logs db` reads these files even from a fresh CLI process and after a hub restart. Readiness follows from a cursor captured before the current launch, showing its startup output without replaying earlier runs. Runtime output is batched for up to 100 ms and written asynchronously without per-line fsync; startup and stop flush pending output. A crash may lose the last buffered log lines. Byte positions and a file generation prevent history replay when the retained tail rotates.

## Compiled executable

The runtime embeds `pglite.wasm`, `initdb.wasm`, `pglite.data` and `pgcrypto.tar.gz` using Bun file imports. It passes the core assets explicitly as `pgliteWasmModule`, `initdbWasmModule` and `fsBundle`. PGlite reads extension archives through filesystem streams, so the worker writes the embedded archive to a private temporary directory while opening the database, then removes it after loading or failure. It does not load those assets from an installed `node_modules` directory at runtime.

Bun 1.4.2 requires the worker as an explicit additional compilation entrypoint. The CLI build includes `packages/environments/src/pglite-worker.ts` beside `apps/cli/src/cli.ts`. The standalone fixture in `test/fixtures/pglite-compiled/main.ts` compiles with that entrypoint and proves startup, a query as `app` in database `app`, installation and use of `pgcrypto`, and shutdown from an isolated temporary directory. The `postgres/pgcrypto` fixture scenario in `test/pglite-extensions.test.ts` deploys through the real hub and verifies extension use after a database restart. The real Manager tests cover deployment, forks and data deletion.

Run the focused checks with the repository's Bun version:

```sh
bun install --frozen-lockfile
bun run test test/pglite*.test.ts
```

The dependency pins are PGlite `0.5.10` and pglite-socket `0.2.13`, whose PGlite peer requires exactly `0.5.10`. The socket package declares seven extension peers as required, so Bun resolves them transitively. No extension peers are added directly, enabled, or embedded by this runtime.

The systematic COPY regression matrix is `test/pglite-copy-matrix.test.ts`: 48 cells cover simple/extended protocol, autocommit/explicit transactions, text/CSV/binary loads, bad rows, partial-input disconnects, the size cap, unsupported forms, and non-COPY SQL containing COPY-looking identifiers or text. Extended COPY input is rejected at Parse, before any format, row, size or disconnect scenario can begin; those cells assert `0A000` rather than emulate a transfer. The simple-query cap is a deliberate local limit that ordinary Postgres does not impose. All rejections go through Postgres and abort an explicit transaction. After disconnect there is no observable ReadyForQuery or COMMIT; the next client must see idle status and no partial rows. The matrix also runs `psql \copy` and a single-transaction dump-file restore when psql is installed.

The adapter sends CopyInResponse before Postgres validates a buffered COPY statement. Missing-table or invalid-option errors therefore arrive after CopyDone (or CopyFail), rather than before data transfer; the same Postgres SQLSTATE and transaction rollback semantics apply. Streaming is still bounded by the input cap. The adapter does not execute a trial COPY to validate it because that would consume input or alter transaction state. The `0A000` and `54000` rejections include a PL/pgSQL `CONTEXT: … inline_code_block … RAISE` because Postgres raises them server-side.
