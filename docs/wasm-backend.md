# WASM app backend

Contremaitre runs WASI HTTP components as detached host processes with `wasmtime serve`. They export the `wasi:http/proxy` world. The hub forwards HTTP requests to a reserved loopback port.

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

Deploy with `contremaitre deploy`. The declared port identifies the service; Contremaitre chooses the actual free `127.0.0.1` port. Use the environment's HTTP URL or `contremaitre proxy web` to reach it. `contremaitre logs web` reads the service's stdout, stderr and rebuild output.

At the runtime interface, `stop` terminates the process and `start` resumes it on its recorded port. `contremaitre down` stops the environment and removes runtime records and logs; deploy again to resume it. `contremaitre stop` shuts down the hub and its environments, and `contremaitre start` starts the hub. A hub restart reattaches to a surviving process and restores its watcher. Recovery restarts a missing process.

With `dev.source`, Contremaitre watches that directory in place. It does not create a source mirror. `dev.exclude` uses ignore patterns; exclude build output such as `target` to avoid rebuild loops. A source change rebuilds the component and replaces the process. A failed build leaves the previous process serving and writes the failure to the service log.

## Limits

- The server entry point is `wasi:http/proxy`. Wasmtime owns the HTTP listener; guests cannot create a raw TCP server through this backend. Host socket network access is not granted. Outbound HTTP uses `wasi:http/outgoing-handler`.
- There is no `exec`, and no `init` or `migrate` task support.
- No host filesystem directories are preopened. The process working directory is private service data, but that does not grant guest filesystem access.
- Manifest environment variables are passed by name with `--env NAME`. Values come from the host process environment, rather than command-line arguments.
- Apple containers cannot reach a WASM service on host loopback. Validation rejects Apple services that depend on WASM services. WASM services can depend on Apple services.

See [Wasmtime's serve documentation](https://docs.wasmtime.dev/cli-options.html#serve) for the component contract and [CLI help](https://docs.wasmtime.dev/cli-options.html#help) for runtime options.
