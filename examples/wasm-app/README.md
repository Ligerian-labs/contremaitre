# WASM HTTP app

Install Rust and Wasmtime:

```sh
brew install wasmtime
rustup target add wasm32-wasip2
```

From this directory, `contremaitre deploy` builds the component and serves it through the hub. Open the URL printed by the command. The app answers `hello wasm` and logs requests to stderr.

The included [.contremaitre.yaml](.contremaitre.yaml) watches the source in place and excludes `target`. Change `BODY` in `src/lib.rs` to rebuild and restart automatically. `contremaitre logs web` shows requests and build failures. `contremaitre proxy web 0:8080` opens a local TCP proxy.

Use `contremaitre down` to stop the environment, then deploy again to resume it. `contremaitre stop` and `contremaitre start` control the hub.

To run the component directly:

```sh
cargo build --release --target wasm32-wasip2 --locked
wasmtime serve -S cli=y --addr 127.0.0.1:48390 target/wasm32-wasip2/release/wasm_http.wasm
curl http://127.0.0.1:48390
```

Stop the direct server with Ctrl-C. See [the backend guide](../../docs/wasm-backend.md) for lifecycle and limitations.
