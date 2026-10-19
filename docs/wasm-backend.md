# WASM app backend

Contremaitre runs Wasm applications as detached processes. The default engine uses `wasmtime serve` for WASI HTTP components that export `wasi:http/proxy`. Set `wasm.engine: wasmer` for a WASIX application packaged as a self-contained WEBC file. Both engines use the same process supervision, artifact snapshots, logs, routing and recovery.

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

## WASIX applications

Install Wasmer 7.5.0 or newer and put it on the hub's `PATH`. Only services selecting Wasmer require it; existing Wasmtime services keep their toolchain.

```yaml
services:
  db:
    kind: postgres
    runtime: wasm
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
      DATABASE_POOL_SIZE: '1'
```

The build command must produce a WEBC package with an entrypoint and its application files. Contremaitre snapshots that package, so restart does not depend on the source checkout or a host Node installation. Include the runtime module and required files in the package to avoid registry dependencies during startup or recovery.

For Node applications, Edge.js QuickJS 0.2.5 compiles both the Node compatibility runtime and the JavaScript engine to Wasm. Bundle TypeScript to JavaScript on the host and include the output in the package. Contremaitre does not enable Wasmer's experimental N-API mode, which executes application JavaScript in a host engine.

The runtime sets `HOST=127.0.0.1` and `PORT` to its reserved port, overriding manifest values for those two keys. The application must honor them when binding its listener. WASIX guests have host network access through `--net`, including raw TCP to a managed PGlite database. No host filesystem directories are mounted; the guest sees its packaged filesystem. Wasmer receives only declared service variables through a private environment file, with values kept out of command-line arguments. The file remains available for restart and is removed with the runtime record.

WASIX and WASI services can coexist. Database cloning still uses the Postgres backend's own lifecycle. PGlite's single-connection limit applies to WASIX clients too. Neither engine enforces the Apple-container `cpus` or `memory` settings.

## Limits

- Logs are reset when the hub restarts a dead service.
- Logs rotate only when spawning a process, above 5 MiB. A long-running process can exceed this size.
- A corrupt record is treated as stopped. `contremaitre logs` prints a notice and then the service's log. Shutdown uses a separate private ownership record or salvaged PID and identity, and only terminates a matching process. If both records are unreadable, it cannot safely identify the old process. Shutdown succeeds with a warning in the operation and service logs. Find the operation with `contremaitre operations` and read its log with `contremaitre attach <id>`. `contremaitre down` prints only `down complete`; inspect and stop the old process manually.

- With the default Wasmtime engine, the server entry point is `wasi:http/proxy`. Wasmtime owns the HTTP listener; guests cannot create a raw TCP server. Host socket network access is not granted. Outbound HTTP uses `wasi:http/outgoing-handler`.
- There is no `exec`, and no `init` or `migrate` task support.
- No host filesystem directories are preopened. The process working directory is private service data, but that does not grant guest filesystem access.
- With Wasmtime, manifest environment variables are passed by name with `--env NAME`. Values come from the process environment, rather than command-line arguments. Wasmer uses a private environment file.
- Apple containers cannot reach a WASM service on host loopback. Validation rejects Apple services that depend on WASM services. WASM services can depend on Apple services.

See [Wasmtime's serve documentation](https://docs.wasmtime.dev/cli-options.html#serve) for the component contract and [CLI help](https://docs.wasmtime.dev/cli-options.html#help) for runtime options.
