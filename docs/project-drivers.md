# Project deployment drivers

A project driver lets Contremaitre manage a stack that already owns its deployment logic. Kohral uses this interface for a dedicated k3d cluster per workspace, its Helm release, worker processes, private keys, HTTPS, and agent volumes. Simple application stacks continue to use the native Apple container runtime.

Commit a manifest and a self-contained executable in the application repository:

```yaml
version: 1
project: example
driver:
  executable: bin/contremaitre.py
  timeout_seconds: 1800
```

`driver` and `services` are mutually exclusive. The executable must be a regular executable file inside the project after symlink resolution. The timeout defaults to 1800 seconds and accepts 1 through 7200. Driver code executes on the host with the user's authority, just like the project's existing deployment scripts. It must not contain credentials.

After the manifest is present, use the normal commands:

```sh
contremaitre deploy --main
contremaitre deploy
contremaitre exec api -- bun src/cli.ts --help
contremaitre logs api
contremaitre proxy postgres 0:5432
contremaitre down
contremaitre down --delete-data
contremaitre prune --delete-data
```

Deployment snapshots the driver executable into private Contremaitre state. Stop, deletion, exec, logs, and proxy use that copy, so removing or modifying the source checkout does not replace the lifecycle code for a deployed environment. The driver may read the current project files during deployment; its cleanup methods must work without them. Other imported scripts are not snapshotted automatically.

## Protocol version 1

Contremaitre invokes the executable without command-line arguments. `CONTREMAITRE_REQUEST` names a temporary JSON file with mode 0600. Stdin remains available for interactive exec. The process working directory is its private state directory.

```json
{
  "version": 1,
  "operation": "deploy",
  "environment": {
    "id": "0123456789abcdef",
    "project": "example",
    "root": "/path/to/workspace",
    "state_directory": "/private/contremaitre/drivers/0123456789abcdef",
    "resource_prefix": "cm-abcdef-0123456789abcdef",
    "host": "main-workspace-01234567.example.localhost"
  }
}
```

The resource prefix includes the state-home namespace and environment identity. Drivers must scope every resource, network, volume, registry, and kubeconfig to it. Never use the user's default Kubernetes context, fixed shared cluster names, or global prune commands. Reserve and retain local ports in the private state directory. A port conflict must be explicit; it must not silently change an established URL.

| Operation | Required behavior |
|---|---|
| `preflight` | Validate tools and configuration without changing external resources. |
| `clone` | Copy from the `source` context before the destination's first deploy. Fail explicitly if the data cannot be copied safely. |
| `deploy` | Build current files, create or update owned resources, migrate, and wait for readiness. Preserve existing data. |
| `status` | Inspect resources and return their actual state. Used when the hub restarts and to reconcile failed redeploys. |
| `recover` | Resume source writers after a failed or interrupted clone. Safe to repeat when no recovery is pending. |
| `stop` | Stop owned processes and retain data and ports. Safe to repeat. |
| `delete` | Remove owned resources and data. Safe to retry after partial deletion. |
| `exec` | Execute `arguments` in the named `service`, forwarding stdin/stdout/stderr and the child exit status. |
| `logs` | Stream the named service's logs. |
| `proxy` | Forward the service port described by `arguments[0]`, binding only loopback. `0:5432` requests a free port. |

`clone` receives a `source` object with the same context fields as `environment`. `exec`, `logs`, and `proxy` receive `service` and an `arguments` array. Those interactive operations use their streams directly. Other operations return exactly one JSON object on stdout:

```json
{
  "version": 1,
  "status": "running",
  "services": {
    "web": {
      "host": "127.0.0.1",
      "port": 49100,
      "http": true,
      "url": "https://main-workspace-01234567.example.localhost:49101"
    },
    "api": {},
    "postgres": {}
  }
}
```

Successful `deploy` must report `running` and at least one service. `stop` and `delete` must confirm `stopped`. The response is limited to 1 MiB; unknown fields and trailing JSON are rejected. Diagnostics and live progress belong on stderr. Flush output during long operations so the CLI receives it immediately. The hub captures stderr for `contremaitre deploy logs` and `deploy logs --follow`; the default deploy view shows one aggregate driver status row. Driver stdout is reserved for this JSON response. Emit build stages, migration progress, and readiness details without dumping secrets or protocol payloads. Contremaitre stores them in a private, rotated `driver.log`; protocol errors do not echo stderr to the public API.

HTTP upstreams must use loopback addresses. An optional `url` overrides the printed local URL and must use the environment hostname or a service subdomain beneath it. This allows a Kubernetes driver to terminate trusted local HTTPS itself while providing a plain HTTP upstream for the hub and tunnel adapter. The driver is responsible for accepting routed Host headers and forwarding the external origin correctly. OAuth callbacks and application URL settings must also be configured for the selected public URL; reserving a tunnel alone does not rewrite arbitrary driver configuration.

## State and failure behavior

Identity still includes the branch/bookmark and workspace path. Two workspaces on the same branch receive distinct state directories and resource prefixes. Driver environments participate in main selection, down, stop, and explicit data pruning. Native and driver environments cannot be silently converted or cloned across runtimes.

Contremaitre records clone completion before subsequent redeploys. A failed clone does not mark data as copied; it invokes the source driver's `recover` operation with a separate two-minute recovery budget. Drivers must journal stopped writers before stopping them and keep the journal if recovery fails. Cancelled processes receive SIGTERM as a group, followed by SIGKILL if they do not exit within four seconds. A future invocation must be able to resume from persisted recovery state.

Driver operations run with their configured deadlines. Interactive operations last until the command finishes or the user cancels. The daemon serializes lifecycle changes. Failed deployments retain their environment record, error, and private diagnostics. If a running environment survives a failed redeploy, Contremaitre checks `status` and preserves its route. Failed deletion retains the record for an explicit retry.

A driver must define what a coherent fork includes. PostgreSQL alone is insufficient for a project with encrypted records, persistent agents, queues, or image references. Do not mark a clone complete after omitting unsupported state.
