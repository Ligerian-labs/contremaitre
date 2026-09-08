# Executable tunnel provider protocol v1

A provider is a trusted, explicitly installed executable with an absolute path. Contremaitre invokes it without a shell. The single positional argument is the operation. Each invocation receives one JSON request on stdin, followed by EOF. Credentials are never supplied through arguments.

Every request has `version: 1`. Fields are:

```json
{
  "version": 1,
  "config": {"endpoint": "https://api.example.com"},
  "environment_id": "opaque-local-environment-id",
  "service_id": "web",
  "display_name": "shop/feature-workspace-hash",
  "reservation_id": "provider-assigned-id",
  "upstream": "http://127.0.0.1:43123"
}
```

Fields not relevant to the operation are omitted. Providers must scope environment identities to the authenticated SaaS tenant. Display names are not identities. Control operations must be idempotent.

| Operation | Behavior | JSON response |
|---|---|---|
| `capabilities` | Report supported behavior | `{"version":1,"capabilities":{"stable_urls":true,"https":true,"websockets":true,"streaming":true}}` |
| `reserve` | Return the existing or new reservation for this environment/service | `{"version":1,"reservation_id":"id","url":"https://name.example.com"}` |
| `start` | Attach the reservation to the supplied loopback upstream and keep running | First stdout line: `{"version":1,"ready":true}` |
| `stop` | Disable forwarding but preserve the reservation | `{"version":1}` |
| `release` | Disable forwarding and retire the reservation | `{"version":1}` |

Non-start operations must finish within 30 seconds. Their stdout contains one JSON response of at most 1 MiB. `start` must emit a newline-terminated ready event within 30 seconds, and continue running until SIGTERM. Extra stdout after readiness is discarded. Diagnostic stderr is private to the local hub. Do not log credentials, request payloads, cookies, or authorization headers.

The provider process and child process group receive SIGTERM on stop, followed by SIGKILL if they do not exit within five seconds. The provider must clean up remote sessions on disconnect. Contremaitre also invokes `stop`; failure is surfaced to the caller. Retrying start after a hub crash uses the same reservation. The provider must fence stale sessions server-side.

Providers must support stable URLs and HTTPS. The initial adapter does not translate provider-specific capabilities. A nonzero exit or invalid response fails the operation. Contremaitre retries desired disconnected start processes with a delay capped at one minute. Providers must avoid leaking secrets in diagnostic messages and implement their own bounded transport reconnection and credential refresh.

The upstream exists only on the developer's loopback interface. It follows service redeployments, and the hub supplies the reserved public Host and `X-Forwarded-Proto: https` to the application. The provider must preserve HTTP methods, paths, queries, request bytes, relevant headers, repeated response headers, WebSockets, and streams. Do not replay application requests after uncertain failures.

The first-party SaaS connector should implement these commands as an adapter around its actual control API and session transport. No API endpoint or session credential shape is assumed by the local runtime.
