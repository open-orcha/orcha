# Changelog

User-visible changes to the `orcha` CLI. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
semver (0.x until the agent-suggestion path lands — Orcha#17). **Every PR that
ships a user-visible change adds a bullet under [Unreleased]**; cutting a
release renames that section to the version + date. The release workflow
publishes the tagged section as the GitHub Release notes and fails if it's
missing.

## [Unreleased]

### Fixed
- PR #223 review + audit pass (cloud unification):
  - Container reset (`POST /api/containers/{cid}/reset`) now wipes the
    unification tables too (device tokens, Code Space threads/messages, wake
    backoff, push outbox, roster analysis) in FK-safe order — it previously
    failed with a ForeignKeyViolation once a device token or code thread existed.
  - Access model gaps closed: `GET /api/github/repos?cid=` is a member read of
    that project (it unlocked the project's saved PAT for any signed-in user);
    Code Space thread/message writes bind the proxy identity (viewers refused,
    claimed actors overridden); worktree file PUT / commit / push and GitHub
    propose refuse the viewer role; the wake-backoff listing is project-isolated.
  - Re-inviting a removed member reactivates their retired row instead of a
    permanent 409 lockout.
  - Auto-wake "Off" from the phones (which omit null keys) is now a disable,
    not a 422.
  - Worktree file read/write refuse a symlinked path that resolves outside the
    repo. Migration 045 is re-run tolerant (`IF NOT EXISTS`).
  - iOS: GitHub labels decode the `{name, color}` shape (real repo colors, legacy
    strings still accepted); Connect-repository passes the selected project so a
    saved PAT lists repos; the first message to an agent no longer fails to
    decode. Android: bearer tokens are keyed by origin (scheme+host+port), and
    the close-task blast radius decodes the server's real shape. Both phones now
    fill PR-row CI chips through the batch `…/github/checks` call.
  - Restored `.github/dependabot.yml`; added a shipping-path test for the React
    notification center.

### Added
- Downgrade guard on `orcha upgrade` (CLI and desktop app): the migration-chain
  tip is compared between the installed templates and the project's
  `.orcha/migrations` copy — an older CLI/app now refuses with "update the CLI
  first" instead of silently re-copying older templates over a newer portal
  (vanilla shell at `/`, 404 feature routes). `--allow-downgrade` overrides for
  deliberate rollbacks.
- PR human-attribution CLI capture: `orcha init --as` / `orcha connect --as`
  accept optional `--github <handle>` and `--git-email <email>`, stored on the
  human's agents row (mig 036/042) so agent-opened PRs credit the triggering
  human (`> 🧑 Triggered by @<handle>` blockquote + `Co-authored-by:` trailer;
  docs/agent-prs.md). Back-compatible: omitted → NULL → alias-only attribution.

### Changed
- Portal frontend rewritten in React 18 + TypeScript + Vite (all six pages,
  live terminal included) at full parity with the vanilla portal — same clean
  URLs, same `/api` contract, same Docker image shape. The vanilla HTML/JS
  files are removed; the built bundle ships in `static/dist/`. Includes a
  GitHub-style files-changed diff viewer on task runs and a
  downstream-extension seam (`frontend/src/extensions.ts`) for
  distribution-specific pages, nav entries, and settings sections.

### Fixed
- GitHub hub "Fix" dispatch no longer counts Orcha's own status comment as PR
  review feedback. Every dispatch posts a "🤖 Orcha started task ..." comment
  back on the PR, and GitHub counts it in the PR's conversation-comment total —
  so a second Fix click on the same PR handed the dispatched agent
  "1 review comment to address" that was really Orcha's own note. The Fix
  dispatch now nets Orcha-authored comments out of that count before composing
  the task's definition of done. The status comment itself is unchanged (it is
  useful to humans watching the PR), and inline code-review comments were never
  affected.
- Sandbox session continuity + path-identical mounts: each sandboxed wake's
  `~/.claude` (session transcripts, hook state) now persists on the host at
  `<workspace-root>/.orcha/agent-home`, so a resident conversation's pinned
  session can `--resume` across container restarts instead of always dying
  with "No conversation found with session ID" and surfacing an empty chat
  turn. Sandbox mounts are now **path-identical** (the workspace root is
  mounted at its real host path, `-w` is the actual spawn dir, and the
  container gets `ORCHA_WORKSPACE_ROOT`), which un-breaks git inside
  resident/task worktree wakes (their `.git` pointer files reference
  host-absolute paths) and lets the `gh` wrapper and git credential helper
  find the rotating `.orcha/github-token` from any spawn dir. The notifier is
  also resilient when a resume still fails: the empty result is never posted
  as a blank chat bubble — the pinned session is dropped and the resident
  reboots fresh once, re-servicing the same turn (a fresh boot that also
  produces nothing stamps a visible error turn instead). Requires a runner
  image rebuild (`orcha sandbox build-image`) for the updated `gh` wrapper.

### Added
- Agent→PR: sandboxed agents can branch, commit, push, and open GitHub PRs as
  the `orcha-cloud-app[bot]` App installation — never a human account. The
  runner image now ships the `gh` CLI plus a `/usr/local/bin/gh` wrapper that
  re-reads the workspace's rotating 1-hour installation token on every
  invocation (long resident sessions never hold a stale token); the box
  provisioner stamps the bot commit identity (workspace-local
  `user.name`/`user.email`) on cloned repos; and repo-credentialed workspaces
  get a standing "Working with the repository" persona block (branch
  `orcha/<task-slug>` → push → `gh pr create`; merge is always human). See
  `docs/agent-prs.md`.
- Metrics page (`/metrics`, in the portal nav): usage and estimated spend per
  agent — stat cards (est. cost with an honest "estimated, N of M runs reported
  cost" caption, runs, humanized sandbox compute, tasks completed/verified), a
  per-agent cost table with a pure-CSS proportion bar, and a daily activity
  sparkline over a 7/30-day window. Backed by one aggregate endpoint,
  `GET /api/containers/{cid}/metrics?days=`, which prefers daemon-recorded run
  usage and falls back to parsing each run's captured stream-json tail
  (`docs/metrics.md`).
- Per-device bearer tokens for Orcha Cloud: the iOS app pairs via GitHub OAuth in a
  browser sheet (`/auth/device` mints a token tied to the signed-in member and hands
  it over through the `orcha://` URL scheme), and the perimeter's new wildcard bearer
  lane validates tokens against the portal (`GET /api/auth/check`) and forwards the
  member's verified GitHub identity upstream — phone requests are attributed to the
  human who paired the device. Tokens are stored hash-only, listable, and revocable
  (owner: anyone's; member: their own); the exact-match team token stays first in the
  Caddyfile as the break-glass lane (`docs/device-tokens.md`).
- Sandbox wake mode (opt-in via `orcha sandbox on`): agent wakes run inside
  isolated, resource-capped Docker containers instead of directly on the host,
  and survive daemon restarts instead of being orphaned by them. Per-run
  metering rides the existing `worker_runs` table. New `orcha sandbox`
  CLI (`on` / `off` / `status` / `build-image`); see `docs/sandbox-mode.md`.
- GitHub-aware project dashboard: the portal home page shows the workspace's bound
  GitHub repo (or a Connect-repo modal listing the GitHub App installation's repos)
  and persists the binding; self-hosters without the App see a graceful off state
  (`docs/github-dashboard.md`).
- Collab v1: the portal's acting human is now a verified GitHub identity behind the
  cloud OAuth proxy (opt-in `ORCHA_TRUST_PROXY_USER=1`; the first arrival claims the
  founding "root" human), owners invite/manage project members from Settings →
  Members (roles, pending invites, retire-style removal), and owners can name a
  task's reviewer — surfaced on the task detail and de-emphasized for everyone else
  in the home queue. Self-hosters without a proxy see no behavior change
  (`docs/collab.md`).

## [0.5.0] - 2026-07-20

### Added
- Per-agent reasoning effort: pick an effort level (low → xhigh) alongside an
  agent's model, and its workers launch with it (Orcha#51).
- Autonomy and the Event-notifier are now separate, independently toggled
  controls in the web portal and the Android and iOS apps (Orcha#148).
- Agents can schedule a task-scoped self-wake that restores their saved context
  when it fires (Orcha#122).
- Task links in requests, conversations, and thread messages are clickable in
  the iOS and Android apps; the desktop app reuses the existing portal window
  for same-origin task links (Orcha#140).
- Work-shaped info requests are auto-promoted into task requests, so real work
  gets tracked instead of being answered away (Orcha#71).
- Portal: an opt-in "Swiss" design skin (selectable from Settings) and a
  collapsible sidebar.

### Fixed
- Worker continuity (Orcha#110): a task worker's worktree and uncommitted work
  now survive across wakes instead of restarting from origin/main.
- One wake drains all handleable notifications instead of just the first
  (Orcha#58), and a drain turn can no longer swallow the answer event that
  unblocks the agent's own task (Orcha#72).
- Task attribution: a worker session that spans multiple tasks now narrates on
  every task it touched (Orcha#144, Orcha#83), and agents' "Now" labels are
  accurate again (Orcha#125, Orcha#126).
- A claimed-but-nonexistent "task created/started" report now hard-fails loudly
  at session end instead of being narrated as success (Orcha#152).
- Orphaned notifier daemons self-terminate when their container is gone
  (Orcha#36), and switching a live agent's model recycles the warm session so
  the next reply actually uses the new model (Orcha#88).
- Portal: resolved 22 CodeQL alerts (path containment, no error-body leaks).

### Docs
- `orcha-listen` is documented as the default event-loop primitive for agents
  (Orcha#160).

## [0.4.0] - 2026-07-04

### Added
- Native mobile companion apps for iOS and Android (Orcha#30): pair your phone by
  scanning a QR code, then read your tasks and requests, watch a live run-log
  feed, create tasks, and nudge or close any request from your phone.
- Portal: a mobile-pairing QR modal, so connecting a phone is a single scan.
- Separate conversation and work lanes (Orcha#90, Orcha#91): chatting with an
  agent and assigning it work are now distinct, and a conversation can hand off a
  task directly.
- Claude Sonnet 5 is now offered in the model picker.
- Agents recognize review verdicts when they wake, so review hand-offs move
  forward without a human re-explaining the outcome.

### Fixed
- Notifier no longer folds active-task wakes into the resident drain, so a busy
  agent's task wakes aren't dropped.
- Portal: task threads no longer get stuck on "Loading thread…" — a repaint
  guard misfired on pre-filled protocol fields (Orcha#74).
- Android: creating a task no longer double-fires on a fast double-tap
  (Orcha#124).

## [0.3.0] - 2026-06-30

### Added
- xAI / Grok support: Grok is now a selectable LLM provider, and you can store a
  per-provider xAI / Grok API key from the Settings page. All provider keys
  (including Anthropic) now live in one place.
- Set a task's collaboration protocol at creation time, so agents bind to the
  right conventions from their first turn.
- Standalone, state-routed request nudge — wakes whoever owns the next action on
  a request — and humans can now close any open or answered request.

### Fixed
- Worker watchdog: a runtime-aware liveness probe no longer hard-kills healthy
  Codex workers, and a stalled-but-still-alive worker is checkpoint-respawned
  instead of being abandoned at the hard cap.
- Agent wake-up: claiming a task now surfaces the full task body (description +
  definition of done), not just the title, and a turn-budget gate that could
  429 an agent off its own ready task has been removed.
- Portal: a retry button appears when a task thread fails to load, plus topbar
  layout, search field, and autonomy-pill alignment fixes.

### Docs
- README: added Anthropic API-key setup steps to the install guide and a note
  that buying API credit reduces token usage.

## [0.2.0] - 2026-06-11

### Added
- `orcha --version`.
- Private Homebrew distribution: `brew tap open-orcha/orcha
  git@github.com:open-orcha/homebrew-orcha.git && brew install
  open-orcha/orcha/orcha`. Python arrives as a hidden brew dependency.
- `orcha update` self-upgrades a Homebrew-managed CLI (`brew upgrade`) before
  updating the project — one command for CLI + templates + portal + DB.
  Versioned installs (`orcha@X.Y.Z`) are treated as pins and never moved.
- Tag-driven release workflow: build + smoke test + GitHub Release + tap
  formula bump, including a frozen `orcha@X.Y.Z` formula per release for
  downgrades.

### Changed
- First versioned release. Everything before 0.2.0 was installed from a
  source clone (`uv tool install --from ... orcha-cli`).
