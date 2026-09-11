# Manifest configuration

Keep `.contremaitre.yaml` at the application repository root. Names are lowercase DNS labels, at most 40 characters. Preserve an existing `project` name because it identifies the application's environments and main-data source.

## Compact development config

Prefer a compact config for new development stacks. Start with `project: example` and `apps: {app: '.'}`. App objects can specify `path`, application-specific environment mappings, volumes and any service overrides. Keep databases under `services`. Run `contremaitre init --no-ai` after writing this config to detect conventional launch settings and create `.contremaitre.lock`; this command can also resolve an existing compact config without an interactive session. Commit both files.

Declare `endpoints: {api: 8000, web: 4200}` when ports are known. Setup can detect literal ports in development scripts; ambiguity produces an actionable error. Supply the missing overrides from repository evidence and retry. Deployment uses saved settings and automatically refreshes the lock after config edits. It never runs setup discovery. For unfamiliar runtimes, a fully explicit launch recipe or interactive setup by the developer may be needed. Do not launch an interactive setup conversation inside another agent.

Group compatible processes under the repository's existing runner. Overlapping environment keys must have identical values; extra keys can be shared. Conflicting values require separate app containers. Do not group incompatible runtimes or colliding ports. The runner owns child processes, and the group restarts as one container. Size its resources for the whole group.

Named endpoint references work with `browser_url`, `local_url`, `browser_origins`, `host`, `port` and `url`. Compact config infers startup dependencies from internal references in explicit environment mappings. Keep application-specific settings such as CORS, allowed hosts and passkey identity visible in YAML. Logs, exec and verification's `service` selector use container names; browser URLs use endpoint names. Preserve an existing version 1 configuration unless conversion is requested.

## Explicit version 1 configuration

This example assumes an API at `apps/api/src/main.ts` and an existing `test:e2e` script. Replace paths, commands and runtime image with the application's actual values. Omit services it does not need.

```yaml
version: 1
project: example
services:
  db:
    kind: postgres
  cache:
    kind: redis
  api:
    image: oven/bun:1.4.2
    working_dir: /app/apps/api
    command: [bun, --watch, src/main.ts]
    port: 3000
    http: true
    depends_on: [db, cache]
    environment:
      HOST: 0.0.0.0
      DATABASE_URL: '{{db.url}}'
      REDIS_URL: '{{cache.url}}'
      PUBLIC_BASE_URL: '{{contremaitre.url}}'
      DATA_DIR: /data
    volumes:
      uploads: /data
    dev:
      source: .
      target: /app
      install: [bun, install, --frozen-lockfile]
verification:
  exclude: [test-results, playwright-report]
  profiles:
    smoke:
      - name: browser
        command: [bun, run, test:e2e]
        timeout_seconds: 180
```

## Application containers

Choose exactly one of `image` or `build` per app service. For existing Dockerfiles use `build: .` and `dockerfile: path/to/Dockerfile`. Both paths are relative to the manifest directory. Images must support ARM64. Commands are argument arrays; use `[sh, -c, '...']` only when a shell is needed. Apps must listen on `0.0.0.0` at their declared port. `http: true` enables a local HTTPS route to that internal HTTP port.

For hot reload, `dev.source` must stay inside the project. A monorepo usually needs its root so shared packages are available. `dev.target` is an absolute container directory; `working_dir` must be inside it. The image needs the app runtime, `sh` and `tar`. Run the app's watcher directly, not a development wrapper that launches Docker. Dependencies install at `dev.target` on deployment. Lockfile and package manifest edits require redeployment; ordinary source edits sync to the running container. `ensure` after edits establishes fresh verification evidence even with a watcher.

`env_file` accepts a relative path or an ordered list. Later files override earlier ones; `environment` overrides all of them. Reference existing files without copying secret values into the manifest. Source sync excludes `.env*`, `.pem`, `.key` and generated dependency directories. Build contexts need matching Docker ignore rules to exclude secrets and generated output.

## Storage and startup

Managed PostgreSQL uses PostgreSQL 17, database/user `app`, and per-environment generated credentials. Managed Redis is ephemeral. Use `{{db.url}}` and `{{cache.url}}` with `depends_on`; do not override managed database credentials, storage or initialization. Browser-facing references such as `{{api.browser_url}}` do not require startup dependencies.

Declare persistent app files with `volumes: {uploads: /data}`. Persistent paths must not overlap `dev.target`. Main-data forks copy the managed `app` database and matching declared file volumes into new environments. Existing environments retain their data on redeploy and `down`; migrations do not roll back automatically. Do not use `down --delete-data` to solve an ordinary deployment failure.

Optional `init`, `migrate` and `ready` are command arrays from the application's actual scripts. `init` runs on clean initialization; a fork inherits matching initialization state. `migrate` runs when the app is replaced. Both run in temporary containers, so installing system libraries there does not change the final app image. Put required libraries in the image. `ready` should assert app health; without it the default may only check a listening port.

## Verification

Host checks run in the manifest directory. Adding `service: api` runs a check inside that service instead. Both receive `CONTREMAITRE_BASE_URL`, `CONTREMAITRE_URLS` as JSON, and `CONTREMAITRE_ARTIFACTS`. Host checks get browser URLs; native service checks get private network URLs. Reuse existing test scripts and configure their base URL and artifact directory from these variables.

Native service checks need `sh`, `env`, `mkdir`, `cat`, `rm`, `sleep`, `setsid` and `timeout` in the image. They may declare relative `artifacts: [screenshot.png, trace.zip]` for retrieval. Host checks collect files written under the supplied artifact directory automatically. Add generated test output to `verification.exclude` and build ignore rules; do not exclude source or test configuration.

Missing profiles return `not-configured`, not success. A successful command only proves its assertions. Inspect a screenshot before claiming visual verification.

If the project already uses a deployment driver, preserve it. `driver` and native `services` are mutually exclusive. Read the project's driver contract before changing its configuration; do not convert a Kubernetes stack into native services as an incidental setup step.
