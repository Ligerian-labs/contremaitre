# WASM app backend

Contremaitre runs WASI HTTP components with `wasmtime serve`, and WASI command workloads with `wasmtime run`. Long-running services and workers run as detached host processes. Jobs run to completion before their dependents start. See [workloads](workloads.md) for the lifecycle contract.

HTTP components export the `wasi:http/proxy` world. The hub forwards HTTP requests to a reserved loopback port. Command components export `wasi:cli/run`; WASI Preview 1 command modules also work with `wasmtime run`.

Install Wasmtime and a component toolchain. For Rust:

```sh
brew install wasmtime
rustup target add wasm32-wasip2
```

This backend is tested with Wasmtime 49. Other toolchains, including componentize-js and componentize-py, work when their output is a compatible `wasi:http` component.

See [the runnable Rust example](../examples/wasm-app/) and the authoritative [manifest reference](reference.md#service-runtime):

```yaml
version: 1
project: wasm-app
services:
  web:
    runtime: wasm
    wasm:
      build: [cargo, build, --release, --target, wasm32-wasip2, --locked]
      component: target/wasm32-wasip2/release/wasm_http.wasm
    port: 8080
    http: true
    dev:
      source: .
      exclude: [target]
```

`wasm.build` runs on the host. Its optional `wasm.directory` and the required `wasm.component` are relative to the project root. Omit the build command to deploy a component you have already built.

Deploy with `contremaitre deploy`. The declared port identifies the service; Contremaitre chooses the actual free `127.0.0.1` port. Use the environment's HTTP URL or `contremaitre proxy web 0:8080` to reach it. `contremaitre logs web` reads the service's stdout, stderr and rebuild output.

At the runtime interface, `stop` terminates the process and `start` resumes it on its recorded port. `contremaitre down` stops the environment and removes runtime records and logs; deploy again to resume it. `contremaitre stop` stops every environment, including its `wasmtime serve` processes, and then shuts down the hub; deploy again to resume an environment. `contremaitre start` starts the hub.

A hub that exits on a signal (SIGTERM or SIGINT) or crashes leaves its WASM processes running, as it leaves Apple containers. The next hub reattaches to each surviving process on its recorded port and restores its watcher. Recovery restarts a missing process.

With `dev.source`, Contremaitre watches that directory in place. It does not create a source mirror. `dev.exclude` uses ignore patterns; exclude build output such as `target` to avoid rebuild loops. A source change rebuilds the component and replaces the process. A failed build leaves the previous process serving and writes the failure to the service log.

Successful starts retain only the current snapshot and the immediately previous snapshot. Snapshots are written atomically and verified before reuse.

A component that builds but fails to start restores the previous snapshot on the same port and writes the restart failure to the service log.

## Limits

- Logs are reset when the hub restarts a dead service.
- Logs rotate only when spawning a process, above 5 MiB. A long-running process can exceed this size.
- A corrupt record is treated as stopped. `contremaitre logs` prints a notice and then the service's log. Shutdown uses a separate private ownership record or salvaged PID and identity, and only terminates a matching process. If both records are unreadable, it cannot safely identify the old process. Shutdown succeeds with a warning in the operation and service logs. Find the operation with `contremaitre operations` and read its log with `contremaitre attach <id>`. `contremaitre down` prints only `down complete`; inspect and stop the old process manually.

- HTTP mode uses `wasi:http/proxy`; Wasmtime owns the HTTP listener. Command mode uses `wasm.mode: command`, or is selected automatically for `workload: worker` and `workload: job`. In command mode, `command` supplies guest arguments. Set `wasm.network: true` to grant host network access and HTTP imports. A command service can use `{{its-name.port}}` to receive its reserved listening port. Workers and jobs have no listening ports.
- There is no `exec`, and no `init` or `migrate` task support.
- Declared named `volumes` are preopened at their guest paths. They remain private to the environment and participate in branch data forks. Other host directories are not preopened. The process working directory is private service data, but that does not grant guest filesystem access.
- `memory` caps each Wasm linear memory. It does not cap the entire Wasmtime host process. `cpus` does not impose a host CPU quota. Job wall-clock time is bounded by `timeout_seconds`, default 300 seconds.
- Manifest environment variables are passed by name with `--env NAME`. Values come from the host process environment, rather than command-line arguments.
- In mixed environments, container clients receive an environment gateway and relay port for each host service reference. Relays forward TCP to the service's loopback listener and accept clients only from that environment's container subnet. Host clients continue to receive loopback addresses. Relays require the hub; a hub restart recreates them and refreshes clients if an address changes. WASM services reach Apple services through their container IPs.

See [Wasmtime's serve documentation](https://docs.wasmtime.dev/cli-options.html#serve) for the component contract and [CLI help](https://docs.wasmtime.dev/cli-options.html#help) for runtime options.
