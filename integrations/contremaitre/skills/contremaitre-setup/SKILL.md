---
name: contremaitre-setup
description: Configure an application's Contremaitre manifest, development containers, databases and verification profiles. Use when onboarding a repository or changing its local stack, including projects without a manifest.
---

Work from the application workspace. Inspect its package scripts, Dockerfiles, active Compose files, env variable names and existing `.contremaitre.yaml` or `.contremaitre.yml`. Preserve the project's commands and package manager. Contremaitre executes the current checkout; it does not create Git worktrees or Jujutsu workspaces.

Check `contremaitre version` and the runtime prerequisites. The native runtime needs Apple silicon, macOS 26, Apple container, Traefik, mkcert and local HTTPS forwarding. If the CLI is missing, follow the project's [installation guide](https://github.com/Ligerian-labs/contremaitre#get-started). Report missing prerequisites before promising a running preview. Installing the HTTPS service or trusting a certificate authority changes machine configuration; use the user's existing authorization and let the native administrator prompt handle privileges. Run the hub as the normal user.

Read [manifest configuration](references/manifest.md) before creating or changing the manifest. Write it directly when you already have the project context. `contremaitre init --no-ai` can bootstrap conventional Dockerfiles when no manifest exists; review its output. Do not launch interactive assisted init from another agent. Compose import supports a limited subset and does not run Compose.

Use existing application scripts for verification profiles. Match each check to a real assertion; a listening port is only readiness. Configure browser checks to consume Contremaitre URLs and write their artifacts to the supplied directory.

When deployment is in scope, run `contremaitre ensure --json`, then `contremaitre verify --profile smoke --json` and `contremaitre report --json`. Use the user's chosen profile when different. Diagnose a failed operation with `contremaitre diagnose --run ID --json`. Report missing or failed checks and the returned preview/review URLs. A manifest-only request ends with the reviewed configuration and explicitly unrun checks.

Use `--main` only when this workspace is the intended initial data source. A new environment may pause main's application writers while copying its managed PostgreSQL data and file volumes. Redis starts empty. Keep the same `project` name across workspaces of the same app; use a different name for a different app.
