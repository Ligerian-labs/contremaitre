# Workspace layout

Contremaitre is one executable built from seven private Bun workspaces. Run all
build, test, and install commands from the repository root.

| Workspace | Owns |
| --- | --- |
| `apps/cli` | Command parsing, terminal output, hub client, and executable entry point |
| `packages/projects` | Manifest validation, repository discovery, git/jj workspace identity, and project initialization |
| `packages/environments` | Deployment, main-data cloning, environment state, native container and project-driver adapters, and tunnel reservations |
| `packages/operations` | Durable operation records and logs, scheduling, deduplication, cancellation, and operation retention |
| `packages/routing` | HTTP/WebSocket forwarding and TCP proxies |
| `packages/hub` | Structure command/query handlers, Unix API, startup, recovery, and shutdown composition |
| `packages/execution` | Subprocess execution and recovery, cancellation context, locks, and private filesystem writes |

`projects` owns its manifest and identity model. `environments` owns its persisted
state model and deployment request contract. Tunnel reservations remain part of
that environment state and its atomic save. `operations` has its own records and
persistence. `execution` is supporting infrastructure and has no domain dependency.

The package dependency direction is:

```text
cli          -> hub, environments, projects, operations, routing, execution
hub          -> environments, operations, routing, execution
environments -> projects, routing, execution
projects     -> execution
operations   -> execution
routing      -> execution
execution    -> no other workspace
```

These boundaries do not introduce extra processes, databases, or asynchronous
events. Structure commands and queries still coordinate the local hub in process.

## Imports and dependencies

Each workspace declares its own runtime dependencies. Internal dependencies use
`workspace:*`, and imports use explicit package exports, for example:

```ts
import { Manager } from "@contremaitre/environments/manager";
import { initProject } from "@contremaitre/projects/init";
```

Relative imports stay within the owning workspace's `src` directory. Packages
cannot import application code. The root manifest owns development tooling and
dependencies used by the shared test suite, rather than providing implicit runtime
dependencies to packages. Root `test/` keeps the existing regression and integration
suite, including the shared fake container runtime. Root `scripts/` contains build
verification tools. Tests and packaging checks consume workspace exports.

`bun run check:boundaries` checks runtime dependency declarations, exported entry
points, relative import boundaries, and package cycles. It runs as part of
`bun run check`, alongside lint, typechecking, the regression suite, the standalone
ARM64 build, and compiled-executable crash/restart checks.

## Refactor acceptance

- CLI code lives under `apps/cli`; capability code lives under `packages/*`.
- The old root `src/` directory and imports into it are removed.
- Packages have no dependency cycles or imports into applications.
- Command behavior, state version, environment identities, deployment lifecycle,
  routing, and recovery remain unchanged.
- `make build` still writes `bin/contremaitre`; `make install` uses the same path.

The existing behavior suite verifies this refactor. No new deployment behavior is
introduced. Package checks add structural validation; standalone packaging checks
verify that workspace imports are bundled into the executable.

Verified on 2026-09-08 with Bun 1.4.2: frozen-lockfile install and `bun run check`
passed, including 26 tests and 102 assertions. Temporary invalid imports confirmed
that boundary checks reject undeclared dependencies, relative package escapes,
private exports, package cycles, and imports from packages into the CLI. The probes
were removed after verification. Native customer deployments were not repeated for
this source-layout refactor; earlier migration evidence remains in
[structure-verification.md](structure-verification.md).
