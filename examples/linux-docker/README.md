# Docker on Linux

This stack runs a Bun HTTP service, PostgreSQL 17, Redis 7 and a one-time database migration. Editing `server.mjs` updates the running service through source sync. The migration seeds one message. HTTP requests read PostgreSQL and increment a Redis counter.

Use a Linux x64 or ARM64 machine with Bun 1.4.2, Git, Make, GNU tar and local rootful Docker Engine. Your user must be able to run `docker info`. Use Docker's local Unix socket. Remote Docker hosts, rootless Docker, Docker Desktop and running the hub outside the Docker host's network namespace are unsupported because the hub connects directly to bridge IPs. Docker installation instructions are at <https://docs.docker.com/engine/install/>.

From the repository root, build and install:

```sh
bun install --frozen-lockfile
bun run build
install -Dm755 bin/contremaitre "$HOME/.local/bin/contremaitre"
export PATH="$HOME/.local/bin:$PATH"
contremaitre version
```

Build on the machine that will run the executable. The build uses the current operating system and architecture. Linux release downloads and automatic updates are tracked separately in issue #88. Pass `--http` to each `ensure` call so it agrees with the HTTP hub. The commands below use HTTP; Linux local HTTPS is tracked in #94.

Start the hub and deploy this example:

```sh
contremaitre start --http --http-port 18080
cd examples/linux-docker
contremaitre ensure --http --http-port 18080 --json
contremaitre verify --profile smoke --json
contremaitre report --json
contremaitre show --json
```

Open the `web` URL printed by `show`. A response contains `runtime: "docker"`, a message with `body: "Hello from Linux Docker"`, and an increasing `visits` count. The smoke profile checks this response from inside the web container. Linux chooses Docker for services that omit `runtime`; the web service sets `runtime: docker` explicitly.

The hostname routes through the local hub. For a shell request without local DNS resolution, use the printed hostname in the Host header:

```sh
curl -H 'Host: HOSTNAME-FROM-THE-WEB-URL' http://127.0.0.1:18080/
```

Inspect the application and migration output with `contremaitre logs web` and `contremaitre logs migrate`. Rerunning `ensure` reuses unchanged images and completed jobs. Change the text in `server.mjs`, wait for source sync, and request the URL again to see the update.

Stop this environment while retaining its data:

```sh
contremaitre down
contremaitre ensure --http --http-port 18080 --json
```

Remove only this environment, including its database and named volumes:

```sh
contremaitre down --delete-data
```

The automated scenario uses a separate temporary project and state home. Run it from the repository root on Linux:

```sh
CONTREMAITRE_FIXTURES=1 bun scripts/verify-docker.ts --cleanup
```

The `docker/native-stack` scenario takes `{}` input and reports its run and environment IDs. It checks image reuse, retained migration jobs, HTTP/PostgreSQL/Redis, source sync, persistent data across `down`, independent branch database forks, hub recovery, exec, logs and scoped cleanup. `--keep` retains its state and serves its printed URLs until interrupted; start a later hub with the printed `CONTREMAITRE_HOME` to reuse that state. Each run uses independent project data.
