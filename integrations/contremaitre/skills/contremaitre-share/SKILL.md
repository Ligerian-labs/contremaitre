---
name: contremaitre-share
description: Start, inspect or stop a public Contremaitre preview. Use when the user asks to share a running app outside this Mac, manage its tunnel session or release a reserved preview URL.
---

Public sharing exposes all HTTP services in the selected environment. Start it when the user requests public sharing; a request for a local preview only needs `contremaitre report --json`. Reuse the requested workspace and branch. Public application URLs and the loopback verification review URL have different reachability.

For a new preview, run `contremaitre ensure --json` and the relevant configured verification profile first. Report verification gaps without describing the app as verified. Run `contremaitre tunnel` in a foreground terminal session you can keep alive. The CLI uses the default SaaS provider unless a compatible provider is configured; it may open browser authentication and request a workspace selection. The user completes account or subscription steps. `contremaitre tunnel login` authenticates without starting sharing.

Keep the tunnel command alive while sharing. Return only URLs actually printed after startup succeeds. Do not detach it with shell backgrounding or claim a reserved URL is live. If the host cannot retain a foreground process, provide the exact command for the user's terminal and report that sharing has not started. A client exit, Ctrl-C or branch change ends the session and restores local URL configuration.

Sharing may restart services to change browser URLs and origins. Finish sharing before redeploying; live source edits can continue. Use `{{service.browser_url}}` for browser API endpoints and `{{service.browser_origins}}` for a JSON array of allowed origins in the manifest. These values require application runtime support; static compiled URLs cannot be rewritten. Native services support sharing; project drivers do not currently support URL reconfiguration.

Use `contremaitre tunnel status --json` to inspect reservations. A reservation alone is not evidence of an active connection. `contremaitre tunnel stop` ends sharing and retains reservations. `contremaitre tunnel release SERVICE` retires the named service's reservation and can end the active session. Use release only when retiring that URL is requested. Neither stopping a preview nor releasing a URL requires deleting environment data.
