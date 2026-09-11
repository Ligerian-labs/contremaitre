# Contremaitre reference

[Back to the project overview](../README.md)

Run isolated local application stacks for Git branches and Jujutsu workspaces on a Mac. Each environment gets a private container network, persistent PostgreSQL data, independent uploaded files, and a `.localhost` URL. Deploy captures your working files through an image build; changes take effect on redeploy.

## Install

Requires Apple silicon, macOS 26, Bun 1.4.2 for building, and Apple `container`. Tested with `container` 1.3.1 on an M2 Max.

```sh
brew install container traefik mkcert
mkcert -install
bun install --frozen-lockfile
make install
contremaitre start
```

The standalone binary includes Bun and installs to `~/.local/bin`. Go and Node are not required to run it. Add that directory to your PATH if needed. Starting the hub starts Apple container and installs its recommended kernel if missing. No Kubernetes cluster is required.

Services use HTTPS URLs without an explicit port. Contremaitre runs Traefik as
its local HTTPS router and uses mkcert for trusted development certificates.
On macOS, run `contremaitre https-service install` once and approve the administrator
prompt. The background service forwards port 443 to the TLS listener on 8443,
starts at boot, and survives terminal closure and hub restarts.
Run the hub and application containers as your normal user. See
[local HTTPS setup](local-https.md) for certificate trust, upgrades and
custom listener ports.

