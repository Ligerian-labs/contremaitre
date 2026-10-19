# WebAssembly runtime

Contremaitre can run application servers and managed Postgres through `runtime: wasm`. Each branch keeps its own application processes, database directory, assigned loopback ports and HTTP routes. The hub, compilers and optional connection pooler run on the host.

This guide covers the complete stack. The [app backend guide](wasm-backend.md) defines the artifact and process contract. The [Postgres guide](wasm-postgres.md) defines storage, wire-protocol behavior, pooling and database forks.

## Choose an engine

| Service | Implementation | Application contract |
| --- | --- | --- |
| App with no `wasm.engine` | `wasmtime serve` | A WASI HTTP component exporting `wasi:http/proxy` |
| App with `wasm.engine: wasmer` | Wasmer 7.5+ | A self-contained WASIX WEBC package whose server honors `HOST` and `PORT` |
| `kind: postgres`, `runtime: wasm` | PGlite 0.5.10 in a Bun worker | Postgres wire protocol, managed role `app` and database `app` |
| Postgres with `postgres.pooling: transaction` | PGlite plus PgBouncer 1.26+ | Multiple client connections sharing one database session at transaction boundaries |

Wasmtime's HTTP component contract does not grant raw TCP sockets. WASIX grants host networking, allowing a Node-compatible server to listen on TCP and connect to Postgres. Choose the engine that matches the artifact you build.

For JavaScript servers, the tested package is Edge.js QuickJS 0.2.5. Both its Node compatibility runtime and JavaScript engine execute inside Wasm. The application must work with that compatibility layer; native addons and arbitrary Node APIs are not guaranteed. Contremaitre does not enable Wasmer's host N-API mode. Browser JavaScript still runs in the browser.

PgBouncer is a native host helper. Selecting a Wasm database does not mean every orchestration process is a Wasm module. PGlite executes the database engine inside Wasm, while the Bun worker owns its lifecycle and filesystem access.

## Prerequisites

The supported host remains an Apple silicon Mac running macOS 26 or newer. Put the selected tools on the hub's `PATH` before starting it:

| Tool | Required for |
| --- | --- |
| Contremaitre build containing these features | All Wasm services |
| Wasmtime, tested with version 49 | WASI HTTP apps |
| Wasmer 7.5.0 or newer | WASIX packages |
| PgBouncer 1.26 or newer | Postgres transaction pooling |
| Application compiler and package manager | `wasm.build` commands on the host |

PGlite and its `pgcrypto` assets are embedded in the compiled CLI. A separate Postgres installation is unnecessary for the preview database. Redis requires the Apple backend.

For WASIX on Apple silicon, a private Wasmer installation can be prepared with:

```sh
mkdir -p "$HOME/.cache/contremaitre/wasmer-7.5.0"
curl -fsSL https://github.com/wasmerio/wasmer/releases/download/v7.5.0/wasmer-darwin-arm64.tar.gz | tar -xz -C "$HOME/.cache/contremaitre/wasmer-7.5.0"
export PATH="$HOME/.cache/contremaitre/wasmer-7.5.0/bin:$PATH"
brew install pgbouncer
```

To build Contremaitre from this checkout, use Bun 1.4.2:

```sh
bun install --frozen-lockfile
bun run build
./bin/contremaitre --version
```

Put this checkout's `bin` directory on `PATH` before entering the application repository. The running hub must use the same build. Installing a new CLI does not change the executable of an already running hub. See [hub upgrades](reference.md#typescript-migration-and-rollback).

## Declare the stack

An application owns its packaging command. This example assumes that `scripts/package-api.mjs` produces `dist/api.webc`:

```yaml
version: 1
project: example
services:
  db:
    kind: postgres
    runtime: wasm
    postgres:
      pooling: transaction
  api:
    runtime: wasm
    wasm:
      engine: wasmer
      build: [node, scripts/package-api.mjs]
      component: dist/api.webc
    port: 3000
    http: true
    depends_on: [db]
    environment:
      DATABASE_URL: '{{db.url}}'
```

Contremaitre runs the build on the host and snapshots its output. A WEBC package must include its entrypoint, runtime module, JavaScript and required filesystem assets. Package the runtime itself to avoid resolving registry dependencies during startup or recovery. Bigatelier's [Wasm implementation](https://github.com/Ligerian-labs/bigatelier/pull/79) includes a complete application packager.

