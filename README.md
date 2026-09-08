# Contremaitre

Run isolated local application stacks for Git branches and Jujutsu workspaces on a Mac. Each environment gets a private container network, persistent PostgreSQL data, independent uploaded files, and a `.localhost` URL. Deploy captures your working files through an image build; changes take effect on redeploy.

## Install

Requires Apple silicon, macOS 26, Go 1.27.1 or later, and Apple `container`. Tested with `container` 1.3.1 on an M2 Max.

```sh
brew install container
make install
contremaitre start
```

The binary installs to `~/.local/bin`. Add that directory to your PATH if needed. Starting the hub starts Apple container and installs its recommended kernel if missing. No Kubernetes cluster is required.

The hub listens on loopback port 8080 without administrator access; printed URLs include the port. If occupied, choose another port with `contremaitre start --http-port 18080`. macOS restricts port 80 to privileged processes. For port-free URLs, run `sudo "$HOME/.local/bin/contremaitre" forward-http` in a separate terminal, then start the ordinary hub with `contremaitre start --public-port 80`. The forwarder only bridges loopback port 80 to 8080 and exits when interrupted. Do not run the hub or application runtime with sudo. The control API uses a private Unix socket. A detached daemon owns state and connector processes, so closing the terminal does not stop applications.

## First environment

Try the included stack:

```sh
cd examples/stack
contremaitre deploy --branch main --main
contremaitre list
```

The example builds a static web page and starts PostgreSQL and Redis. Its web service receives connection settings but does not query the databases. Change `index.html` and redeploy to verify working-file builds.

For an existing application, `contremaitre init` generates `.contremaitre.yaml`. It checks these conventions in order:

1. A root `Dockerfile` creates a `web` service with port 3000 for you to review.
2. Named `docker/<service>.Dockerfile` files create one service per file, using the repository root as the build context. For example, `docker/api.Dockerfile` and `docker/web.Dockerfile` create `api` and `web` services. A root Node `start` script is not needed. Init does not search nested workspaces.
3. A Node project with a `start` script and an npm or pnpm lockfile gets a generated Dockerfile and ignore file. Existing files are never overwritten.

Named Dockerfiles use a single literal TCP port from the final stage's `EXPOSE` instructions and enable HTTP routing on it. Local stage inheritance is supported; base image metadata is not inspected. With no declared TCP port, routing stays disabled. Multiple ports, variable ports, and complex Dockerfile syntax require an explicit manifest. Review whether the service speaks HTTP before deploying.

Init generates a starting configuration. Review build contexts, ports, commands, dependencies, environment variables, and persistent storage before deploying. It does not infer databases or application settings from production Compose files. For a monorepo, add managed database services and connect the applications with `depends_on` and environment references as shown below. Both `.contremaitre.yaml` and `.contremaitre.yml` are protected from replacement.

`init --compose compose.yaml` imports a strict subset of Compose: app images/builds, argument-list commands, string environment maps, dependency lists, a single published port, and named file volumes. Host port numbers are discarded; routes use the container port. Database services, interpolation, health conditions, bind mounts, and unsupported fields fail with an explanation. Define managed databases explicitly in the resulting manifest. This is not a Compose runtime.

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

Use exactly one of `image` and `build`. Build contexts, Dockerfiles, and env files must remain within the manifest directory, including after resolving symlinks. Dockerfile paths are relative to that directory. Docker's build context ignore rules apply; exclude secrets from your build context. Images must support ARM64.

Commands are argument arrays; no host shell interpolation occurs. For an intentional shell command, use `[sh, -c, 'your command']`. The app must listen on `0.0.0.0` inside its container.

Dependencies start first. Managed databases use readiness commands; applications use `ready`, a TCP connection to `port`, or running-container status when neither is provided. Readiness has a 90-second deadline. A TCP check only proves that a port accepts connections; use `ready` for stronger checks.

`init` runs once on clean initialization. Forked services inherit matching initialization state from main. `migrate` runs on every deployment. These commands run in temporary containers with the service's network, environment, and volumes, before its normal process starts. Failed migrations leave a failed environment for inspection and retry; database changes are not rolled back automatically.

Use `{{contremaitre.url}}` to map the external application origin into a framework variable. It resolves to the reserved public URL when available and otherwise to the local URL. `{{contremaitre.local_url}}` always selects the local URL. Redeploy after reserving a tunnel to update application configuration.

Managed Postgres defaults to `postgres:17`, database/user `app`, and a generated password per environment. It stores data in an Apple named volume, under a subdirectory of the mount. This managed layout supports Postgres 17; changing an existing database image requires an explicit migration. Managed Redis defaults to `redis:7-alpine` and has no persistent volume, so it starts empty after each redeployment.

`{{service.host}}`, `{{service.port}}`, and `{{service.url}}` resolve within the environment. Declare referenced services in `depends_on`. Postgres URLs include credentials; Redis URLs select database 0. App URLs use internal container IPs. Port numbers can be identical across environments because service ports are not published on the host.

`env_file` supports one-line `KEY=value` entries, optional outer quotes, comments, and blank lines. It does not evaluate shell expressions or expand `${...}`. Explicit `environment` entries take precedence. Multiline values are unsupported.

Services receive `CONTREMAITRE_ENVIRONMENT`, `CONTREMAITRE_LOCAL_URL`, and, when reserved, `CONTREMAITRE_PUBLIC_URL`. The runtime retains private configuration needed to restart a deployed image, even after its source workspace changes.

