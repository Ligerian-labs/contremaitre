# SaaS tunnel onboarding

`contremaitre tunnel` uses `https://contremaitre.ligerianlabs.fr` when the user has not configured a provider in `<home>/tunnels.json`. A present but invalid custom configuration is an error. Custom providers keep their own login flow. Names starting with `saas:` are reserved for managed providers.

The CLI validates the local environment, completes authentication, selects a workspace and installs the provider before it asks the hub to start sharing. Login cannot restart services or reserve public URLs. `contremaitre tunnel login` authenticates without requiring a project, a running hub or installed transport. The next `tunnel` command continues with the saved credentials.

This contract targets the SaaS implementation in progress. The public endpoint, workspace APIs and downloadable provider manifest are not deployed yet. Local fixture tests verify the CLI contract; they do not establish compatibility with a deployed SaaS service.

## User flow

1. Honor a custom provider or the provider pinned to existing reservations.
2. Resolve the SaaS workspace from `--workspace ID`, the reservation's workspace or the saved selection. Reject an explicit workspace that conflicts with existing URLs. To move those URLs, release the reservations first.
3. If a credential exists, validate it with `GET /v1/cli/session`. Valid credentials need no browser approval or repeated workspace question. A 401 or 403 starts a new login in an interactive terminal. Network errors, server errors and invalid responses fail without starting another login.
4. If credentials are missing, open device authorization in the browser. Print the verification URL and code even if the browser cannot open. Existing website login still requires an explicit authorization of this computer. The page shows the account and computer name. Signup and verification can complete while the original command waits.
5. After approval, request the available workspaces. Ask the user if there is no explicit or saved selection, including when only one workspace exists. Validate explicit and saved choices against current membership.
6. Enroll a device scoped to the chosen workspace and save its credential in macOS Keychain. Save the workspace choice before installing binaries, so a failed download does not require another login.
7. Prepare the managed provider and create the foreground preview. Pass the selected provider ID to the hub so a concurrent change of default workspace cannot redirect the new session.

Noninteractive commands, including `--json`, reuse valid authentication and a saved or explicit workspace. They fail with an instruction to run `contremaitre tunnel login` in a terminal when approval is required. All interactive output goes to stderr. Cancellation stops polling and cannot create a preview. Device polling observes `interval`, adds five seconds for `slow_down` and stops at the server's expiry, capped at 15 minutes. Requests have ten-second deadlines and bounded response bodies; redirects are refused.

Authentication persists beyond the terminal. Sharing remains subject to the existing foreground lease. A revoked active device ends the entire session through adapter exit 77; neither the hub nor the adapter opens a browser or restores sharing automatically.

## HTTP contract for the SaaS implementation

These endpoints return direct JSON objects, without the generic control envelope. Fields may be added. IDs contain 1–128 ASCII letters, digits, underscores or hyphens.

`POST /oauth/device/code` accepts form fields `client_id=contremaitre-cli`, `scope=tunnels` and `device_name`. The name is display metadata, not proof of identity. Return:

```json
{
  "device_code": "opaque-secret",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://contremaitre.ligerianlabs.fr/device",
  "expires_in": 600,
  "interval": 5
}
```

The verification URL must use the exact configured HTTPS origin and cannot contain credentials or a fragment. The CLI opens that URL and displays the code; `verification_uri_complete` is optional and unused.

`POST /oauth/device/token` accepts `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `client_id=contremaitre-cli` and `device_code` as form fields. Pending responses use HTTP 400 and `error` values `authorization_pending` or `slow_down`. Denial uses `access_denied`; expiry uses `expired_token`. Success returns `access_token`, an enrollment grant. This grant never leaves CLI memory and is never the lasting tunnel credential.

`GET /v1/cli/workspaces`, with the enrollment grant as a Bearer token, returns:

```json
{
  "account_id": "user-123",
  "workspaces": [
    { "id": "personal-123", "name": "Personal" },
    { "id": "team-456", "name": "Example team" }
  ]
}
```

List only memberships the approved account can use for tunnels. Browser approval must make clear that the CLI can select from these workspaces. A page-specific tenant must not silently restrict or override the CLI choice.

`POST /v1/devices/enroll`, with that same grant, accepts JSON `{"name":"computer name","tenant_id":"team-456"}`. Validate membership again, the approving account, grant expiry and revocation. The tenant is a requested scope, never authorization evidence. Return:

```json
{
  "account_id": "user-123",
  "workspace_id": "team-456",
  "device_id": "device-789",
  "credential": "opaque-device-secret"
}
```

The account must match the approved grant; the workspace must match the CLI choice. The credential authorizes only that workspace. Enrollment must be idempotent for a consumed grant and the same selection, and must reject attempts to reuse a grant for another workspace. The CLI does not automatically retry enrollment after an uncertain response. The current short enrollment lifetime can expire while the user chooses a workspace; return 401 and require a fresh approval rather than extending authorization implicitly.

`GET /v1/cli/session`, with the stored device credential, validates device expiry, revocation and current membership. Return `account_id`, `workspace_id` and `workspaces` in the shapes above. Return 401 or 403 for expired, revoked or unusable credentials. Switching to a workspace with no saved credential requires fresh browser approval; do not let a tenant-scoped credential grant itself another tenant.

## Credential and adapter contract

The Keychain service is `contremaitre-tunnel`. The Keychain account is the exact string `https://contremaitre.ligerianlabs.fr#WORKSPACE_ID`. The value is base64-encoded JSON with `device_id` and `credential`. Base64 is an encoding; Keychain provides secret storage. The CLI writes through `security -i` stdin and verifies the write, so credentials never enter process arguments. A locked or unavailable Keychain fails explicitly.

