# WASM HTTP app

Install Rust and `wasmtime` with `brew install wasmtime`, then:

```sh
rustup target add wasm32-wasip2
cargo build --release --target wasm32-wasip2 --locked
wasmtime serve -S cli=y --addr 127.0.0.1:48390 target/wasm32-wasip2/release/wasm_http.wasm
curl http://127.0.0.1:48390
```

The app answers `hello wasm` and logs each request to stderr. Stop it with Ctrl-C.

Manifest supported once lane A (#52) merges:

```yaml
services:
  web:
    kind: app
    runtime: wasm
    wasm:
      build: [cargo, build, --release, --target, wasm32-wasip2, --locked]
      directory: .
      component: target/wasm32-wasip2/release/wasm_http.wasm
    port: 8080
    http: true
    dev:
      source: .
      exclude: [target]
```
