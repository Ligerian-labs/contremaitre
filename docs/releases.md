# CLI releases

The CLI supports macOS 26 or newer on Apple silicon. A release contains the compiled `contremaitre-darwin-arm64`, its `contremaitre-darwin-arm64.sha256` checksum and `install.sh`. Users need neither Bun nor a source checkout.

After merging the release changes into `main`, create and push a version tag such as `v0.3.0` or `v0.3.0-rc.1`. The workflow validates the tag and stamps its version into the root package manifest and `apps/cli/src/version.ts` before running the full checks and building on macOS. These version changes apply only to the release checkout; no version bump commit is required.

The workflow verifies the binary's version and code signature, generates release notes and uploads the assets to a draft GitHub release associated with the tag. It publishes the release only after all assets are uploaded. Tags with a prerelease suffix create GitHub prereleases and do not replace the latest stable release. Runs for the same ref are serialized. A failed draft upload can be retried; rerunning a published release succeeds without changing it. No packages are published to a registry and no registry token is required.

The tunnel portal serves `/install.sh` from the latest GitHub release, with a one-minute cache. Its endpoint must be deployed before advertising the one-liner. The first release must be published before the endpoint can serve an installer. Later CLI releases do not require a portal deployment.

The shell bootstrap resolves the latest release once, downloads the checksum and binary from that tag, then invokes the verified binary's `self-install` command. `CONTREMAITRE_VERSION=v0.2.0` selects a specific stable release. `CONTREMAITRE_INSTALL_DIR` selects an absolute installation directory; the default is `~/.local/bin`. `CONTREMAITRE_HOME` selects the hub to upgrade.

The installer replaces the executable atomically and restarts a running hub using the same upgrade code as `make install`. It preserves ports, environments and retained data. Active operations and tunnel sessions end during the restart. If the restart fails, the installer exits with an error and prints a recovery command. A stopped hub stays stopped. HTTPS trust and privileged port forwarding remain explicit first-time setup steps.

To roll back, rerun the installer with the previous `CONTREMAITRE_VERSION`. Confirm that the previous release supports the current data format before downgrading. Download checksums detect corruption; they do not provide independent verification if the release publisher is compromised.
