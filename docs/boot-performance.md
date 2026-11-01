# Boot performance investigation

Measured on 2026-10-30 on Apple silicon, macOS, Apple container 1.3.1 and Bun
1.4.2. These measurements do not establish a 500 ms cold boot guarantee.

## Why the reported environment took minutes

The failed preview combined artifact preparation with runtime startup. Its Rust
release build alone took 483.5 seconds. After the image was exported, private
network creation hung until the subprocess's five-minute deadline expired.

The host had 64 allocated networks, including dozens belonging to stopped
Contremaitre environments. Apple's network helper logged `interface creation
failed` and `vmnet_return_t(rawValue: 1001)`. Changing the requested subnet did
not fix creation. Releasing two unused networks from confirmed stopped
environments allowed network allocation to proceed. This is evidence of resource
exhaustion on that host, not proof of a universal limit of 64 networks.

Contremaitre removed containers on ordinary and idle shutdown but retained the
private network until data deletion. It also created the network after building
all application images. Both behaviors contributed to the failure.

Shutdown now releases the network after all local services have stopped and been
removed. Volumes, files, credentials and built images remain available for the
next deployment. A failed stop retains the network. Failed network cleanup
remains retryable and prevents data deletion. Network checks run before builds;
network commands have a ten-second deadline instead of five minutes.

Existing stopped environments can release their old network by running
`contremaitre down --env ENVIRONMENT_ID` with the updated hub. This does not
delete their data. There is no global network prune or runtime restart in the
fix.

## Repeatable runtime benchmark

Build the compiled CLI and run:

```sh
bun run build
bun scripts/benchmark-boot.ts
```

The benchmark creates its own HTTP hub and project, invokes the compiled CLI,
checks a real Nginx HTTP response after each ensure, and removes only its own
environment and data afterwards. The image must already be cached to measure
boot without an image download. Image builds and hub startup are outside the
timed interval. The command reports budget results for each case separately.

One run, with an already running isolated hub and cached `nginx:alpine`:

| Operation | CLI elapsed time | Below 500 ms |
| --- | --- | --- |
| Create a new environment and wait for readiness | 2,402 ms | No |
| Reuse a running environment, 10 samples | 345–431 ms | All 10 |
| Boot after down, 3 samples | 3,204 / 2,707 / 3,184 ms | None |

All 14 ensures returned ready and their HTTP responses were checked. The smoke
verification profile passed its response check and the final report was current.
An earlier run measured 3,689 ms for new boot, 356–438 ms for reuse and
2,991 / 4,747 / 3,245 ms for stopped boot. These are observed samples, not a
latency guarantee. This is a
small static service, not an application with database migrations or a frontend
build. There is no HTTPS forwarding or public tunnel in this benchmark.

A separate direct Apple runtime probe, outside Contremaitre, took 2,243 ms to
create and start a cached Alpine container, and 712 ms to start the stopped
container. Even that smaller restart exceeded 500 ms. Reusing a running
environment meets the target in the sample above; cold boot does not. Meeting
500 ms for cold boot would require further runtime work or a different lifecycle,
such as keeping an already prepared VM running. Downloading toolchains and
compiling application binaries cannot fit inside that measured budget.
