# Foreground tunnel provider contract

The runtime shares all HTTP services in one terminal-owned session. Reservations persist; permission to forward does not. There is no detached mode. Providers must advertise `stable_urls`, `https`, and `foreground_sessions`; the runtime rejects older adapters before changing application configuration.

Providers are trusted installed executables with an absolute path in `tunnels.json`. They own authentication, device credentials, remote control calls, and the relay transport. Credentials must stay out of arguments, stdout, and diagnostic logs. The first-party path adds CLI-owned device authorization and automatic installation of a compatible adapter from the SaaS origin. See [SaaS onboarding](saas-onboarding.md) for its authentication, workspace, Keychain and artifact contract. Those SaaS endpoints and adapter changes must ship before the default path can work against the public service.

## Identity and control operations

The single command-line argument is `capabilities`, `reserve`, `start`, `stop`, or `release`. Except for `start`, stdin contains one JSON document followed by EOF:

```json
{
  "version": 1,
  "config": {"endpoint": "https://api.example.com"},
  "environment_id": "opaque-machine-scoped-environment-id",
  "machine_id": "persistent-installation-uuid",
  "workspace_id": "workspace-path-hash",
  "project": "shop",
  "branch": "feature",
  "service_id": "web",
  "display_name": "shop/feature-workspace-hash",
  "reservation_id": "provider-assigned-id"
}
```

The runtime persists a random installation ID in `CONTREMAITRE_HOME/tunnel-machine-id`. `environment_id` is the first 32 hexadecimal characters of SHA-256 over `machine_id + NUL + local environment ID`. This separates identical workspace paths on different computers. `workspace_id` is a path hash, not an absolute path. Do not copy installation state between machines. The server scopes these identifiers to the authenticated tenant and validates the authenticated device; metadata never authenticates a caller.

`reserve` is idempotent for tenant/environment/service and returns the same HTTPS origin after stop or reconnect. Display metadata must not determine identity. URLs must have no userinfo, non-root path, query, or fragment. Removed services' reservations stay stopped until explicitly released. Existing installations changing identity schemes must explicitly migrate or retire older reservations; the runtime does not claim URL preservation across an installation reset.

| Operation | Response and behavior |
|---|---|
| `capabilities` | `{"version":1,"capabilities":{"stable_urls":true,"https":true,"foreground_sessions":true,"websockets":true,"streaming":true}}` |
| `reserve` | `{"version":1,"reservation_id":"id","url":"https://web.example.com"}`. Reserve without forwarding. |
| `stop` | `{"version":1}`. End this adapter's current fenced session; preserve the URL. |
| `release` | `{"version":1}`. End forwarding and retire the reservation. |

Control operations have a 30-second timeout and a 1 MiB stdout limit. Nonzero exit or malformed response fails the operation. Errors must not expose secrets. The adapter must persist enough private session/generation metadata to make stop safe and idempotent across process death. A stale stop must never end a newer session.

## Streaming start, protocol version 2

`start` uses newline-delimited JSON on stdin and keeps stdin open. The first line is:

```json
{
  "version": 2,
  "config": {"endpoint": "https://api.example.com"},
  "environment_id": "opaque-machine-scoped-environment-id",
  "machine_id": "persistent-installation-uuid",
  "workspace_id": "workspace-path-hash",
  "project": "shop",
  "branch": "feature",
  "service_id": "web",
  "service_ids": ["api", "web"],
  "display_name": "shop/feature-workspace-hash",
  "reservation_id": "provider-assigned-id",
  "upstream": "http://127.0.0.1:43123",
  "session_id": "foreground-session-uuid",
  "expires_at": 1789000015000,
  "enabled": false
}
```

`service_ids` is the complete sorted set of public services in the group. All connectors share `session_id`. The upstream is a runtime-owned loopback proxy; it cannot be selected by visitors or by the remote API. Startup is disabled. The provider prepares its remote session and transport, then prints `{"version":2,"ready":true}` followed by a newline. Readiness must arrive within 30 seconds and be at most 64 KiB. It means the connector is prepared for activation, not that the group is already public. The process remains alive; diagnostics go to stderr. Further stdout is ignored.

The runtime then sends lease frames:

```json
{"version":2,"operation":"renew","session_id":"foreground-session-uuid","expires_at":1789000018000,"enabled":true}
```

The CLI renews hub ownership every three seconds. The hub grants a 15-second lease, including during preparation. The provider must process renewals while preparing and while connected. `expires_at` is an absolute UTC Unix-millisecond deadline; a delayed frame must not create a fresh full-duration lease. The adapter must cap remote validity at this deadline and the remote server must enforce its own maximum TTL. Frames must match the current session and cannot revive a stopped/expired generation.

The hub sets `enabled:true` only after all applications and connectors are ready. Before then, its local proxies return 503. The remote implementation must also gate the complete group until every declared member is prepared and enabled. The server must preserve HTTP methods, bodies, paths, query strings, headers, repeated response headers, WebSockets and streams. The runtime sets the public Host and authoritative HTTPS forwarding headers.

## Expiry, disconnect, and cleanup

EOF, SIGTERM, process exit, expired lease, or explicit stop ends exposure. Expiry and revocation must close existing HTTP streams and WebSockets as well as reject new requests. A reservation without a valid enabled lease returns an offline 503. The provider cannot extend the foreground deadline using its own keepalive. Do not replay application requests after uncertain failures.

The runtime polls workspace identity once per second and ends the session on a branch/bookmark change or inability to verify identity. This check is not atomic with source-file changes. It gates new local requests at lease expiry even if cleanup is delayed. Providers receive SIGTERM and then SIGKILL after five seconds if needed. Closing their runtime proxies destroys open connections.

Exit codes 77 and 78 mean permanent authorization/configuration failure and end the whole session. Other connector exits can be retried while the owner lease remains valid. Malformed readiness/capability responses are permanent failures.

A dead connector is restarted with bounded backoff while foreground ownership remains valid. Short network interruptions may reconnect inside the provider under the same deadline. Reconnect only control/transport operations. Reject permanent authorization errors; never use reconnection to undo stop or takeover. On hub restart, desired flags are cleared and local configuration is recovered; connectors do not resume automatically.

The server must independently enforce leases when the entire laptop or hub disappears. Advertising `foreground_sessions` without remote enforcement violates this contract.
