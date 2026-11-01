# Redis Wasm compatibility spike

An isolated development package for the [Redis Wasm investigation](../../docs/wasm-redis.md).
It does not register a Contremaitre runtime or change managed Redis behavior.
Its dependencies are separate from the CLI workspace dependencies.

Use Bun 1.4.2, matching Contremaitre. From this directory:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run probe:engine
bun run probe:compiled
```

The TCP suite currently reports 11 passing and two failing probes. The direct
engine suite reports two failing probes. Those failures reproduce missing active
expiration and a FLUSHDB completion problem in Wadis 1.0.3. Both commands exit
nonzero deliberately; they are compatibility gates, not expected-success tests.
The standalone executable probe passes.

The `.probe.ts` names keep these experiments out of the ordinary `bun test`
discovery. Explicit paths in this package's scripts run them. Run Contremaitre's
normal checks separately from the repository root with `bun run check`.

The worker binds to a dynamically allocated `127.0.0.1` port and gives each TCP
socket its own engine client. Closing a worker discards its store. Test teardown
closes clients and terminates workers; there are no container or installed Redis
prerequisites. This bridge is research code, with no managed runtime lifecycle,
authentication, or resource-limit contract.

`probe:compiled` builds a temporary executable with an explicit worker entrypoint
and embeds `redis.wasm` with its original basename. It launches that executable
from an empty directory, verifies the asset path is inside Bun's embedded
filesystem, checks PING, SET/GET, and Lua, then removes the executable.
