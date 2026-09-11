---
name: contremaitre
description: Run, test, debug, and preview applications in isolated Contremaitre environments. Use for runtime verification and handing off runnable changes in projects with .contremaitre.yaml.
---

Use the installed `contremaitre` CLI from the application's workspace. Commands infer its environment, including Git worktrees and Jujutsu workspaces. Use `--json` for compact results.

1. Run `contremaitre ensure --json`. It reuses or deploys this workspace and waits for readiness. For manifest creation or changes, use the bundled `contremaitre-setup` skill. For check configuration, read [setup](references/setup.md). Do not launch interactive assisted init from another agent.
2. Run `contremaitre verify --profile smoke --json`, or the profile requested by the user. Missing checks mean unverified, never passed. Use the project's existing tests when defining a profile.
3. On failure, use `contremaitre diagnose --run ID --json`. Read more only if needed, using the returned offset and optional `--check NAME`. Fix the cause and repeat the relevant commands.
4. Before handing off runnable changes, run `contremaitre report --json`. Include the application and review links, checks passed/failed/skipped, and any stale or unverified state. Readiness alone does not prove functionality.

Commands wait silently. For long work, `ensure` and `verify` accept `--detach`; resume with `contremaitre wait OPERATION_ID --json`, then `report`. A client timeout leaves work running. Do not start a duplicate operation to poll progress. `cancel OPERATION_ID` explicitly cancels it.

Evidence stays outside the checkout. Inspect screenshots or traces when needed to verify visual behavior; a file's existence does not prove you inspected it. Full logs are linked on the review page. Avoid global `list`, `attach`, or full logs for routine checks.

For a read-only status request, use `contremaitre status --json` or `contremaitre report --json` without deploying. After source edits, run ensure and verify again. Preserve the environment for review. Local preview links work on the runtime's Mac. Use the bundled `contremaitre-share` skill for requested public sharing. Data deletion requires the user's request. Respect explanation-only and review-only scope.
