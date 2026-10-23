# CLI releases

The CLI supports macOS 26 or newer on Apple silicon. A release contains the compiled `contremaitre-darwin-arm64`, its `contremaitre-darwin-arm64.sha256` checksum and `install.sh`. Users need neither Bun nor a source checkout.

After merging the release changes into `main`, create and push a version tag such as `v0.3.0`, `v1.0.0.beta.0` or `v0.3.0-rc.1`. The workflow validates the tag and stamps its version into the root package manifest and `apps/cli/src/version.ts` before running the full checks and building on macOS. Dotted beta tags such as `v1.0.0.beta.0` are stamped as the semantic version `1.0.0-beta.0`; `v1.0.0-beta.0` tags also work. These version changes apply only to the release checkout; no version bump commit is required.

The workflow verifies the binary's version and code signature, generates release notes and uploads the assets to a draft GitHub release associated with the tag. It publishes the release only after all assets are uploaded. Tags with a prerelease suffix create GitHub prereleases and do not replace the latest stable release. Runs for the same ref are serialized. A failed draft upload can be retried; rerunning a published release succeeds without changing it. No packages are published to a registry and no registry token is required.

To create a beta after merging its changes, use the same tag workflow as a stable release:

```sh
git tag v1.0.0.beta.0
git push origin v1.0.0.beta.0
```

Increment the last number for later betas, such as `v1.0.0.beta.1`. The workflow publishes them with GitHub's prerelease flag and excludes them from latest stable. Publish `v1.0.0` when the version is ready for stable users.

Each successful push to `main` also packages and publishes a nightly prerelease at the exact checked commit, after the full checks pass. Its tag is `v0.0.0-nightly.<workflow-run-number>.g<12-character-commit>`. Nightly tags and assets stay fixed after publication; reruns skip an already-published build. The workflow run number orders builds even when checks finish out of order. Nightlies do not replace the latest stable release. Pull request checks do not publish builds.

The tunnel portal serves `/install.sh` from the latest GitHub release, with a one-minute cache. Its endpoint must be deployed before advertising the one-liner. The first release must be published before the endpoint can serve an installer. Later CLI releases do not require a portal deployment.

The shell bootstrap resolves the latest release once, downloads the checksum and binary from that tag, then invokes the verified binary's `self-install` command. `CONTREMAITRE_VERSION=v0.2.0` selects a specific stable release. An explicit beta or nightly tag also works, for example `CONTREMAITRE_VERSION=v1.0.0.beta.0`. `CONTREMAITRE_INSTALL_DIR` selects an absolute installation directory; the default is `~/.local/bin`. `CONTREMAITRE_HOME` selects the hub to upgrade.

The installer replaces the executable atomically and restarts a running hub using the same upgrade code as `make install`. It preserves ports, environments and retained data. Active operations and tunnel sessions end during the restart. If the restart fails, the installer exits with an error and prints a recovery command. A stopped hub stays stopped. HTTPS trust and privileged port forwarding remain explicit first-time setup steps.

`contremaitre update` lists published GitHub releases, follows all pages and selects the highest stable semantic version. It includes patch releases regardless of publication order or GitHub's latest pointer, then downloads both assets from the selected tag. Drafts and prereleases are excluded. It uses curl over HTTPS, verifies the checksum and calls the shared upgrade code to replace the invoked executable. Symlinks remain intact and their resolved target is replaced. It requires the compiled CLI for installation, refuses sudo and refuses a stable release older than the installed version. `CONTREMAITRE_VERSION` and `CONTREMAITRE_INSTALL_DIR` apply only to the download installer.

`contremaitre update --beta` selects the highest published beta semantic version, including numeric beta ordering such as beta 10 after beta 9. Dotted tags keep their original tag in download URLs and use their normalized semantic version in output. `contremaitre update --nightly` selects the newest published main build. Other prereleases, such as release candidates, are excluded from these channels. A missing channel fails before downloads. These flags are mutually exclusive, apply only to the current invocation and explicitly permit switching from a higher installed version. A nightly uses a `0.0.0` base, so a later plain `contremaitre update` can return it to stable.

`contremaitre update --check` reports availability without downloading assets, replacing the executable or contacting the hub, and can also run from source. All channels support `--check`, `--json` and `--home`. JSON results for beta and nightly also include `channel`. An already-current CLI leaves even an older running hub untouched. An ahead-of-release version is reported by `--check`; an attempted downgrade exits with an error. There is no automatic rollback after a failed hub restart.

Acceptance checks cover stable patches across paginated, out-of-order releases, beta ordering and dotted tags, nightly build ordering, channel switches, current-version no-ops, read-only checks, downgrade refusal, custom paths and symlinks, checksum and download failures, cancellation, JSON results and the existing running/stopped hub upgrade behavior. The isolated Structure fixture scenarios `cli/stable-update`, `cli/beta-update` and `cli/nightly-update`, each with input `{}`, check availability, install a verified fake release and confirm a repeated update leaves the binary unchanged. Run all three with `bun run test test/update.test.ts --test-name-pattern 'Structure cli/'`. Each receipt includes its run ID; its temporary executable is removed after the test. The compiled packaging checks use a recorded curl adapter and isolated hub data, without downloading or replacing a user's installation.

To roll back, rerun the installer with the previous `CONTREMAITRE_VERSION`. Confirm that the previous release supports the current data format before downgrading. Download checksums detect corruption; they do not provide independent verification if the release publisher is compromised.