`port: 3000` identifies the service. Contremaitre reserves an available loopback port and injects `HOST=127.0.0.1` and the actual `PORT`, overriding manifest values for those keys. Bind the server to those values. Use `{{db.url}}` and other service references instead of hard-coded host ports.

WASIX variables come from declared service configuration through a private mode-0600 environment file. Values stay out of command-line arguments, and the runtime disables ambient host-environment forwarding. A package sees its packaged files; Contremaitre mounts no host source directories into the guest.

The generic artifact field remains `wasm.component`, including when it points to a `.webc` package. WASM app services reject container commands, images, `ready`, `init` and `migrate`. The runtime provides no guest `exec` facility. Run database migrations at application startup. See [all accepted manifest fields](reference.md#service-runtime).

## Database pooling

| Mode | Connection ownership | Application requirements |
| --- | --- | --- |
| `session`, the default | One client keeps PGlite until disconnect, even while idle | Pool size one; another retained pool or readiness connection can be blocked |
| `transaction` | PgBouncer keeps one backend and schedules clients at transaction boundaries | Ordinary pools are allowed; do not depend on session state across transactions |

Transaction pooling addresses retained client connections. It does not create concurrent Postgres sessions. A transaction that waits for another transaction to run will stall. Keep transactions short, use `SET LOCAL` and transaction-level advisory locks, and run tests requiring overlapping transactions against ordinary Postgres.

PgBouncer tracks protocol-level prepared statements. SQL-level `PREPARE`, temporary objects, `LISTEN` and session locks must not span transaction boundaries. The runtime uses a standalone `DISCARD ALL` to reset the backend before reuse. Pool limits, queue deadlines and identity handling are in the [transaction-pooling contract](wasm-postgres.md#transaction-pooling).

Framework resource ownership still matters. Construct shared application services once under the server's lifetime. Building a new resource Layer per request creates additional pools and finalizers even when a database pooler can accept them. Bigatelier provides HTTP, MCP, migrations and background work through one static Effect Layer graph.

## Start and verify

Use a fresh hub home when trying the Wasm backend alongside existing container environments. A recorded service cannot change its runtime in place. Existing Apple database files are not imported into PGlite automatically.

From the application repository, after installing its build dependencies:

```sh
export CONTREMAITRE_HOME="$HOME/.local/share/contremaitre-wasm"
contremaitre start --http --http-port 8080 --json
contremaitre ensure --http --http-port 8080 --main --json
contremaitre verify --profile smoke --json
contremaitre report --json
```

This example uses HTTP and a separate home. Use the same home and routing options on later `ensure` commands. `--main` designates the initial clone source; omit it when deploying another branch. The normal [local HTTPS setup](local-https.md) also works with Wasm services.

Verification profiles are application-owned. Define checks without `service:` so they run on the host and use `CONTREMAITRE_URLS`. A check selecting a Wasm service cannot run inside a container. Readiness alone does not verify application behavior. See [verification configuration](agent-workflow.md#check-configuration).

Run `ensure` after source changes, then verify again. Without `dev.source`, packages use an explicit rebuild/deploy cycle. With `dev.source`, the app backend watches the source directory in place and rebuilds the artifact; exclude generated output to avoid rebuild loops.

## Lifecycle and forks

| Event | Application processes | Database and pooler |
| --- | --- | --- |
| Successful redeploy | Replace the snapshot on the assigned port | Reuse retained database data |
| Build failure | Keep the previous process serving | Keep retained data |
| New artifact fails to start | Restore the previous snapshot | Keep retained data |
| `contremaitre down` | Stop this environment and remove app runtime records | Stop worker and pooler, retain database data |
| `contremaitre stop` | Stop all environments and shut down the hub | Stop workers and poolers, retain data |
| Hub signal or crash | Reattach surviving detached processes on startup; restart missing ones | Reopen retained PGlite data and reclaim recorded pooler processes before binding their ports |
| First deployment of a branch | Start the target's application packages | Pause source writers, stop databases and poolers, copy database data, then restart independently |

On APFS, database forks use `clonefile`; unsupported filesystems fall back to a full copy. Forking requires a quiesced database. The target receives its own worker, pooler and loopback address. The pooler's configuration and process records stay outside the copied database directory.

Only explicit data deletion removes retained database data. See [publication, recovery and fork guarantees](wasm-postgres.md#data-and-forks).

## Diagnose a problem

```sh
contremaitre logs api
contremaitre logs db
contremaitre diagnose --run OPERATION_ID --json
contremaitre report --json
```

Use the operation ID returned by a failed `ensure` or `verify`. Replace service names with those in the manifest.

| Symptom | Check |
| --- | --- |
| Missing or unsupported Wasmer/PgBouncer | Check versions and the running hub's `PATH`, then restart the hub with those tools available |
| SQLSTATE `53300`, pool-size-one message | The database is in session mode; select transaction pooling or close competing clients |
| Query waits while another transaction is open | The backend has one session; remove the cross-transaction wait |
| Frontend loads but calls a production API | Inspect browser build configuration and route requests through the preview's own API proxy |
| Changes do not appear | Run `ensure`; inspect build logs and source freshness in `report` |
| Source changed during deployment | Wait for edits/build generators to finish, then rerun `ensure` |
| Pooler failed or database marked stopped | Read database logs; `ensure` can reopen retained data after teardown |

The local database listener trusts local processes and does not validate the generated password. WASIX guests have host network access. CPU and memory limits are not enforced by either Wasm app engine. These are local development environments, not a production isolation boundary.

The app runtime exposes no persistent host volume to the guest. Package snapshots preserve build artifacts; they do not provide persistence for application-created files. Keep durable data in Postgres or an explicit external store.

## Implementation map

| Source | Ownership |
| --- | --- |
| [Project schema](../packages/projects/src/model.ts), [validation](../packages/projects/src/config.ts) | Runtime, engine and pooling settings; incompatible combinations |
| [Environment manager](../packages/environments/src/manager.ts) | Dependencies, per-runtime preflight, assigned ports, deployment and clone orchestration |
| [App supervisor](../packages/environments/src/wasmtime.ts) | Both Wasmtime and Wasmer, artifact snapshots, process records, logs and recovery |
| [PGlite runtime](../packages/environments/src/pglite-runtime.ts) | Managed database service lifecycle, readiness and clone dispatch |
| [PGlite owner](../packages/environments/src/pglite-server.ts), [worker](../packages/environments/src/pglite-worker.ts) | Database lock, worker lifetime, sockets, session reset and failure cleanup |
| [Pooler helper](../packages/environments/src/pglite-pooler.ts) | PgBouncer configuration, process journal, startup, termination and stale-process recovery |

The app supervisor retains its historical `wasmtime.ts` name for both engines. PGlite's worker is a separate compilation entrypoint so the standalone CLI can create it without a source checkout.

## Recorded verification and developer checks

On 2026-10-19, Bigatelier's API, public Angular SSR server, admin server and managed Postgres ran on this backend. The application checks verified guest identity as `wasi/wasm32`, admin sign-in, twelve concurrent protected HTTP/MCP admin reads, passkey challenge creation, and synthetic enrollment creation with public/admin readback. APFS fork isolation and hub SIGKILL recovery also passed. Email, payment and calendar integrations used logging adapters. Creating a passkey challenge does not establish that an authenticator registration or sign-in completed.

The permanent scenarios include `wasix/host-http`, `postgres/transaction-pooling` and `postgres/pgcrypto`. The app backend test also restarts a packaged application after removing its source checkout. The pooling tests cover transaction pinning, session isolation, disconnect rollback and pooler failures.

From the Contremaitre checkout, install Wasmtime, PgBouncer, Wasmer and the Rust WASI target, then prepare the pinned WASIX fixture runtime:

```sh
brew install wasmtime pgbouncer
rustup target add wasm32-wasip2
export CONTREMAITRE_WASIX_CACHE="$HOME/.cache/contremaitre-wasix-tests"
bun scripts/prepare-wasix-tests.ts
export CONTREMAITRE_WASIX_RUNTIME="$CONTREMAITRE_WASIX_CACHE/runtime"
CONTREMAITRE_REQUIRE_WASMTIME=1 CONTREMAITRE_REQUIRE_WASMER=1 CONTREMAITRE_REQUIRE_PGBOUNCER=1 bun run check
```

The require flags turn missing integrations into failures. Without them, tests for unavailable external engines can be skipped. See [contributing](../CONTRIBUTING.md) for the full development setup.
