# Structure migration verification

Verified on 2026-09-08 using an Apple M2 Max, macOS 26, Bun 1.4.2, and Apple
`container` 1.3.1. The builder retained its existing 4 CPU / 8 GiB allocation.

## Automated checks

`bun run check` passed lint, TypeScript checking, 26 tests with 102 assertions,
the standalone macOS ARM64 build, and the compiled executable smoke test.
`make compat-check` passed Go vet and the preserved Go race-test suite.

The tests cover:

- Existing environment identity and version 1 state, including Go's null maps,
  credential retention, private file permissions, and credential-free API views.
- Manifest validation, named monorepo Dockerfiles, Compose rejection rules,
  Dockerfile-specific ignore files, negations, nested COPY inputs, image reuse,
  and rejected symlinks outside a build context.
- Failed builds preserving running services, retained storage on down, explicit
  deletion, database cloning, uploaded-file isolation, and source writer recovery
  after cancellation and restart.
- Persisted operations, duplicate requests, queued cancellation, bounded
  concurrency, source exclusion, reconnecting logs, and restarting a hub.
- Unix socket ownership across hubs, HTTP routing, forwarded-header replacement,
  WebSocket traffic, frozen drivers, and stable tunnel reservations after restart.
- A compiled hub killed with SIGKILL during driver deployment. Restart reported
  the operation as interrupted, terminated the recorded driver process, and
  accepted a new deployment. SIGTERM shutdown/restart also passed.
- Global CLI options, command arguments following `--`, and propagating a driver
  exec command's exit status of 23 through the compiled CLI.

## Bigatelier

Live checks used an isolated Contremaitre home on port 19080 and the existing
`bigatelier-contremaitre-fix` checkout. Customer source files were not changed.

| Check | Result |
| --- | --- |
| First deployment in the isolated home, warm Apple layer cache | 20.4 seconds |
| Unchanged redeploy, direct image reuse | 20.5 seconds |
| Final executable with process journaling, unchanged redeploy | 23.4 seconds |
| New environment cloned from designated main | 40.6 seconds |
| Admin, API health, and web HTTP routes | HTTP 200 |
| Source and clone after dump/restore | Matching public table count; API and web healthy |
| Go CLI against the TypeScript hub | Environment listed successfully |
| Go hub rollback against TypeScript-written state | Identity, credentials, volumes, image records unchanged; API health HTTP 200 |
| TypeScript hub after Go rollback | Existing environments loaded and served |

These timings used an already populated Apple image/layer cache. They do not
measure downloading base images or compiling all dependencies from scratch.
Test environments, their volumes, and their owned image tags were explicitly
removed after verification. Shared builder caches were retained.

## Compatibility boundaries

The executable has no runtime dependency on Go. The old Go implementation remains
under `compat/go` for the rollback window. Operation, process, and clone-recovery
journals are additive sidecar files. Finish recovery in the new hub before
rolling back, because Go does not understand those journals.

Project-driver and tunnel behavior was tested with protocol fixtures. Kohral and
Tokenops were not redeployed in this migration. Their original checkout roots
currently contain no Contremaitre manifest. The tunnel project's current root
manifest references a generated env file that is absent. These checkout-specific
configuration gaps are separate from the driver/tunnel protocol tests.

Contremaitre hubs share an advisory lock for Apple builds. A manually launched
Apple build does not participate in this lock. No distributed
resource scheduler or external tunnel-provider implementation was added.
