# WASM HTTP app

Install Rust and `wasmtime` with `brew install wasmtime`, then:

```sh
rustup target add wasm32-wasip2
cargo build --release --target wasm32-wasip2 --locked
wasmtime serve -S cli=y --addr 127.0.0.1:48390 target/wasm32-wasip2/release/wasm_http.wasm
curl http://127.0.0.1:48390
```

The app answers `hello wasm` and logs each request to stderr. Stop it with Ctrl-C.

Proposed manifest, fields pending lane A (#52):

```yaml
services:
  web:
    kind: app
    runtime: wasm
    build: [cargo, build, --release, --target, wasm32-wasip2, --locked]
    component: target/wasm32-wasip2/release/wasm_http.wasm
```