## Environment identity and routing

Identity includes the project name, canonical workspace path, and branch/bookmark. Distinct workspaces on the same branch remain isolated. Switching branches selects another environment; switching back recovers its data. Moving a workspace directory changes its identity.

Git uses the current branch, or a detached commit label. Jujutsu uses its nearest unambiguous ancestor bookmark, falling back to `workspace` when no bookmark exists. Multiple bookmarks require `--branch NAME`. Unbookmarked changes in the same workspace do not create an environment per change. `--branch` is an explicit context override, not a VCS mutation.

URLs include a workspace suffix and hash, avoiding collisions after branch-name normalization. The alphabetically first HTTP service gets the environment URL; other HTTP services get an extra service prefix. Adding a service that sorts earlier changes that default assignment, so use service-specific configuration deliberately.

The first deployed `main` branch becomes the project's clone source. Use `deploy --main` to designate a source initially, or `contremaitre main --env ENV` to change it explicitly. Only one environment per project is designated main. It also gets `main.PROJECT.localhost`.

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

All builds finish before replacing existing processes. A build failure leaves the current application running. Image-based services use the image's code; local source changes require a build-based service.

A new environment clones matching Postgres services and declared file volumes from main. Main's running application services and workers stop while copying. The runtime dumps/restores the databases, copies files, and recreates the source writers in dependency order with refreshed addresses. Source writers are restarted even when cloning fails or the deploy is cancelled. A stopped main database starts temporarily for the dump and stops afterward. Avoid independent database/file writes through external clients during the copy.

Only the `app` database is cloned by the managed Postgres adapter. A matching source image is required. Files are copied by declared volume name; unsupported file types and symlinks produce errors. There is no synchronization back to main. PostgreSQL data and uploaded files must fit on disk during the copy, including the temporary dump.

Redeploy preserves data and does not recopy main. Upload directory names are scoped to an environment and may be shared by its services.

`down` removes container processes and retains data, configuration, network, and current build images. Redeployment recreates emptied networks to restore their host routes after inactivity. `--delete-data` also removes recorded databases, uploaded files, images, and network. It releases tunnel reservations first. Interrupted deletion can be retried; an environment mid-deletion cannot be deployed.

`prune` removes superseded Contremaitre build images. `prune --delete-data` also removes stopped environments that have no tunnel reservations. It never runs Apple's global prune or removes unrelated containers. Missing cached images can be removed from the registry idempotently.

`stop` stops all Contremaitre environments and exits the hub. The shared Apple container system remains available to other applications. RAM/CPU allocations are configurable per service; admission currently relies on Apple container errors. There is no automatic suspension or eviction.

`proxy` binds only `127.0.0.1` and stays in the foreground until interrupted. Omit the local port or use 0 for automatic allocation. An occupied explicit port is an error. Each new connection resolves the container's current address. Use `exec postgres -- psql -U app -d app` when you do not need an external database client.

## Tunnel providers

```sh
contremaitre tunnel web
contremaitre tunnel status
contremaitre tunnel stop
contremaitre tunnel release web
```

Configure an installed provider executable in `~/.local/share/contremaitre/tunnels.json`:

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

Provider credentials belong in the provider's credential store. The protocol is documented in [docs/tunnel-provider.md](docs/tunnel-provider.md). The local interface and process supervision are implemented and contract-tested. A production SaaS provider executable is not bundled: the sibling tunnel project had no implementation or API contract at development time.

Each reservation retains its provider and URL across stop/start and redeploy. A different configured default only affects new reservations. The daemon supervises active provider processes, retrying failed connections with a bounded delay. Providers own authentication renewal, remote session fencing, and transport reconnection. Explicit stop disables reconnect. Closing the hub through `stop` disables exposure.

Tunnels receive a dedicated loopback upstream that routes only to their selected HTTP service. Public host and HTTPS scheme are forwarded to the application. Creating a reservation does not restart the application; redeploy to receive a newly assigned `CONTREMAITRE_PUBLIC_URL` in its process environment.

## State, diagnostics, and development

Each state home has a distinct runtime resource namespace. Project names identify applications across workspaces; use a different project name for a different customer application.

State lives in `~/.local/share/contremaitre`, configurable with `--home` or `CONTREMAITRE_HOME`. The JSON state file and temporary env files are mode 0600; state includes database credentials and deployed environment values. Do not publish it. The daemon holds an exclusive filesystem lock and saves state using fsync plus atomic rename.

Use `--json` for versioned machine output. CLI failures exit nonzero; `exec` propagates the executed command's exit code. Exec and logs stream application output directly. Build diagnostics go to the daemon log. Startup errors report its location. TCP/HTTP application traffic is streamed and request bodies are not logged by the hub.

```sh
make check   # gofmt, vet, race tests, build
make build
```

See [docs/acceptance.md](docs/acceptance.md) and [docs/verification.md](docs/verification.md) for scope and verification results. The HTTP router supports WebSocket upgrades and streaming through Go's reverse proxy. Local TLS and automatic hot reload are outside this release.

## Existing Kubernetes projects

Use [project deployment drivers](docs/project-drivers.md) when a repository already needs its own Kubernetes deployment, workers, keys, or agent volumes. Contremaitre manages workspace identity, main-data forks, routing, and cleanup through the driver. See the [Kohral verification and Tokenops assessment](docs/complex-projects.md) for concrete integration requirements.
