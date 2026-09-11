# Agent testing and previews

## Acceptance criteria

- `ensure` resolves the current workspace, reuses an unchanged ready environment, or deploys and waits with bounded JSON output. No nested model is invoked.
- `verify` runs a named manifest profile under the environment operation lock. It records exit statuses, timestamps, a source fingerprint, logs and artifacts outside the checkout. Missing checks never imply success.
- `report` returns local preview and review URLs, source provenance, separate readiness and verification results, and stale evidence after edits or redeployment.
- `diagnose` returns bounded diagnostics with an explicit cursor and truncation flag. `wait` follows an operation without streaming logs.
- Interrupted runs recover as interrupted. Timeouts, cancellation, queues, file counts, output sizes and retention are bounded.
- Shared setup, runtime and sharing skills support Claude Code, Codex, OpenCode and Pi. Every installed skill includes its references and UI metadata; Claude compatibility links resolve to the shared copies.
- The standalone binary exports a complete plugin bundle with Codex and Claude manifests, the Pi package and the OpenCode adapter. Installation and export are repeatable, preserve edited files, and reject paths escaping the destination before writing assets.

## Ownership

Projects owns profile configuration. Verification owns evidence, source fingerprints and report models. The hub admits operations through its command/query handlers and owns the loopback review server. Environment lifecycle remains in environments. CLI and agent adapters consume the same versioned contract.

## Install and use

After installing the updated binary, run this from an application project:

```sh
contremaitre agents install --agent all
contremaitre ensure --json
contremaitre verify --profile smoke --json
contremaitre report --json
```

Choose `claude`, `codex`, `opencode` or `pi` to install a specific integration. Add `--global` to use your home directory. Installation is idempotent and refuses to overwrite different existing content. It never edits existing agent settings or project instructions. Restart your agent or reload skills after installation. Agent permissions and project trust still apply.

The skills live under `.agents/skills`; Claude gets a compatibility symlink for each one under `.claude/skills`. OpenCode also gets a local plugin and Pi gets an extension. The OpenCode 1.x plugin shows a toast when verification state changes at session idle. The Pi extension shows a status indicator and provides `/contremaitre`. These UI updates do not inject model messages or register extra model tools. OpenCode v2 can use the shared skills; its different native plugin API is not targeted by the optional 1.x adapter.

| Skill | Use it for | Example request |
| --- | --- | --- |
| `contremaitre-setup` | Creating or updating a manifest, hot reload, databases and verification profiles | "Set up this monorepo with Contremaitre and its existing browser tests." |
| `contremaitre` | Running the current workspace, diagnosing failures and reporting fresh evidence | "Test this branch and give me the local preview and verification report." |
| `contremaitre-share` | Starting or stopping public previews and managing reserved URLs | "Share this app with a live public preview." |

Codex can invoke these as `$contremaitre-setup`, `$contremaitre` and `$contremaitre-share`. Claude's direct skill installation uses `/contremaitre-setup`, `/contremaitre` and `/contremaitre-share`; loading the native plugin adds its namespace, for example `/contremaitre:contremaitre-setup`. Pi uses `/skill:contremaitre-setup` for a skill and `/contremaitre` for the extension's status command. Natural-language selection depends on the host and model. Skills do not install the runtime or grant execution permissions.

The sharing skill starts a public tunnel only for a public-sharing request. Keep its foreground command alive for the preview's lifetime. The runtime skill preserves local previews for review and does not start a tunnel as part of verification.

## Export a native plugin

The source bundle is `integrations/contremaitre`. To obtain the same files from an installed binary without a source checkout, choose an existing parent directory:

```sh
mkdir -p "$HOME/agent-plugins"
contremaitre agents export "$HOME/agent-plugins" --json
```

The result contains `directory`, the absolute path to the generated `contremaitre` folder. Export includes the Codex and Claude plugin manifests, all skills and references, the Pi package manifest and both native adapters. It does not register a marketplace or change agent settings. `--agent` and `--global` apply only to `agents install`.

