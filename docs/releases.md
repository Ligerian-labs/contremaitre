# CLI releases

The CLI supports macOS 26 or newer on Apple silicon. A release contains the compiled `contremaitre-darwin-arm64`, its `contremaitre-darwin-arm64.sha256` checksum and `install.sh`. Users need neither Bun nor a source checkout.

After merging the release changes into `main`, create and push a stable version tag such as `v0.2.0`. Keep the root package version and both CLI version strings in `apps/cli/src/cli.ts` equal to the tag without `v`. The workflow rejects mismatches, runs the full checks on macOS, verifies the binary's code signature and uploads the assets to a draft release. It publishes the release only after all assets are uploaded. A failed draft upload can be retried; published releases cannot be overwritten by the workflow.

The tunnel portal serves `/install.sh` from the latest GitHub release, with a one-minute cache. Its endpoint must be deployed before advertising the one-liner. The first release must be published before the endpoint can serve an installer. Later CLI releases do not require a portal deployment.

The shell bootstrap resolves the latest release once, downloads the checksum and binary from that tag, then invokes the verified binary's `self-install` command. `CONTREMAITRE_VERSION=v0.2.0` selects a specific stable release. `CONTREMAITRE_INSTALL_DIR` selects an absolute installation directory; the default is `~/.local/bin`. `CONTREMAITRE_HOME` selects the hub to upgrade.

The installer replaces the executable atomically and restarts a running hub using the same upgrade code as `make install`. It preserves ports, environments and retained data. Active operations and tunnel sessions end during the restart. If the restart fails, the installer exits with an error and prints a recovery command. A stopped hub stays stopped. HTTPS trust and privileged port forwarding remain explicit first-time setup steps.

To roll back, rerun the installer with the previous `CONTREMAITRE_VERSION`. Confirm that the previous release supports the current data format before downgrading. Download checksums detect corruption; they do not provide independent verification if the release publisher is compromised.
