# Redis Wasm investigation

Redis can run in a Bun worker as a Wasm engine behind an ordinary loopback TCP
listener. The compatibility spike proves that model, including a standalone Bun
executable. Wadis 1.0.3 still has two reproduced compatibility gaps, so this is
not yet a supported Contremaitre backend. `kind: redis` with `runtime: wasm`
remains rejected.

## Reproduce the spike

Use Bun 1.4.2 on Apple silicon macOS. The spike has its own pinned dependencies
and lockfile under [research/redis-wasm](../research/redis-wasm/README.md). It does
not add a runtime dependency to the CLI or bundle the experimental engine into
Contremaitre releases.

```sh
cd research/redis-wasm
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run probe:engine
bun run probe:compiled
```

The compatibility probes intentionally fail on the two gaps below. Do not turn
those assertions into expected failures when evaluating a repaired engine.
This tooling change has no application fixture requirement.

## Observed results

Verified on 2026-10-28 with Bun 1.4.2, Wadis 1.0.3, ioredis 5.8.1 and BullMQ
5.61.2. The engine reports Redis 8.2.1. These are functional probes, not a full
Redis conformance suite or a throughput benchmark.

| Probe | Result |
| --- | --- |
| Independent TCP clients share data; binary values and pipelining | Pass |
| MULTI/EXEC state is private to its connection | Pass |
| EVALSHA, cjson and cmsgpack | Pass |
| Pub/Sub delivery and subscriber cleanup after QUIT | Pass |
| BLPOP wakeup from another client and idle timeout | Pass |
| Lazy expiration on GET | Pass |
| Active expiration without reading expired keys | Fail |
| FLUSHDB completion and continued client use | Fail |
| Fragmented RESP input and a 2 MiB binary reply | Pass |
| Parent event loop continues during a long Lua script | Pass |
| Separate workers have separate stores | Pass |
| Worker termination closes connections; replacement starts empty | Pass |
| BullMQ ordinary and delayed jobs over TCP | Pass |
| Standalone executable with embedded Wasm and worker | Pass |

The TCP suite has 11 passes and two failures. Two additional direct-engine
probes reproduce the same failures without the bridge.

### Active expiration

SET a key with a 20 ms TTL, wait 500 ms without touching it, then run DBSIZE.
The direct engine returns `:1`, rather than `:0`. GET returns nil and the next
DBSIZE returns `:0`, so lazy expiration works. The TCP probe observes the same
problem after one second.

The published [Wadis shim](https://github.com/cah4a/wadis/blob/3779dc2f287e6964a076489f0e1b987744d152c1/wasm/shim.c)
updates cached time and processes blocked clients, but its timer tick does not
run the usual server cron or active-expiration cycle. This is the likely cause,
based on source inspection. An engine change should restore bounded periodic
expiration work and retain the regression probes.

### FLUSHDB completion

FLUSHDB receives no response. A subsequent PING on that client also receives no
response. Other clients continue working. The TCP client times out after four
seconds; the direct engine produces no output within 500 ms.

Redis 8.2.1's [flush implementation](https://github.com/redis/redis/blob/8.2.1/src/db.c)
normally converts synchronous flushes to blocking background work, unless the
client has `CLIENT_AVOID_BLOCKING_ASYNC_FLUSH`. Wadis creates clients without
that flag. Missing background completion handling is a likely cause, not a
verified fix. Repairing the port should also test FLUSHALL, UNLINK and other
background-freeing paths.

## Packaging

The standalone probe supplies both `compiled.ts` and `worker.ts` to `bun build
--compile --bytecode --format=esm`. It imports the Wasm asset with Bun's file
loader and uses `--asset-naming=[name].[ext]` to preserve `redis.wasm`. Wadis's
loader resolves that basename relative to `import.meta.url`, which then points
into Bun's embedded filesystem. The executable asserts that asset location and
passes PING, SET/GET and Lua from an empty working directory.

This proves packaging for this isolated binary. Integrating it with the CLI
still needs a collision check for embedded asset basenames and the existing
compiled-executable recovery checks.

## Next implementation boundary

Repair the two engine gaps before enabling the manifest combination. Then add a
managed Redis `ServiceRuntime` using the existing reserved ports, host bridges,
readiness hooks and worker lifecycle model. Start with explicitly ephemeral
storage, matching Redis's existing empty-on-branch-fork behavior. Define what
stop/start and hub restart do to its state before exposing it to users.

Wadis [declares RSALv2](https://github.com/cah4a/wadis#license). Dependency and
redistribution terms must be resolved before shipping its engine. The spike
does not make that dependency choice for the product. A Valkey-based build is
another candidate, but [valkey-wasm's build-status document](https://github.com/michaelkremenetsky/valkey-wasm/blob/main/BUILD-STATUS.md)
still lists compile, link and bring-up work; its README alone is insufficient
evidence of a working replacement.
