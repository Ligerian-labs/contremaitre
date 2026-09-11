# Launch notes

The first audience is developers running several Git worktrees or coding-agent workspaces on an Apple silicon Mac. Lead with a concrete demonstration of database isolation. Broader container tooling can wait until the first users can install and run the example reliably.

## Acceptance criteria for the GitHub page

- Explain branch-local apps, data copies, and HTTPS URLs before installation details.
- Provide a source installation sequence with prerequisites, cloning, PATH setup, and HTTPS forwarding.
- Include a reproducible PostgreSQL fork example with an observable result.
- Preserve the full reference and link to agent verification, source sync, and runtime limitations.
- Add contribution instructions, issue forms, and a reusable 1280 × 640 preview image.
- Use a factual repository description and relevant topics.
- Keep launch copy as drafts until the maintainer publishes it. Do not promise a star count.

This change affects documentation and GitHub presentation. Verification consists of checking links and examples, inspecting the rendered image and README, and running the repository's required checks. A new application regression test would not verify these editorial changes.

## Repository presentation

Description:

> Every branch gets its own local stack. Isolated apps, PostgreSQL data forks, and HTTPS URLs for Git worktrees, Jujutsu, and coding agents on Apple silicon.

Topics:

`local-development`, `development-environment`, `developer-tools`, `apple-container`, `apple-silicon`, `macos`, `git-worktree`, `jujutsu`, `postgresql`, `containers`, `cli`, `coding-agents`, `typescript`, `bun`

Use [contremaitre.png](assets/contremaitre.png) as the repository social preview. The editable source is [contremaitre.svg](assets/contremaitre.svg). GitHub recommends 1280 × 640 pixels and an image smaller than 1 MB. Set it under Settings → General → Social preview. Adding a README image does not also set this metadata. [GitHub's instructions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).

## First week

| When | Action | Evidence to collect |
| --- | --- | --- |
| Before announcing | Merge the page changes, confirm GitHub displays Apache-2.0, set the social preview, and have someone follow the quickstart on another supported Mac | The failing step, if any; time to the first working URL |
| Day 1 | Publish the demo and the longer post below on the maintainer's LinkedIn account | Relevant replies, repository visitors, new stars |
| Day 2 | Publish the short post with the same demo on the maintainer's preferred developer social account | Questions about isolation and installation |
| Days 3–4 | Fix the most common setup problem and document a real user's stack with their permission | A repeatable example and successful install |
| Days 5–7 | Consider a personally written Show HN submission if unfamiliar users can run the example | Technical feedback and reported adoption |

Use the account where the maintainer already has relevant contacts. This schedule is a suggested sequence, not a claim about optimal posting times. Avoid posting identical announcements repeatedly. Publish a follow-up when there is a new example or a resolved problem worth sharing.

For Show HN, the maker should submit a runnable project and be available to discuss it. HN's guidelines prohibit generated or AI-edited text, so write that submission and its comments yourself; the drafts below are for other channels. [Show HN guidelines](https://news.ycombinator.com/showhn.html), [HN guidelines](https://news.ycombinator.com/newsguidelines.html).

## Demo recording brief

Record the actual [README data-fork example](../README.md#try-a-data-fork). Use a disposable example project and show:

1. Main running, with `hello from main` in PostgreSQL.
2. A feature environment deploying and returning the copied row.
3. An update in the feature database, followed by the unchanged row in main.
4. Both web URLs open, with the branch labels visible in the terminal.

Keep the explanation around 45–60 seconds. Cut waiting periods and label those cuts. Include subtitles so the result is understandable without sound. Avoid presenting an edited clip as a deployment benchmark. The README banner illustrates the model; it is not a runtime screenshot.

## LinkedIn draft

Git worktrees separate your code. Your database and uploaded files often stay shared.

Contremaitre gives each branch its own local application stack on an Apple silicon Mac. The first deployment copies PostgreSQL data and declared upload volumes from a designated main environment. Each copy gets its own HTTPS URL.

The demo shows the part that matters: change a row in the feature environment, then query main. Main still has its original data.

For parallel coding-agent work, Contremaitre also installs integrations for Claude Code, Codex, OpenCode, and Pi. Agents can run configured checks and return a local review page with logs, artifacts, and source freshness.

It is early, Mac-only, and built on Apple's container runtime. Copying data pauses main's app services while the copy runs.

The repo includes the commands to try it:
https://github.com/Ligerian-labs/contremaitre

If you try it, which part of your stack is hardest to isolate between branches?

## Short post draft

Git worktrees isolate code. Contremaitre gives each branch its own app stack, PostgreSQL copy, uploads, and local HTTPS URL.

Built on Apple container for Apple silicon Macs.

Try the data-fork example:
https://github.com/Ligerian-labs/contremaitre

## Measure what happens

Record a baseline before each announcement and compare after 24 hours and seven days:

```sh
gh repo view Ligerian-labs/contremaitre --json stargazerCount,forkCount
gh api repos/Ligerian-labs/contremaitre/traffic/views
gh api repos/Ligerian-labs/contremaitre/traffic/clones
gh api repos/Ligerian-labs/contremaitre/traffic/popular/referrers
```

Traffic endpoints require repository access. Save their results outside the public repository. Unique clones can include automation and are not a count of active users. A star-to-visitor ratio is only a rough aggregate indicator because GitHub does not attribute each star to a channel. Track successful installs and substantive bug reports alongside stars.

If visitors arrive but cannot finish setup, fix installation before announcing again. If installation succeeds but the use case is unclear, publish a real workflow example. A downloadable, versioned ARM64 release is a useful follow-up to remove the Bun build prerequisite; it needs its own packaging and release work.
