# Services, workers and jobs

Choose workload behaviour independently of its execution backend. Containers run Linux images and their native dependencies. Wasmtime runs compatible WASI components and command modules. Existing manifests keep their current behaviour.

| `workload` | Behaviour | Ports | Dependency completion |
| --- | --- | --- | --- |
| `service`, the default | Long-running application | Optional | Process running, plus configured readiness |
| `worker` | Long-running background command | None | Process running |
| `job` | Run once to completion | None | Successful exit |

These fields apply to application services. Managed Postgres and Redis keep their own lifecycle. A job can depend on a database, another job or an application. A worker or service that depends on a job starts only after the job succeeds. Job failures fail deployment and block their dependents.

Set top-level `idle_timeout_seconds: 0` when background workers must keep running without CLI or proxied HTTP activity. Otherwise the normal two-hour idle shutdown policy applies.

```yaml
version: 1
project: background-work
services:
  db:
    kind: postgres
    runtime: wasm
  migrate:
    workload: job
    image: oven/bun:1.3.4
    timeout_seconds: 60
    command: [bun, -e, "const sql=new Bun.SQL(process.env.DATABASE_URL,{max:1});try{await sql.unsafe('CREATE TABLE IF NOT EXISTS jobs(id int)')}finally{await sql.close()}"]
    depends_on: [db]
    environment:
      DATABASE_URL: '{{db.url}}'
  worker:
    workload: worker
    image: oven/bun:1.3.4
    command: [bun, -e, "console.log('worker started');setInterval(()=>console.log('working'),10000)"]
    depends_on: [migrate]
```

Deploy with `contremaitre deploy`. Use `contremaitre logs migrate` and `contremaitre logs worker` to read their output. The example's container job reaches the host PGlite database through an automatically managed relay. PGlite's default session mode requires client pool size one. Select [`pool_mode: transaction`](wasm-postgres.md#retained-connection-pools) on the database to retain application pools.

Jobs have a default timeout of 300 seconds; `timeout_seconds` accepts 1 through 7200. Their last 64 KiB of output remains available through `logs`, including after the task container is removed or the hub restarts. Environment JSON records job status, successful or failed exit code when available, completion time and errors.

An unchanged successful job is retained across deployment, hub recovery and `down` without data deletion. A changed definition, artifact, resolved environment or replaced dependency causes it to run again. `contremaitre deploy --rebuild` forces all jobs and services to run again. An interrupted job is marked interrupted, its remaining process is removed during recovery, and the next deployment retries it. Jobs must tolerate retries: a crash can occur after an external side effect and before success is recorded. Failed or interrupted jobs are never replayed automatically by hub recovery, data-fork resume or tunnel configuration.

Jobs do not support development watchers, listening ports, HTTP endpoints or readiness commands. Workers have no listening ports or HTTP endpoints. Service-address references to workers and jobs fail validation; `depends_on` still establishes their ordering.

## Wasm commands

For a WASI command component, use a worker or job instead of an HTTP component:

```yaml
services:
  transform:
    runtime: wasm
    workload: job
    wasm:
      build: [cargo, build, --release, --target, wasm32-wasip2, --locked]
      component: target/wasm32-wasip2/release/transform.wasm
    command: [/data/input.json, /data/output.json]
    timeout_seconds: 30
    volumes:
      files: /data
```

`command` contains guest arguments. Named volumes are preopened at their guest paths. They persist across deploys and participate in branch data forks. Set `wasm.network: true` when a command needs network access. A long-running command service can explicitly select `wasm.mode: command` and declare a port; pass the resolved `{{service-name.port}}` to the guest so it listens on the reserved host port. Such services expose TCP through `proxy`; HTTP components continue to use the hub's HTTP routes.

Wasm `memory` limits each linear memory, rather than the whole runtime process. `cpus` does not set a Wasmtime CPU quota. Use containers for software requiring a Linux environment, native extensions or process behaviour unavailable in its WASI toolchain. Wasmer and a host-process backend are not required by this lifecycle and are not included in this change. Built-in recurring scheduling is not included; a scheduler can run as a worker or container service.

## Mixed runtime networking

Host clients receive each Wasm service's reserved loopback address. Container clients receive a relay address on their environment's gateway. The relay forwards TCP to loopback and accepts connections only from that environment's container subnet. It binds a host IPv4 listener with this source filter, so it does not require administrator packet-filter or DNS changes. Services on the same environment network can use its relays; this is environment isolation, not a per-service firewall.

An unchanged deploy retains listeners and existing connections. A hub exit closes relays. Recovery recreates them on their previous ports where possible and refreshes affected running clients when a gateway or relay port changes. Existing connections must reconnect after a hub restart. `down` closes the environment's relays. Wasm clients reach container services through their container IPs.

## Verification

Run the real mixed-runtime fixture on an Apple silicon Mac with Apple container, Rust's `wasm32-wasip2` target and Wasmtime installed:

```sh
CONTREMAITRE_FIXTURES=1 bun scripts/verify-workloads.ts --cleanup
```

The `workloads/mixed-stack` scenario takes `{}` input. It deploys through the application's command bus and checks a Wasm job with persistent files, a Wasm worker, a container job using Wasm HTTP and Postgres, unchanged deployment, independent branch database/file forks, rejection of cross-environment relay access, hub recovery and application verification. `--cleanup` removes only its isolated temporary environments. Use `--keep` instead to retain the environments and serve their application and review URLs until interrupted. To resume them later, start Contremaitre with the printed state home.
