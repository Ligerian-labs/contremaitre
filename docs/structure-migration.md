# Structure migration contract

Purpose: share the TypeScript/Effect/Structure stack while preserving the existing
Contremaitre commands, manifests, environment identities, URLs, credentials,
volumes, build optimizations, project drivers, and tunnel protocol.

The CLI and hub become a Bun executable. Infrastructure remains external and is
accessed through explicit adapters. Commands and queries use Structure; event
sourcing and a new database are out of scope. Existing version 1 state stays
readable by Go, with new operation records stored separately. Only one hub owns a
home directory, including across Go/Bun versions. Rollback stops the new hub and
starts the previous executable without changing application data.

Deployments belong to the hub. Every accepted deployment gets an operation ID.
Client disconnect does not cancel it. A second deploy for the same environment
returns its active operation. Explicit cancellation terminates owned processes
and completes recovery before marking the operation terminal. Cross-environment
work has a configurable concurrency limit. Shared Apple builder startup is serialized;
independent builds can run concurrently. Ctrl-C in an attached deploy requests cancellation.
Main-source cloning must exclude concurrent mutation of both source and target.

On restart, interrupted operations are retained and reported as interrupted, not
silently replayed. The hub reconciles resources and performs any recorded source
writer recovery before accepting new work. A client can inspect/reconnect to
operation progress. Logs and operation state are private. Completed-operation retention is bounded;
retained deployment logs are complete and read in bounded pages.

Acceptance checks:

- Standalone executable, Unix control socket, subprocess cancellation and streamed IO.
- Existing Go state loads and round-trips with unchanged resource identities.
- Manifest validation, init conventions, Docker ignore rules, image reuse and rebuild.
- Deploy/readiness/down/prune/exec/proxy/tunnel and driver behavior remain available.
- Disconnect/reconnect, duplicate deploy, queued cancellation, restart and SIGTERM.
- Parallel environments, same-environment exclusion, main clone exclusion.
- Real Bigatelier deployment and cached redeploy in an isolated home.
- Repository checks, published task branch and PR. No runtime Go dependency.

Completed verification is recorded in [structure-verification.md](structure-verification.md).
