# SaaS tunnel onboarding

`contremaitre tunnel` uses `https://contremaitre.ligerianlabs.fr` when the user has not configured a provider in `<home>/tunnels.json`. A present but invalid custom configuration is an error. Custom providers keep their own login flow. Names starting with `saas:` are reserved for managed providers.

Any other service implementing this contract can be selected with `contremaitre tunnel login --endpoint https://tunnels.example.com` (also accepted by bare `tunnel`). Examples below use the default origin; a custom endpoint substitutes its own. See [Custom endpoints](#custom-endpoints).

The CLI validates the local environment, completes authentication, selects a workspace and installs the provider before it asks the hub to start sharing. Login cannot restart services or reserve public URLs. `contremaitre tunnel login` authenticates without requiring a project, a running hub or installed transport. The next `tunnel` command continues with the saved credentials.

The subscription preflight requires the matching SaaS API change. Deploy that change before releasing this CLI. Local fixture tests verify the contract; they do not establish compatibility with a deployed SaaS service.

## User flow

1. Honor a custom provider or the provider pinned to existing reservations.
2. Resolve the endpoint from the reservation's provider ID, `--endpoint` or the saved selection, in that order, defaulting to `https://contremaitre.ligerianlabs.fr`. Reject an explicit endpoint that conflicts with existing URLs.
3. Resolve the SaaS workspace from `--workspace ID`, the reservation's workspace or the saved selection. Reject an explicit workspace that conflicts with existing URLs. To move those URLs, release the reservations first.
4. If a credential exists, validate it with `GET /v1/cli/session`. Valid credentials need no browser approval or repeated workspace question. A 401 or 403 starts a new login in an interactive terminal. Network errors, server errors and invalid responses fail without starting another login.
5. If credentials are missing, open device authorization in the browser. Print the verification URL and code even if the browser cannot open. Existing website login still requires an explicit authorization of this computer. The page shows the account and computer name. Signup and verification can complete while the original command waits.
6. After approval, request the available workspaces. Ask the user if there is no explicit or saved selection, including when only one workspace exists. Validate explicit and saved choices against current membership.
7. Enroll a device scoped to the chosen workspace and save its credential: in macOS Keychain on a Mac, in a private file under the hub home on Linux. Save the workspace choice before installing binaries, so a failed download does not require another login.
8. Query `GET /v1/cli/access` with the device credential before downloading a provider, reserving URLs or changing services. If a subscription is required, print an actionable message and open the returned subscription page in interactive terminals. Noninteractive commands print the URL without opening a browser. Keep the saved login so subscribing and retrying does not require another authorization.
9. Prepare the managed provider and create the foreground preview. Pass the selected provider ID to the hub so a concurrent change of default workspace cannot redirect the new session.

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

The verification URLs must use the exact configured HTTPS origin and cannot contain credentials or a fragment. The CLI opens `verification_uri_complete` when supplied, or adds `user_code` to `verification_uri`. Both URLs must use the same path. The CLI prints the base URL and code as a manual fallback. The page fills in the code and loads the named computer for approval, including after sign-in. Opening the link does not approve the device.

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

## Subscription access

`GET /v1/cli/access` authenticates the workspace device and returns:

```json
{
  "workspace_id": "team-456",
  "can_share": false,
  "reason": "subscription_required",
  "subscription_url": "https://contremaitre.ligerianlabs.fr/billing?workspace=team-456"
}
```

An entitled workspace returns `can_share: true` and `reason: null`. The CLI rejects missing or inconsistent fields and mismatched workspaces. A subscription URL must use the configured origin, `/billing`, and the selected workspace query. Authentication failures and service outages remain errors, not subscription redirects. `tunnel login` can still authenticate without a subscription.

The SaaS checks entitlement again before writing reservations or preview metadata. Rejected requests return HTTP 403 with code `SUBSCRIPTION_REQUIRED` and leave no new tunnel or preview. Existing reservations are retained. Deploy the SaaS access endpoint and reservation check before releasing this CLI. Older servers without the endpoint fail closed before sharing.

## Credential and adapter contract

The Keychain service is `contremaitre-tunnel`. The Keychain account is the exact string `ENDPOINT#WORKSPACE_ID`, where `ENDPOINT` is the endpoint origin, for example `https://contremaitre.ligerianlabs.fr#WORKSPACE_ID` or `https://localhost:8443#WORKSPACE_ID`. Two endpoints therefore never share a credential. The value is base64-encoded JSON with `device_id` and `credential`. Base64 is an encoding; Keychain provides secret storage. The CLI writes through `security -i` stdin and verifies the write, so credentials never enter process arguments. A locked or unavailable Keychain fails explicitly.

On Linux, where a headless server has no login keychain, the CLI stores each credential in `CONTREMAITRE_HOME/saas-credentials/`, by default `~/.local/share/contremaitre/saas-credentials/`. The directory must be mode 0700 and owned by the user. Each account has one file, named by the SHA-256 of the account string and written atomically with mode 0600. The file is JSON with `version`, `account`, `device_id` and `credential`, and the CLI reads it back after writing. A group- or world-accessible directory or file, a symbolic link, a file owned by another user, a corrupt file, or a file whose `account` differs from the one requested fails closed with a message naming the fix. File permissions protect the credential from other users; they do not protect it from the owning user or root. Back the directory up with the rest of the hub home, or log in again on a new machine.

On macOS, the device flow opens the verification page with `open`. On Linux it uses `xdg-open` when `DISPLAY` or `WAYLAND_DISPLAY` is set. On a headless server it opens nothing: the CLI prints the URL and code, and you approve on any device while the command waits.

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

Only the CLI reads `<home>/saas-login.json`, which stores `workspace_id` and, for a custom endpoint only, `endpoint`. Managed provider descriptors live in `<home>/saas/providers/WORKSPACE_ID.json`; `<home>/saas-provider.json` contains the last selected default. Descriptors contain paths and credential references, never secrets. Independent per-workspace descriptors prevent concurrent selection from deleting another workspace's configuration. The hub stores provider IDs as `saas:WORKSPACE_ID` alongside reservations. An explicit `tunnels.json` takes precedence for new reservations.

## Custom endpoints

`--endpoint` accepts an HTTPS origin only: no userinfo, path, query or fragment. An explicit port is allowed for local testing, for example `https://localhost:8443`; `:443` is normalised away. The same strict rules apply as for the default service: every API call, verification link, billing link, manifest and artifact must stay on that exact origin, and redirects are refused.

The endpoint becomes part of the provider identity. The default service keeps `saas:WORKSPACE_ID` and the `<home>/saas` layout above. Another endpoint uses `saas:WORKSPACE_ID@HOST[:PORT]`, with its descriptors in `<home>/saas/endpoints/HOST[_PORT]/providers/WORKSPACE_ID.json`, adapter state in `.../state/WORKSPACE_ID` and its manifest cache in `.../manifest.json`. Artifacts remain shared under `<home>/saas/HASH/` because they are content-addressed. When the hub resolves a managed provider ID, it refuses a descriptor whose `endpoint`, `tenant_id` or `credential_account` disagrees with that ID, so the adapter always talks to the endpoint the CLI enrolled with.

A saved workspace applies only to the endpoint it was chosen on. Switching endpoints asks for a workspace again unless `--workspace` is given, and an endpoint without a Keychain credential requires browser approval.

The provider manifest's `ca` artifact is fetched over the endpoint's own TLS connection and only configures the adapter, so it cannot establish trust for the CLI. An endpoint behind a private CA needs `--ca-file PATH` with PEM certificates. The CLI copies them to `<home>/saas/endpoints/HOST[_PORT]/ca.pem` (mode 0600) after a successful login and uses them, instead of the system roots, for every request to that endpoint. Verification is never disabled. `--ca-file` is refused for the default endpoint. Replace the roots by passing `--ca-file` again; remove the file to return to the system roots.

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

Publish raw Apple Silicon executables, not archives. The provider must be standalone and understand protocol v2, scoped Keychain accounts and the transport configuration above. `ca` supplies the trust roots required by the adapter's control and relay connections; it does not affect the CLI's own requests (see [Custom endpoints](#custom-endpoints)). Publish a complete compatible set, with immutable versioned URLs, before publishing the manifest.

Downloads must remain on the same origin; redirects and URL credentials are refused. The CLI verifies SHA-256 before atomic installation. Executables use mode 0700 and the CA file uses 0600. Each artifact is capped at 128 MiB with a two-minute deadline. Installation publishes the cached manifest only after every artifact is verified. No download or install operation invokes a shell, extracts an archive or asks for administrator privileges.

The cache pins a working set across commands. Each command checks its hashes and repairs missing or corrupted files. A failed or cancelled install does not publish a managed provider. To fetch a newer manifest, remove `<home>/saas/manifest.json` (or the custom endpoint's `manifest.json`) before the next command. Old artifact directories remain available for active sessions and rollback; automatic updates and cache garbage collection are outside this change.

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