Load the exported bundle with one integration method per host to avoid duplicate skills:

```sh
claude --plugin-dir "$HOME/agent-plugins/contremaitre"
pi install "$HOME/agent-plugins/contremaitre"
```

For Codex, `contremaitre agents install --agent codex` is the direct route without a marketplace. The exported `.codex-plugin/plugin.json` is available for existing plugin distribution workflows. For OpenCode, use `contremaitre agents install --agent opencode` to place its adapter at the expected path. See the host documentation for [Claude plugin loading](https://code.claude.com/docs/en/plugins-reference), [Pi skill discovery](https://pi.dev/docs/latest/skills) and [OpenCode skill discovery](https://opencode.ai/docs/skills).

After upgrading Contremaitre, rerun install or export. Identical files are accepted. If an old or edited file differs, the command stops before writing assets and names the conflicting path. Compare that file with a fresh export in an empty parent directory. Back up and move the conflicting Contremaitre-owned files or skill directories, then rerun and reapply any customizations you want to retain. The installer has no force-overwrite mode. Restart the agent or reload its skills after an update.

The binary embeds the bundle through generated assets; `scripts/package-agents.ts --check` detects drift. Source bundle changes require rebuilding the CLI before installation or export.

For projects requiring runtime verification at every handoff, add this instruction to their existing agent guidance:

> Before handing off runnable changes, use the contremaitre skill to verify this workspace and provide its preview and review links. Report stale, failed or unconfigured checks explicitly.

## Check configuration

Checks are explicit argument arrays and reuse existing project scripts. No shell interpolation occurs unless the configured command invokes a shell.

```yaml
verification:
  exclude: [test-results, playwright-report]
  profiles:
    smoke:
      - name: api
        service: api
        command: [bun, test, test/smoke.test.ts]
        timeout_seconds: 120
      - name: browser
        command: [bun, run, test:e2e]
        timeout_seconds: 180
```

Without `service`, the command runs on the host in the manifest directory. With `service`, it runs inside that service through the native runtime or project driver. Native service checks require `sh`, `env`, `mkdir`, `cat`, `rm`, `sleep`, `setsid` and `timeout` in the image. The process group and timeout belong to the container, so cancelling the host exec client also terminates the check's process group. A command that deliberately detaches into another process group must clean up its own processes.

Host checks inherit the hub's environment. All checks receive:

| Variable | Meaning |
|---|---|
| `CONTREMAITRE_ENVIRONMENT` | Stable environment ID |
| `CONTREMAITRE_URLS` | JSON map of HTTP service URLs. Host checks get browser URLs; native service checks get addresses on the private container network. Driver checks get browser URLs. |
| `CONTREMAITRE_BASE_URL` | The selected HTTP service for a service check, otherwise the first HTTP service |
| `CONTREMAITRE_ARTIFACTS` | Unique directory for this check's screenshots, traces and other evidence |

For Playwright, set `use.baseURL` from `CONTREMAITRE_BASE_URL` and `outputDir` from `CONTREMAITRE_ARTIFACTS` in the project's existing Playwright configuration. Enable screenshots or traces in that configuration. Contremaitre does not install browsers or invent assertions. Host evidence is collected automatically from that directory. Container checks declare relative file paths, for example `artifacts: [screenshot.png, trace.zip]`. Contremaitre copies those files and removes the check's temporary container directory.

Each check records its own pass/fail result and exit code. The runner continues after a failed check, but cancellation and the overall deadline stop remaining checks. Check status is distinct from assertions inside a test framework: one check can run many test cases.

## Commands and output

`ensure` reuses an unchanged, running environment or deploys it. It fingerprints before and after deployment and refuses to stamp changed inputs as current. Normal `deploy` invalidates the stamp; run `ensure` before verification. Development source edits also require `ensure` before fresh verification. This conservative first version redeploys changed development sources to establish a known state, even when a watcher has already delivered edits.

`verify` requires a current source stamp and a running environment. Missing or empty profiles return `not-configured` with a nonzero exit status. Failed, interrupted, or stale runs also exit nonzero. A passing check does not prove visual correctness unless it actually asserts that behavior.

`report` and `status` inspect only the selected workspace, with `--env` and `--branch` overrides. `list` retains the global detailed environment view. Results distinguish readiness, source freshness, verification status, the recorded profile, and counts. Compact results return at most eight service URLs, plus `additional_services`; the review page and `show` list all URLs.

`ensure` and `verify` wait without streaming logs, or return an operation ID with `--detach`. `wait ID --json` follows silently and exits nonzero for an unsuccessful operation. Its default deadline is 1800 seconds and `--timeout` accepts 1–7200. A timeout or disconnected client leaves the hub operation running; `cancel ID` cancels it. `report` retrieves evidence after waiting. `attach` retains its existing log-streaming behavior for explicit debugging.

`diagnose --run ID --json` reads the first failing check's captured output, or the operation's deployment diagnostics. It returns at most 3000 bytes with `offset`, `truncated`, and, for checks, `log_truncated`. Resume with `--offset N` or select `--check NAME`. Full captured logs remain available on the review page.

## Evidence and limits

Evidence lives under `<home>/verification`, outside project sources. The hub keeps the latest 20 completed runs globally, plus active runs. Each check captures at most 4 MiB of logs and records truncation. A run retains at most 128 artifacts, 16 MiB per file and 64 MiB total. These are capture/retention limits, not a filesystem quota on arbitrary test commands. Host artifact symlinks and nonregular files are rejected. Container artifacts are read through the configured service; their declared paths must identify regular files. Failed artifact collection fails that check and removes its captured artifacts.

Profiles have at most 32 checks, with at most 20 profiles per manifest. Each check defaults to 300 seconds and permits 1–1800. The whole run has a 1800-second deadline. Verification shares environment locks, queue limits and concurrency slots with deployments. Host children use the existing owned-process journal; interrupted evidence is marked interrupted on restart.

Fingerprints hash file contents and modes. The workspace scan follows the root `.gitignore` and `verification.exclude` and omits VCS metadata, common generated directories, and standalone secret files. Build inputs additionally follow their Dockerfile-specific or root Docker ignore rules. Development inputs follow their source and exclusion configuration. Referenced env files are hashed without returning their values. Limits are 50000 entries, 64 MiB per file and 512 MiB per scan. Verification configuration is part of the source. VCS revision, when available, is supplementary; the fingerprint includes uncommitted inputs. Fingerprints describe configured inputs, not reproducibility of mutable image tags, external APIs or database contents.

The local review server binds an ephemeral loopback port and uses an unguessable path, strict Host checks, no-store caching and a content security policy. It exposes only report data and registered artifacts, never the control API. HTML and other active artifact formats download as attachments. Review URLs change on hub restart; obtain a new one with `report`. Pages refresh every ten seconds. Raw test output and artifacts are local evidence and may contain whatever the project's tests print; do not print secrets in tests. Public sharing is a separate explicit tunnel operation and never starts through the skill or UI adapters.

A source edit, changed verification configuration or redeployment marks earlier evidence stale. Changes to database contents or external systems are not fingerprinted. No VCS snapshot can prove those are unchanged.

## Verification

Run `bun run check` for unit/integration tests, lint, boundaries, typecheck, standalone build and packaging tests. Run `bun scripts/verify-agent-workflow.ts` for the opt-in Apple container check. It uses disposable resources and exercises reuse, container execution, artifact collection, stale detection, failure, and cancellation of the remote process group. `--inspect` temporarily keeps the local review page open for browser inspection.

The integration tests verify project installation for all four agents, every skill's size, plugin manifests, complete exports, conflict preservation, symlink confinement and OpenCode/Pi UI callbacks against a real bounded CLI subprocess. Packaging checks exercise installation and export from the compiled binary. They do not measure implicit skill selection or model reasoning across providers. Token costs depend on the host and tokenizer; byte ceilings are checked as a stable proxy. In the native smoke run, the compact one-service report was 527 bytes. No paid model calls are part of the test suite.
