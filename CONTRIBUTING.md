# Contributing to Contremaitre

Useful contributions include a reproducible bug, a small example stack, clearer setup instructions, or a fix with a regression test. For a substantial change, open an issue describing the workflow first so maintainers can discuss the scope.

## Development setup

Use Bun 1.4.2. Native runtime development supports an Apple silicon Mac running macOS 26 with Apple container, or Linux x64/ARM64 with local rootful Docker Engine. Clone the repository, create a branch or dedicated workspace, then install the pinned dependencies:

```sh
bun install --frozen-lockfile
bun run check
```

`bun run check` runs formatting and lint checks, package boundaries, agent asset consistency, TypeScript checks, tests, the standalone current-host build, and packaging checks. Install `mkcert` to include the real HTTPS integration test. Native runtime verification uses Apple's `container` tool on macOS or local rootful Docker Engine on Linux. See [the README](README.md#get-started) for runtime setup.

The CLI lives in `apps/cli`; domain packages live in `packages`. Read [the workspace layout](docs/workspace-layout.md) before adding a dependency between packages.

## Pull requests

Keep each PR focused on one problem. Describe the trigger, the expected result, and how you verified the change. Add a regression test for behavior changes. Documentation changes should include checked commands and working links.

Run the relevant focused checks while developing, for example `bun run test test/pglite.test.ts`, and `bun run check` before submitting. `bun run test` sets a 30-second default test timeout; plain `bun test` keeps Bun's 5-second default, which tests that start processes can exceed on a busy machine. Report skipped checks and failures in the PR. Use a conventional commit title such as `fix(routing): preserve WebSocket headers` or `docs: clarify the first deployment`.

## Bug reports

Include your macOS, Apple container, and Bun versions, the command you ran, the result you expected, and a small manifest that reproduces the problem. Include relevant output from `contremaitre deploy logs --failure` for deployment failures.

Remove credentials and customer data from logs and manifests before posting. Do not attach the state directory: it contains database credentials and deployed environment values.

## License

Contributions are covered by the repository's [Apache License 2.0](LICENSE).

For Linux native-runtime verification, run `CONTREMAITRE_FIXTURES=1 bun scripts/verify-docker.ts --cleanup`. The example and prerequisites are in [examples/linux-docker](examples/linux-docker/README.md). The complete regression suite includes macOS-specific installer/HTTPS tests; Linux CI runs the runtime regression selection and real Docker scenario.
