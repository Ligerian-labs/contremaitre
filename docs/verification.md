# Verification

Verified on 2026-09-08 on an Apple M2 Max, macOS 26.6.2, Apple container 1.3.1. Builds use Go 1.27.1.

## Automated checks

- `make check`: formatting, `go vet`, race-enabled tests, and compilation.
- `go run golang.org/x/vuln/cmd/govulncheck@latest ./...`: no vulnerabilities found with the pinned Go toolchain.
- Identity tests cover branch/workspace separation, normalized-name collisions, real Jujutsu workspaces and bookmarks, and stable identity across unbookmarked changes.
- Configuration tests reject dependency cycles, unknown fields/services, escaping paths, unsupported Compose behavior, and invalid service references before stopping a running application.
- Lifecycle tests cover main cloning, retained database/file storage, explicit deletion, stopped-source cloning, failed-dump recovery, failed builds, source IP refresh, initialization state, and interrupted deletion.
- Routing tests cover host isolation, webhook bytes, repeated cookies, forwarded public HTTPS origin, SSE streaming, and upgraded bidirectional connections.
- Provider tests launch a real executable fixture and verify reservation, process readiness, stop, restart with the same URL, and release.
- CLI tests cover preserving application flags after `--` and successful control responses without a data payload.

## Apple container checks

Executed actual CLI commands against disposable state homes and projects:

1. Start a hub and deploy nginx, PostgreSQL 17, and Redis 7 on a private environment network.
2. Insert a PostgreSQL row, write an uploaded file, and set a Redis key in main.
3. Deploy a second branch. Verify the PostgreSQL row and uploaded file were copied, while the Redis key was absent.
4. Change the feature database, redeploy it, and verify the changed row persists while main remains unchanged.
5. Verify main's URL remains reachable after cloning and restarting its writers.
6. Stop an environment with `down`, deploy again, and verify its retained PostgreSQL data.
7. Build the included Dockerfile example and serve its HTML through a workspace hostname.
8. Execute init and migration commands in temporary containers and verify their persisted output files.
9. Proxy Redis through a dynamically allocated loopback port and receive `PONG` from an external TCP client.
10. Run a command exiting with status 7 and verify that the CLI returns status 7.
11. Remove stopped test environments with `prune --delete-data`, verify an empty registry, and stop the test hub.

Two platform findings changed the implementation: Postgres needs a subdirectory beneath the ext4 volume mount because of `lost+found`, and empty retained vmnet networks need recreation to reliably restore host routing. Both have been exercised in subsequent real deployments.

Port 80 is denied to the ordinary user on this Mac. The default hub uses port 8080. The optional `forward-http` helper requires administrator access and was not run with elevated privileges during verification.

## Integration limits

The production SaaS tunnel cannot be tested until its provider executable exists. The sibling `contremaitre-tunnel` repository was empty during implementation; executable contract tests do not establish production SaaS compatibility.
