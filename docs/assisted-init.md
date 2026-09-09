# Assisted initialization and development containers

`contremaitre init` selects a coding agent and discusses the current development stack. Answer with a listed number or free text. On an existing manifest, the first question asks what should change. Ctrl-C or EOF cancels without replacing the manifest. Invalid agent output gets at most two correction attempts. Concurrent manifest edits cause init to exit without overwriting them.

Use `contremaitre init --no-ai` for conventional detection in scripts. `--compose FILE` selects Compose input for either mode. Agent-assisted mode supports the repository's active stack through inspection and questions; it does not execute Compose.

## Agent configuration

The selection order is `--agent NAME`, saved configuration, then executables on PATH. Discovery remembers a single available agent or your choice among several. A command-line override is not saved. No agent is installed automatically.

Settings live in `<home>/init.json`. Home defaults to `~/.local/share/contremaitre` and follows `--home` and `CONTREMAITRE_HOME`.

```json
{
  "agent": { "provider": "pi", "executable": "/absolute/path/to/pi", "model": "provider/model" },
  "timeout_seconds": 300,
  "max_turns": 40
}
```

Only `provider` is required when configuring an agent. The supported values are `codex`, `claude`, `pi` and `opencode`. `executable` selects an executable, not a shell command. `model` uses that provider's model syntax. Agent authentication stays with the installed CLI. Timeout applies to each invocation, including file-inspection turns, and accepts 10–1800 seconds. The conversation limit accepts 1–100 turns. Unknown configuration keys fail validation.

Adapters use the installed CLI's JSON mode in a temporary directory. Tools and customizations are disabled for this operation. Codex ignores user configuration and rules while retaining its authentication; use `agent.model` for an explicit model. Claude Code uses safe mode; Pi disables tools, extensions, skills and context files; OpenCode uses a tool-disabled agent with denied permissions and no external plugins. Install a CLI version supporting these switches. Agent subprocesses have bounded output, cancellation and deadlines. Init uses each provider's final answer, not its reasoning or progress events.

Contremaitre supplies an inventory and package scripts. The agent can request listed text files in batches of 12. Files are limited to 64 KiB, the inventory to 20000 files and the conversation context to 2 MiB. Dependency trees, VCS state and common generated directories are omitted. `.env` files provide variable names with values redacted; manifests reference the original env files. Referenced source files are sent to the selected agent's configured model provider. Init never needs the agent's file-edit or shell tools.

## Development services

```yaml
version: 1
project: example
services:
  db:
    kind: postgres
    image: pgvector/pgvector:pg17
  api:
    image: oven/bun:1.3.14
    working_dir: /app/apps/server
    command: [bun, --watch, src/main.ts]
    port: 3000
    http: true
    depends_on: [db]
    env_file: [.env.dev, .env.dev.local]
    environment:
      HOST: 0.0.0.0
      DATABASE_URL: '{{db.url}}'
      PUBLIC_BASE_URL: '{{contremaitre.url}}'
      DATA_DIR: /data
    volumes:
      files: /data
    dev:
      source: .
      target: /app
      install: [bun, install, --frozen-lockfile]
      exclude: [test/fixtures/large]
```

Use an existing image containing `sh`, `tar`, and the application's runtime. `dev.source` is relative to the manifest and stays within the repository, including symlinks. Use the monorepo root to include shared packages. `dev.target` is an absolute container directory; `working_dir` selects the application directory inside it. `dev.install` runs at `dev.target` on each deployment, before initialization and migrations. Use direct app commands; development wrapper scripts that launch Docker should not run inside these containers. Persistent app data belongs outside `dev.target`.

`env_file` accepts a path or an ordered list of paths. All listed files must exist. Later files override earlier files; the explicit `environment` map overrides all files. This preserves development defaults and local overrides without copying them into the source volume. Initialization, migration and dependency-install tasks use temporary containers; changes to their root filesystem do not survive in the app container. System libraries must already be in the selected image, come from an existing Dockerfile build, or be installed by the final startup command.

Each service gets a private Linux source/dependency volume. Deployment copies the source and installs dependencies. The hub scans for edits every second and sends changed files and deletions through container exec, producing Linux file events for Bun and other watchers. This avoids relying on host bind mounts to deliver inotify events. The checkout never receives container-generated files. The source volume is rebuilt on deployment and is not application data or part of a main-data fork.

Package manifests and lockfiles are frozen until `contremaitre deploy`. Changes set `dependencies_changed` in service status and log a redeploy message. Source-sync failures set `development_error`, retry, and retain pending edits across hub restarts. A functioning application can continue serving during a sync error. Inspect `contremaitre status --json` for these fields.

The sync excludes `.git`, `.jj`, `node_modules`, common build/cache directories, `.env*`, `.pem`, and `.key` files, plus `.gitignore` and `dev.exclude` patterns. It permits confined file symlinks by copying their contents; directory symlinks and escaping symlinks fail explicitly. Sources are limited to 50000 entries, 64 MiB per file and 512 MiB total. Stop, down and hub shutdown cancel pending sync operations. Recovery resumes sync for containers still running. `down --delete-data` removes source volumes and host mirrors.

Run `bun scripts/verify-development.ts` for an opt-in test against the native Apple container runtime. It creates disposable resources and checks actual Bun hot reload, file deletion, frozen dependency manifests, checkout isolation and recovery.

## Acceptance criteria

- Plain `init` uses a coding agent; `--no-ai` retains conventional initialization.
- CLI selection overrides saved selection, which overrides local discovery. Support Codex, Claude Code, Pi and OpenCode. Remember an interactive discovery choice. Missing agents explain configuration and the non-AI command.
- Contremaitre owns the terminal, presents compact numbered choices, and accepts one answer at a time, including free text. Agents inspect the active development stack through bounded file requests. Compose takes precedence for the selected stack, not unrelated deployment profiles.
- Initialization only writes a validated manifest. Existing manifests enter an update conversation. Cancellation, invalid output and concurrent edits preserve the existing file.
- Development services run inside managed containers. Source changes, additions and deletions reach the Linux filesystem and trigger native watchers. Dependencies are installed on deployment. Package manifests and lockfiles remain unchanged until redeployment.
- Sources, dependencies and generated outputs are isolated per environment and service. Sync excludes host dependencies, credentials, VCS state and generated outputs. Stop, deletion and hub shutdown stop synchronization; hub restart resumes it.

## Ownership

The CLI owns agent selection, subprocess adapters and terminal input. The projects package owns repository inspection, the initialization conversation protocol and manifest validation. Environments owns source synchronization and lifecycle; execution owns subprocess cancellation. No model is needed after initialization.

## Root cause

The old detector only considered a root `Dockerfile`, named `docker/*.Dockerfile` files and a root Node start script. It did not follow Turbo's development tasks or Compose overlays. Stagiaire.AI's `Dockerfile.server` and development dependency Compose file therefore fell through to the root start-script error.

Browser-facing service URLs use HTTPS on port 443 by default. See [local HTTPS setup](local-https.md) for Traefik, certificate trust and the macOS forwarder. Applications keep their internal HTTP ports.
