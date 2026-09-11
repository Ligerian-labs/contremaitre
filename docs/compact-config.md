# Compact development configuration

Run `contremaitre init` in your application repository. Setup inspects the development scripts, runtimes and ports, asks about uncertainty, and writes two files to commit:

- `.contremaitre.yaml` contains your choices and application-specific mappings.
- `.contremaitre.lock` contains the detected launch settings and their resolved values.

A single application can need only this authored configuration:

```yaml
project: example
apps:
  app: .
```

`app` names a container. `.` is the application directory relative to the repository. The lock supplies the image, startup command, installation command, source synchronization and endpoints. Version may be omitted or set to `2`. Existing version 1 manifests remain supported and need no lock.

## Overrides and application wiring

Use an object when an app needs overrides. Its `path` defaults to `.`:

```yaml
project: example
apps:
  app:
    endpoints: {api: 8000, viewer: 4200, admin: 4300}
    env_file: [.env, .env.local]
    environment:
      DATABASE_URL: '{{postgres.url}}'
      API_BASE_URL: '{{api.browser_url}}'
      APP_BASE_URL: '{{viewer.browser_url}}'
      LOCAL_MEDIA_ROOT: /data/media
    volumes: {media: /data/media}
    memory: 6G
services:
  postgres:
    kind: postgres
```

Keep environment variable names, allowed-host settings, CORS rules, passkey settings and application data paths explicit. Env file contents and generated database credentials never enter the lock. Explicit `environment` values override env files as in version 1.

App objects accept the existing service fields, including `image`, `build`, `command`, `working_dir`, `dev`, `cpus`, `memory`, `init`, `migrate`, `ready`, and `depends_on`. Commands are argument arrays. An override replaces the whole field, including maps and arrays. Removing an override restores its setup default. An explicit `image` replaces a detected build; `build` replaces a detected image. An `endpoints` map replaces the detected map or single-port route; `port`/`http` overrides replace detected endpoints.

Internal `host`, `port`, and `url` references in explicit environment mappings imply startup dependencies on the owning container. References in env files still need explicit `depends_on`. Browser URL references need no startup dependency. Other startup constraints can use `depends_on` explicitly.

## Containers and endpoints

Setup prefers the repository's existing development runner, such as `bun run dev` invoking Turbo, to run compatible applications together. It proposes separate containers when the same environment key needs different values. Extra environment keys can be shared. Runtime requirements, port collisions and the runner's ability to start a subset also constrain grouping. Setup asks when it cannot establish a working command. It does not invent a process supervisor.

For example, incompatible `PORT` mappings belong in separate apps:

```yaml
project: example
apps:
  api:
    path: apps/api
    environment: {PORT: '8000'}
  viewer:
    path: apps/viewer
    environment: {PORT: '4200'}
```

Each `endpoints` entry names an HTTP listener in its container. Names must be unique across the project and cannot shadow another container. Ports can be detected during setup or explicitly overridden. Use `endpoints: {}` for a worker with no HTTP listener. Servers must listen on `0.0.0.0` and accept their local hostnames; setup must establish the needed framework flags from repository evidence.

`{{api.browser_url}}`, `{{api.local_url}}`, and `{{api.browser_origins}}` work for named endpoints. Internal `{{api.url}}` selects its port and uses loopback when consumed by the same container. The alphabetically first endpoint receives the environment's base hostname. `{{contremaitre.url}}` selects the consuming container's alphabetically first endpoint. Use an explicit endpoint reference when that choice matters.

`show`, verification URL maps and public sharing include all named endpoints. Logs, execution, resource limits, verification's `service` selector and restarts use container names. All named ports must listen before a container becomes ready, even when it also has a custom `ready` command. The repository runner manages child-process failures. Contremaitre does not restart individual children.

## Lock lifecycle

Deploy and ensure compare the authored configuration with the lock. Config edits automatically refresh the lock from explicit overrides and saved setup defaults. Refresh validates the result before atomically replacing the old lock and logs which containers' launch settings changed. Commit the resulting diff. Invalid config, unresolved app paths, missing env files, and invalid references leave the old lock intact and report an error.

Deploy does not inspect package scripts, select new runtimes, infer ports, invoke an agent or ask questions. Source and dependency changes alone do not refresh configuration. Developers update the YAML when launch requirements change. Existing source synchronization and dependency redeployment rules still apply.

A new app or changed app path normally requires `contremaitre init`. A fully explicit development launch recipe can be resolved directly. A missing or malformed lock requires setup; it is never silently recreated during deployment. Read-only queries do not refresh the lock. Commit both files so another machine or worktree can deploy without repeating discovery. Image tags are recorded, not registry content digests; registry availability and image contents remain external dependencies.

Run `contremaitre init --no-ai` to resolve an existing compact config using conventional detection, or to create one for a conventional development project. This explicitly reruns setup discovery. It preserves your YAML. Unsupported or ambiguous detection exits with an explanation; interactive `contremaitre init` can inspect more files and ask questions. Existing version 1 files require assisted init for updates or conversion.

Conventional development detection reads a pinned `packageManager`, the `dev` script and literal `--port` or `PORT=` settings. It can follow unfiltered Turbo development scripts through declared workspaces. It supports Bun, npm, pnpm and Yarn Classic. Bun-only projects use `oven/bun:<version>`; projects also declaring Node requirements use a Node image with pinned Bun through `npx`. Other Node package managers require `engines.node`. Existing package lockfiles select frozen installation. Framework-specific ports, modern Yarn, filtered task graphs, other runtimes and custom images may require assisted setup or explicit overrides.

Try the runnable [two-endpoint example](../examples/development/README.md).
