# Agent → PR: sandboxed agents open pull requests as the app bot

Sandboxed Orcha agents can branch, commit, push, and open GitHub pull requests
— always as the **`orcha-cloud[bot]`** GitHub App installation, never as a
human's account. A PR is a *proposal*: merging is always a human decision, the
same authority gate as the Orcha task flow's `needs_verification` stop.

## The pieces

### Bot identity (who authors the commits)

`deploy/provision-projects.sh` sets **workspace-local** git config on every
repo it clones:

- `user.name` → `<slug>[bot]` (slug from `/opt/orcha-secrets/github-app.json`)
- `user.email` → `<BOT_USER_ID>+<slug>[bot]@users.noreply.github.com` — the
  numeric prefix is the bot's GitHub **user** id (resolved live from
  `GET /users/<slug>[bot]` at provision time), *not* the app id. GitHub only
  links a commit to the bot account (avatar, profile) via the user id; with
  the wrong number the commit still lands but shows as an unknown author.

**Field gotcha — app renames.** The json slug is a creation-time snapshot. If
the App is later renamed (ours was: `orcha-cloud-app` → `orcha-cloud`), the
snapshot goes stale and commits stop linking. The provisioner now resolves the
bot user id live, but the slug itself comes from the json — after a rename,
update `slug` in `/opt/orcha-secrets/github-app.json` to match the App's
current URL (`https://github.com/apps/<slug>`).

So commits and PRs are attributed to the App bot on GitHub, and no human
credential ever enters a container. Workspaces provisioned **before** this
landed don't get a migration pass — apply the config once by hand (exact
commands in `deploy/README.md`, "Bot commit identity").

### Token rotation (how the bot authenticates)

The App's private key (PEM) stays on the host. A systemd timer
(`deploy/github-token-refresh.sh`, every 40 min) mints a **1-hour installation
token** into each workspace at `<workspace-root>/.orcha/github-token`. The
sandbox mounts the workspace **path-identically** (same absolute path inside
the container) and stamps `ORCHA_WORKSPACE_ROOT=<root>` into the container
env, so the token file is at the same path everywhere — including from a git
worktree spawn, whose own `.orcha` is the repo's committed dir, not the
runtime one. Repo-bound workspaces get a token minted from the
**owner-matched installation, scoped to that repo**.

Two consumers read it, both at *use time* so rotation never strands them:

- **git** — the credential helper the provisioner installs:
  `password=$(cat "$d/.orcha/github-token")` where `d` is
  `$ORCHA_WORKSPACE_ROOT`, falling back to walking up from `$PWD` — evaluated
  per operation.
- **gh** — the runner image ships `/usr/local/bin/gh`, a tiny POSIX-sh wrapper
  that shadows the real `/usr/bin/gh` via PATH order and resolves
  `$ORCHA_WORKSPACE_ROOT/.orcha/github-token` (same `$PWD` walk-up fallback)
  into `GH_TOKEN` on **every invocation**. A resident session that lives for
  hours never holds a stale token, and the token never appears in argv or on
  screen.

The `gh` binary itself comes from GitHub's official apt repo
(`templates/runner/Dockerfile`); nothing is pinned beyond the repo.

### What agents do

Agents get a standing "Working with the repository" block in their wake
persona (`REPO_WORKFLOW_GUIDANCE` in `orcha_cli/notifier_persona.py`), gated
on the workspace actually carrying a git checkout **and** the token file:

1. never commit to the default branch;
2. branch per piece of work: `git checkout -b orcha/<task-slug>`;
3. commit (the bot identity is preconfigured), `git push -u origin <branch>`;
4. `gh pr create --title ... --body ...` — the body ends with a reference to
   the Orcha work log (task/thread) and a note that a human reviews it.

### Human attribution (who *triggered* the bot)

The bot stays the PR author (the App-token headless flow), but every
agent-opened PR names the human who triggered the work, two ways:

1. **PR body, first line** — a highlighted blockquote, then a blank line:

   > 🧑 Triggered by @\<github-handle\> via Orcha task \<task-id\>

   The @mention makes GitHub link and notify the person. Fallback when the
   human has no recorded handle: their display name, no @, task id kept —
   attribution is never dropped silently.

2. **`Co-authored-by: <name> <email>`** trailer on the final commit, so the
   human shows in the commit graph. Email preference order: their recorded
   `git_email` → `<github-login>@users.noreply.github.com` → no trailer (body
   line still carries attribution).

The plumbing: humans register their handle/email (`/orcha-register-human
--github <login> --email <addr>`, stored on `agents.github_login` /
`agents.git_email`, migration 042); `GET /api/agents/{aid}/protocol` resolves
the task's requesting human as `requested_by` (the task's stamped human
creator, else the container's earliest live owner); the wake's "Your task"
section renders it as a `Requested by:` line; `REPO_WORKFLOW_GUIDANCE` and
`/orcha-done` (step 4) carry the exact formats and the fix-up commands.

### What humans do

Review and merge. Nothing in this pipeline can self-approve: the bot has no
review authority over itself, agents are instructed that merge is always
human, and the Orcha-side work stops at `needs_verification` regardless.

### Agents can file GitHub issues too

The same bot token lets agents run `gh issue create` — "file your findings as
issues" works end to end — **but only when the App holds Issues: Read and
write**. Without it both create AND read 403 (an agent can't even check for
duplicates). The manifest grants it for new installs; apps created before
2026-08-01 need the manual flip.

**Field-hardened acceptance notes** (this permission was field-added; every
lesson below was hit live):

1. Flip the permission once at the App level: App settings → Permissions &
   events → Issues: **Read and write** → Save.
2. The new scope stays INERT per installation until an org admin accepts it —
   check every org: `GET /app/installations` (JWT) and look at
   `permissions.issues` per account. Partial acceptance is real: we shipped
   with 2 of 3 orgs accepted and the third silently 403ing.
3. The org-settings installations LIST page 404s for accounts that hold only
   the org's **App manager** role (not full owner). The DEEP LINK still works
   for them: `github.com/organizations/<org>/settings/installations/<id>` —
   get `<id>` from `GET /app/installations`.
4. Tokens snapshot permissions AT MINT: after acceptance, re-mint (run the
   `github-token-refresh` service) before retrying, or the agent keeps
   403ing on a stale token.

## Limits

- **Repo reach = the App installation's repository selection.** Agents can
  only touch repos the `orcha-cloud` App is installed on (install it per
  org/user; the refresh timer discovers all installations automatically —
  see "Multi-org" in `deploy/README.md`).
- Tokens live 1 hour and are scoped to the bound repo where a binding exists.
- The wrapper reads the token fresh but cannot conjure one: a workspace the
  timers don't know about has no `.orcha/github-token` and `gh` runs
  unauthenticated.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `<workspace-root>/.orcha/github-token` absent | The workspace isn't in `/opt/orcha-work/workspaces.list`, or the refresh timer isn't running: `systemctl status github-token-refresh.timer`, then check `journalctl -u github-token-refresh`. |
| `gh` says "not logged in" / 401 | Empty or stale token file → same timer checks as above. Also confirm the App is **installed on the target repo** (app page → Install App). |
| Push rejected (403) on a repo the agent can read | Token is repo-scoped to the *bound* repo; pushing elsewhere needs that repo in the App installation and (for scoping) a binding. |
| Commits attributed to a human | Workspace predates the provisioner change — apply the "Bot commit identity" one-liner from `deploy/README.md`. |
| `gh` works interactively but a long resident session 401s | You're not using the image wrapper (`which gh` should print `/usr/local/bin/gh`). Rebuild the runner image: `orcha sandbox build-image`. |