Open [https://contremaitre.localhost](https://contremaitre.localhost) for the
Traefik dashboard. It starts with the HTTPS hub, even before any apps are deployed.

For explicit legacy HTTP, use `contremaitre start --http --http-port 8080` and
`contremaitre deploy --http`. The control API uses a private Unix socket. A
detached daemon owns state and connector processes, so closing the hub's starting
terminal does not stop applications.

Run `contremaitre` or `contremaitre --help` for a compact list of all commands.
Use `contremaitre deploy --help` or `contremaitre help deploy` for usage, examples,
and flags. Each command accepts only the flags listed in its help. Shared flags
can appear before or after the command; arguments after `exec SERVICE --` pass
through to the service command.

## Agent testing and previews

Install the shared skill for Claude Code, Codex, OpenCode and Pi from an application project:

```sh
contremaitre agents install --agent all
contremaitre ensure --json
contremaitre verify --profile smoke --json
contremaitre report --json
```

Define the `smoke` profile using the project's existing test commands. Contremaitre reuses isolated environments, captures logs and artifacts outside the checkout, and returns a local review page with preview links and source freshness. Missing checks are unverified. Use `diagnose --run ID --json` for bounded failure output and `wait ID --json` for quiet operation waiting. `status` now shows the current workspace; `list` shows all environments.

See [agent setup, verification profiles and evidence limits](agent-workflow.md).

## First environment

Try the included stack:

```sh
cd examples/stack
contremaitre deploy --branch main --main
contremaitre show --branch main
contremaitre list
```

The example builds a static web page and starts PostgreSQL and Redis. Its web service receives connection settings but does not query the databases. Change `index.html` and redeploy to verify working-file builds.

For an existing application, `contremaitre init` starts a short conversation with a coding agent and writes `.contremaitre.yaml`. Contremaitre asks one question at a time with numbered choices and accepts free-text answers. The agent follows the active development command, workspace scripts and Compose configuration to identify applications and supporting services. Existing manifests enter an update conversation that preserves choices you have not asked to change. Init only writes the validated manifest; it does not build or deploy.

Use `--agent codex`, `--agent claude`, `--agent pi` or `--agent opencode` to override the saved agent. Otherwise init uses `<home>/init.json`, then discovers installed agents and remembers your selection. If none are available, it explains setup and the non-AI command. Agent-assisted init requires an interactive terminal. See [agent configuration and development containers](assisted-init.md) for settings, limits and source-sync behavior.

For scripts or conventional detection, `contremaitre init --no-ai` checks these conventions in order:

1. A root `Dockerfile` creates a `web` service with port 3000 for you to review.
2. Named `docker/<service>.Dockerfile` files create one service per file, using the repository root as the build context. For example, `docker/api.Dockerfile` and `docker/web.Dockerfile` create `api` and `web` services. A root Node `start` script is not needed. Init does not search nested workspaces.
3. A Node project with a `start` script and an npm or pnpm lockfile gets a generated Dockerfile and ignore file. Existing files are never overwritten.

Named Dockerfiles use a single literal TCP port from the final stage's `EXPOSE` instructions and enable HTTP routing on it. Local stage inheritance is supported; base image metadata is not inspected. With no declared TCP port, routing stays disabled. Multiple ports, variable ports, and complex Dockerfile syntax require an explicit manifest. Review whether the service speaks HTTP before deploying.

Conventional init generates a starting configuration. Review build contexts, ports, commands, dependencies, environment variables, and persistent storage before deploying. It does not infer databases or application settings from production Compose files. Both `.contremaitre.yaml` and `.contremaitre.yml` are protected from replacement in this mode.

`init --no-ai --compose compose.yaml` imports a strict subset of Compose: app images/builds, argument-list commands, string environment maps, dependency lists, a single published port, and named file volumes. Host port numbers are discarded; routes use the container port. Database services, interpolation, health conditions, bind mounts, and unsupported fields fail with an explanation. Define managed databases explicitly in the resulting manifest. Without `--no-ai`, `--compose` selects the file for the agent to inspect. This is not a Compose runtime.

## Manifest

```yaml
version: 1
project: shop
services:
  postgres:
    kind: postgres
  redis:
    kind: redis
  api:
    build: .
    dockerfile: Dockerfile
    command: [node, server.js]
    port: 3000
    http: true
    depends_on: [postgres, redis]
    env_file: .env.local
    environment:
      DATABASE_URL: '{{postgres.url}}'
      REDIS_URL: '{{redis.url}}'
    volumes:
      uploads: /app/uploads
    init: [node, scripts/seed.js]
    migrate: [node, scripts/migrate.js]
    ready: [node, scripts/health.js]
    cpus: 1
    memory: 512M
```

Use exactly one of `image` and `build`. Build contexts, Dockerfiles, and env files must remain within the manifest directory, including after resolving symlinks. Dockerfile paths are relative to that directory. Docker's build context ignore rules apply; exclude secrets from your build context. Images must support ARM64. Native builds stage only files allowed by `.dockerignore` (or the selected Dockerfile’s `.dockerignore` file) before contacting the Apple builder. This avoids repeatedly scanning ignored dependency trees. Temporary contexts use the user cache directory and are removed after each build. Symlinks that point outside the build context are rejected.

Commands are argument arrays; no host shell interpolation occurs. For an intentional shell command, use `[sh, -c, 'your command']`. The app must listen on `0.0.0.0` inside its container.

Dependencies start first. Managed databases use readiness commands; applications use `ready`, a TCP connection to `port`, or running-container status when neither is provided. Readiness has a 90-second deadline. Each readiness command gets up to five seconds; a stalled attempt is cancelled and retried within that deadline. A TCP check only proves that a port accepts connections; use `ready` for stronger checks.

`init` runs once on clean initialization. Forked services inherit matching initialization state from main. `migrate` runs when its app is replaced; unchanged apps skip it. These commands run in temporary containers with the service's network, environment, and volumes, before its normal process starts. Failed migrations leave a failed environment for inspection and retry; database changes are not rolled back automatically.

Use `{{contremaitre.url}}` for the current service's browser URL. It resolves to its public URL only during an active sharing session and otherwise to its local URL. `{{contremaitre.local_url}}` always selects the local URL. `{{service.browser_url}}` works for cross-service browser endpoints, without a startup dependency. Internal `{{service.url}}` references keep their existing meaning.

Managed Postgres defaults to `postgres:17`, database/user `app`, and a generated password per environment. It stores data in an Apple named volume, under a subdirectory of the mount. This managed layout supports Postgres 17; changing an existing database image requires an explicit migration. Managed Redis defaults to `redis:7-alpine` and has no persistent volume, so it starts empty when replaced or restarted. An unchanged Redis process retains its in-memory data.

`{{service.host}}`, `{{service.port}}`, and `{{service.url}}` resolve within the environment. Declare referenced services in `depends_on`. Postgres URLs include credentials; Redis URLs select database 0. App URLs use internal container IPs. Port numbers can be identical across environments because service ports are not published on the host.

`{{service.local_url}}` resolves the browser-facing URL of another HTTP service, including the hub port. Use it for browser API endpoints and CORS origins. These URLs are known before services start, so this reference does not require `depends_on`; internal host/port/url references still do.

`env_file` supports one-line `KEY=value` entries, optional outer quotes, comments, and blank lines. It does not evaluate shell expressions or expand `${...}`. Explicit `environment` entries take precedence. Multiline values are unsupported.

Services receive `CONTREMAITRE_ENVIRONMENT`, `CONTREMAITRE_LOCAL_URL`, and, when reserved, `CONTREMAITRE_PUBLIC_URL`. The runtime retains private configuration needed to restart a deployed image, even after its source workspace changes.

For large Angular or Node builds, check `container builder status`. A builder with
2 GB RAM can become unresponsive under compiler load. On a machine with enough
available memory, stop it when no builds are active and restart it with more
resources:

```sh
container builder stop
container builder start --cpus 4 --memory 8G
```

These settings affect the shared Apple builder. Application VM resources remain
controlled by each service's `cpus` and `memory` settings.

## Environment identity and routing

Identity includes the project name, canonical workspace path, and branch/bookmark. Distinct workspaces on the same branch remain isolated. Switching branches selects another environment; switching back recovers its data. Moving a workspace directory changes its identity.

Git uses the current branch, or a detached commit label. Jujutsu uses its nearest unambiguous ancestor bookmark, falling back to `workspace` when no bookmark exists. Multiple bookmarks require `--branch NAME`. Unbookmarked changes in the same workspace do not create an environment per change. `--branch` is an explicit context override, not a VCS mutation.

URLs include a workspace suffix and hash, avoiding collisions after branch-name normalization. The alphabetically first HTTP service gets the environment URL; other HTTP services get an extra service prefix. Adding a service that sorts earlier changes that default assignment, so use service-specific configuration deliberately.

The first deployed `main` branch becomes the project's clone source. Use `deploy --main` to designate a source initially, or `contremaitre main --env ENV` to change it explicitly. Only one environment per project is designated main. It also gets `main.PROJECT.localhost`.

Run `contremaitre show` from the project directory or a subdirectory to print each HTTP service's local URL for the current workspace and branch. Use `--branch NAME` or `--env ENV` to select another environment. `contremaitre show --json` returns `{ "version": 1, "data": { "SERVICE": "URL" } }`. These are configured URLs, including for stopped or failed services; the command does not check readiness. An environment with no HTTP services returns an empty map.

Use environment IDs or names printed by `list` with `--env`. `PROJECT/main` selects the designated source. A project name alone works only when unambiguous.

Browsers and curl support `.localhost` routing. Clients whose resolver does not recognize subdomains of localhost can explicitly resolve the printed hostname to `127.0.0.1`, for example with curl's `--resolve` option.

## Data and lifecycle

```sh
contremaitre deploy
contremaitre exec api -- node scripts/migrate.js
contremaitre logs api
contremaitre proxy postgres 15432:5432
contremaitre proxy postgres 0:5432
contremaitre down
contremaitre down --env shop/main
contremaitre down --delete-data
contremaitre prune
contremaitre prune --delete-data
contremaitre stop
```

Restart the hub with the updated binary when upgrading to this deployment protocol.

`deploy` stays attached until services pass readiness checks. It prints the project and
branch, then one status row per service. Terminal rows update in place with a loader,
✅ for ready services, ❌ for failures, and a blocked or cancelled state when appropriate.
Successful HTTP service rows include their URLs. Redirected output contains plain final
rows without animation. `deploy --json` produces one JSON result without progress output.

Ctrl-C cancels the deployment and waits for active subprocesses to stop. Completed
migrations are not rolled back, and services already started remain running. Closing
or losing the client connection alone does not cancel the hub-owned operation.

```sh
contremaitre deploy --detach   # -d also returns immediately
contremaitre deploy logs
contremaitre deploy logs --failure
contremaitre deploy logs --follow   # -f also follows deployment output
contremaitre operations
contremaitre attach OPERATION_ID
contremaitre cancel OPERATION_ID
```

`deploy logs` prints a snapshot of the latest deployment of the current workspace and
exits, even if it is still running. Use `--branch NAME` or `--env ENV` to select another
environment. `--follow` follows that same deployment through completion. `--failure`
prints failed services' deployment logs plus shared setup/error output; it prints
nothing after a successful deployment and does not search older failures. While a
deployment is active, failure filtering waits for its final outcome when combined
with `--follow`. Shared failures without a failed service return the full deployment
log. Older operation records without service attribution also return the full log.
Use `contremaitre logs SERVICE` for application output after deployment.

`attach --offset N` resumes from a byte offset in the operation log. A duplicate deploy
for an environment returns its active operation ID. Another mutation of a busy
environment reports a conflict. `cancel` waits for subprocess termination and clone
recovery. An interrupted migration is never replayed automatically.

Operation records and logs live under `<state-home>/operations`, separate from the
version 1 environment state. The hub retains 100 completed operations plus active
operations. Logs are stored completely on disk, including service-attributed copies
for failure filtering; they are no longer truncated at 4 MiB. Reads use bounded 64 KiB
pages. Retention removes each completed operation's record and all its logs together.
Driver diagnostics also go to the private driver log.

The hub runs two environment operations concurrently by default. Set
`CONTREMAITRE_CONCURRENCY` to an integer from 1 through 16 before starting it to
change that limit. The queue accepts up to 64 active or waiting operations. Service
builds are scheduled concurrently; each Apple runtime admits up to four builds at
once. A process-independent lock gives one deployment ownership of the shared builder
while its builds run. Builder configuration is reconciled before launching those
builds, even if the builder is already running. Other deployments and hubs wait
until the active builds finish or cancellation cleanup completes. Existing builder
CPU and memory settings are preserved. Infrastructure starts before apps,
with independent services starting concurrently and dependencies waiting for readiness.
Cloning locks both source and target against concurrent mutations.

The hub captures manifest configuration, environment identity, and the selected
main source when accepting a deployment. Build files are staged when the queued
operation starts. Wait for that staging step before editing files whose exact
contents must be part of a deployment.

Native deployments fingerprint the filtered context, file permissions, symlink targets, Dockerfile, and ignore rules. If these inputs are unchanged and the previous image still exists, deployment logs `Reusing unchanged image` and skips the builder. Successful builds are retained even if a later service fails. `deploy --rebuild` bypasses this image reuse and invokes the builder with its normal layer cache; it does not force a base-image pull. `--rebuild` also forces service replacement and migrations.

All required builds must succeed before replacing existing processes. A build failure
leaves the current application running. A running service with an unchanged image,
configuration, and dependency connections keeps its process and skips migrations;
readiness is still checked. Changing a dependency conservatively redeploys its
dependents. Stopped services restart. The first deploy after upgrading records the
service fingerprints and may restart services once.

After startup begins, an individual failure blocks its dependents while independent
services finish. Ready services remain routable even if another service fails; the
overall command exits unsuccessfully. Startup and migration failures can leave a
partially updated environment. Image-based services use the image's code; local
source changes require a build-based service. Driver-managed projects display one
aggregate driver row; the driver owns internal scheduling and readiness.

A new environment clones matching Postgres services and declared file volumes from main. Main's running application services and workers stop while copying. The runtime dumps/restores the databases, copies files, and recreates the source writers in dependency order with refreshed addresses. Source writers are restarted even when cloning fails or the deploy is cancelled. A stopped main database starts temporarily for the dump and stops afterward. Avoid independent database/file writes through external clients during the copy.

Only the `app` database is cloned by the managed Postgres adapter. A matching source image is required. Files are copied by declared volume name; unsupported file types and symlinks produce errors. There is no synchronization back to main. PostgreSQL data and uploaded files must fit on disk during the copy, including the temporary dump.

Redeploy preserves data and does not recopy main. Upload directory names are scoped to an environment and may be shared by its services.

`down` removes container processes and retains data, configuration, network, and current build images. Redeployment recreates emptied networks to restore their host routes after inactivity. `--delete-data` also removes recorded databases, uploaded files, images, and network. It releases tunnel reservations first. Interrupted deletion can be retried; an environment mid-deletion cannot be deployed.

`prune` removes superseded Contremaitre build images. `prune --delete-data` also removes stopped environments that have no tunnel reservations. It never runs Apple's global prune or removes unrelated containers. Missing cached images can be removed from the registry idempotently.

`stop` stops all Contremaitre environments and exits the hub. The shared Apple container system remains available to other applications. RAM/CPU allocations are configurable per service; admission currently relies on Apple container errors. There is no automatic suspension or eviction.

`proxy` binds only `127.0.0.1` and stays in the foreground until interrupted. Omit the local port or use 0 for automatic allocation. An occupied explicit port is an error. Each new connection resolves the container's current address. Use `exec postgres -- psql -U app -d app` when you do not need an external database client.

## Tunnel providers

```sh
contremaitre tunnel
contremaitre tunnel login
contremaitre tunnel --workspace TEAM_ID
contremaitre tunnel status
contremaitre tunnel stop
contremaitre tunnel release web
```

Without a custom provider, `tunnel` uses `https://contremaitre.ligerianlabs.fr`. It opens browser authorization when needed, asks for a workspace when none is selected, saves the device credential in macOS Keychain and prepares the provider automatically. Later commands reuse that login. `tunnel login` signs in without starting a preview. `--workspace ID` selects a workspace for new reservations. Device links fill in the authorization code. Before creating tunnels, the CLI checks subscription access and opens the selected workspace's billing page if a subscription is required. No provider is installed or tunnel reserved in that case. See [SaaS onboarding](saas-onboarding.md) for the integration contract.

To use a custom provider, configure its installed executable in `~/.local/share/contremaitre/tunnels.json`. This explicit choice takes precedence; invalid custom configuration never falls back to the SaaS:

```json
{
  "default": "contremaitre",
  "providers": {
    "contremaitre": {
      "executable": "/absolute/path/to/contremaitre-tunnel-provider",
      "config": {"endpoint": "https://api.example.com"}
    }
  }
}
```

`tunnel` stays in the foreground and shares every `http: true` service together. The command renews a 15-second ownership lease every three seconds. Ctrl-C, SIGHUP, lease expiry, hub shutdown, or a detected branch/bookmark change closes sharing and restores local application configuration. Branch checks run once per second; they are not atomic with a VCS checkout. Short connector interruptions retry while the foreground owner renews the lease. A stopped session never restarts automatically. URLs remain reserved for a later explicit session. `tunnel stop` ends the whole session; `tunnel release SERVICE` also retires that service's reservation.

Services may restart when URLs change. No image builds, migrations, or data deletion run for the switch. The hub journals the configuration transition and restores local settings after a crash. Failed restoration leaves the environment failed, with a recovery message; restart the hub to retry. Finish sharing before redeploying; live source edits continue while sharing. Native services are supported; project drivers must first gain a URL-reconfiguration contract.

Declare browser endpoints and allowed origins in the application variables your framework reads:

```yaml
services:
  api:
    # image, port, command, etc.
    http: true
    environment:
      ALLOWED_ORIGINS: '{{web.browser_origins}}'
  web:
    http: true
    environment:
      API_URL: '{{api.browser_url}}'
```

`browser_origins` is a JSON array containing the local origin and, during sharing, the public origin. Configure the application to parse that array for CORS/origin checks. This lets local tabs continue working while browser API requests may use the public route. `CONTREMAITRE_URL` and `CONTREMAITRE_ORIGINS` provide the equivalent values for the current service. `CONTREMAITRE_LOCAL_URL` stays local; `CONTREMAITRE_PUBLIC_URL` is injected only while sharing. A retained reservation does not select public configuration. Hardcoded URLs and URLs compiled into static assets cannot be rewritten automatically; use a development server or application-supported runtime configuration.

Provider credentials belong in the provider's credential store. The protocol is documented in [docs/tunnel-provider.md](tunnel-provider.md). Adapters must advertise `foreground_sessions` and implement protocol-v2 lease frames; legacy detached providers fail before application configuration changes. This repository implements and tests the local side with an executable fixture. The first-party SaaS adapter and remote group leases are separate work described in the sibling tunnel repository's `tunnel-spec.md`.

Each reservation retains its provider and URL across stop/start and redeploy. A different configured default only affects new reservations. The daemon supervises active provider processes, retrying failed connections with a bounded delay. Providers own authentication renewal, remote session fencing, and transport reconnection. Explicit stop disables reconnect. Closing the hub through `stop` disables exposure.

Tunnels receive a dedicated loopback upstream that routes only to their selected HTTP service. Public host and HTTPS scheme are forwarded to the application. Creating a reservation does not restart the application; redeploy to receive a newly assigned `CONTREMAITRE_PUBLIC_URL` in its process environment.

## State, diagnostics, and development

Each state home has a distinct runtime resource namespace. Project names identify applications across workspaces; use a different project name for a different customer application.

State lives in `~/.local/share/contremaitre`, configurable with `--home` or `CONTREMAITRE_HOME`. The JSON state file and temporary env files are mode 0600; state includes database credentials and deployed environment values. Do not publish it. The daemon holds an exclusive filesystem lock and saves state using fsync plus atomic rename.

Use `--json` for versioned machine output. CLI failures exit nonzero; `exec` propagates the executed command's exit code. Exec and logs stream application output directly. Build diagnostics go to the operation log. Startup errors report its location. TCP/HTTP application traffic is streamed and request bodies are not logged by the hub.

The CLI lives in `apps/cli`; domain capabilities live in `packages/*` as private
Bun workspaces. See [the workspace layout](workspace-layout.md) for ownership,
dependency direction, and package boundary checks.

```sh
make check   # lint, typecheck, tests, standalone build and crash/restart checks
make build
```

See [docs/acceptance.md](acceptance.md) and [docs/verification.md](verification.md) for scope and verification results. The HTTP router supports WebSocket upgrades and streaming through the Bun/Node HTTP adapter. Local TLS uses Traefik; development source synchronization supports native hot reload.

## Existing Kubernetes projects

Use [project deployment drivers](project-drivers.md) when a repository already needs its own Kubernetes deployment, workers, keys, or agent volumes. Contremaitre manages workspace identity, main-data forks, routing, and cleanup through the driver. See the [Kohral verification and Tokenops assessment](complex-projects.md) for concrete integration requirements.

## TypeScript migration and rollback

The CLI uses `@structure-ai/cli`; application commands and queries use
`@structure-ai/cqrs`. Structure configuration, observability, readiness, and
shutdown services run the hub. Native Apple containers, project drivers, tunnels,
Unix sockets, and filesystem state remain explicit application adapters. There is
no event sourcing or database dependency.

Before replacing an installed Go binary, retain a copy as `contremaitre-go`.
Stop the hub process with SIGTERM to preserve running applications, then start
the new executable with the same `--home` and ports. `contremaitre stop` explicitly
stops applications as well. Only one hub may own a home directory; both versions
use the same advisory lock. The old Go CLI can use the new hub's existing API.
Use the matching Go executable when rolling the hub back.

The new hub reads and writes version 1 state without changing environment IDs,
URLs, credentials, or volume names. Operation and recovery records are separate.
On restart it reports unfinished operations as interrupted, reaps recorded
subprocesses after checking their process identity, and resumes recorded main
writers before accepting work. If recovery fails, startup fails with the journal
retained. Resolve recovery before rolling back to Go, which cannot read these new
journals. Rollback does not undo application database migrations.

The TypeScript build fingerprint has its own version. The first deployment after
migration recomputes an image through Apple's existing build cache. Subsequent
unchanged deployments reuse the stored image directly.

Run `bun run check` for formatting, lint, typechecking, tests, and the standalone
macOS ARM64 build. See
[the migration contract](structure-migration.md) for acceptance criteria.