The managed adapter receives these additional configuration fields through stdin:

```json
{
  "endpoint": "https://contremaitre.ligerianlabs.fr",
  "tenant_id": "team-456",
  "credential_account": "https://contremaitre.ligerianlabs.fr#team-456",
  "foreground_sessions": true,
  "state_directory": "/absolute/home/saas/state/team-456",
  "transport": "/absolute/home/saas/HASH/transport",
  "frpc": "/absolute/home/saas/HASH/frpc",
  "ca_file": "/absolute/home/saas/HASH/ca"
}
```

The adapter must read the specified `credential_account`. An adapter that only reads the endpoint's origin will not work with this CLI. It must validate the account's endpoint/workspace association and use the server-authenticated workspace for every operation. It must never replace scoped credentials with a global account or launch login during a session. Existing explicitly configured adapters can keep their original credential convention.

Only the CLI reads `<home>/saas-login.json`, which stores `workspace_id`. Managed provider descriptors live in `<home>/saas/providers/WORKSPACE_ID.json`; `<home>/saas-provider.json` contains the last selected default. Descriptors contain paths and credential references, never secrets. Independent per-workspace descriptors prevent concurrent selection from deleting another workspace's configuration. The hub stores provider IDs as `saas:WORKSPACE_ID` alongside reservations. An explicit `tunnels.json` takes precedence for new reservations.

## Automatic provider installation

Publish `GET /.well-known/contremaitre-provider/darwin-arm64.json` on the same HTTPS origin. No authentication is sent for manifest or artifact downloads. Return:

```json
{
  "version": 1,
  "protocol": 2,
  "credential_accounts": true,
  "platform": "darwin-arm64",
  "artifacts": {
    "provider": { "url": "/downloads/VERSION/provider", "sha256": "64-lowercase-hex-digits" },
    "transport": { "url": "/downloads/VERSION/transport", "sha256": "64-lowercase-hex-digits" },
    "frpc": { "url": "/downloads/VERSION/frpc", "sha256": "64-lowercase-hex-digits" },
    "ca": { "url": "/downloads/VERSION/ca.pem", "sha256": "64-lowercase-hex-digits" }
  }
}
```

Publish raw Apple Silicon executables, not archives. The provider must be standalone and understand protocol v2, scoped Keychain accounts and the transport configuration above. `ca` supplies the trust roots required by the adapter's control and relay connections. Publish a complete compatible set, with immutable versioned URLs, before publishing the manifest.

Downloads must remain on the same origin; redirects and URL credentials are refused. The CLI verifies SHA-256 before atomic installation. Executables use mode 0700 and the CA file uses 0600. Each artifact is capped at 128 MiB with a two-minute deadline. Installation publishes the cached manifest only after every artifact is verified. No download or install operation invokes a shell, extracts an archive or asks for administrator privileges.

The cache pins a working set across commands. Each command checks its hashes and repairs missing or corrupted files. A failed or cancelled install does not publish a managed provider. To fetch a newer manifest, remove `<home>/saas/manifest.json` before the next command. Old artifact directories remain available for active sessions and rollback; automatic updates and cache garbage collection are outside this change.

## Acceptance and rollout

- A fresh CLI authenticates, prompts for workspace and prepares the first-party provider without a manual configuration file or executable installation.
- Valid saved authentication skips browser approval. Revoked credentials require fresh approval at the next startup; server outages do not trigger login.
- A custom provider remains authoritative, including when it is malformed or unavailable.
- Explicit workspace selection wins over saved selection for new reservations. Existing reservations stay scoped to their original workspace.
- Pending approval, signup, verification, browser launch failure, denial, expiry, cancellation and noninteractive use have bounded, actionable outcomes.
- Credentials stay out of project files, provider descriptors, hub requests, stdout and diagnostic messages.
- Provider installation rejects invalid protocols, redirects, foreign origins and checksum mismatches. Interrupted installation is retryable without losing the saved login.
- The CLI passes its chosen provider through the hub request. Foreground lifetime, local URL restoration and revocation behavior remain unchanged.

Deploy the new auth endpoints and adapter account support, publish and verify the artifact set, then exercise the actual CLI against a staging SaaS instance before claiming production compatibility. The browser approval page must be tested with an existing login, a new account, verification pending, revoked membership and denied approval. Do not advertise the downloadable adapter until remote group leases and revocation close existing streams as specified in `tunnel-spec.md`.
