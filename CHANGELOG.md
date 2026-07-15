# Changelog

User-visible changes to the `orcha` CLI. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
semver (0.x until the agent-suggestion path lands — Orcha#17). **Every PR that
ships a user-visible change adds a bullet under [Unreleased]**; cutting a
release renames that section to the version + date. The release workflow
publishes the tagged section as the GitHub Release notes and fails if it's
missing.

## [Unreleased]

### Added
- The wake notifier now starts itself — no more hand-running `orcha notifier
  --ensure` after a reboot or after restarting a stopped stack. On macOS a
  per-project launchd LaunchAgent brings it up at login and restarts it within a
  minute if it dies (removed again by `orcha notifier --stop` / `orcha down`;
  opt out with `ORCHA_NO_AUTOSTART=1`), and `orcha up --project <name>` now
  ensures the notifier and terminal bridge in the project's checkout just like
  plain `orcha up` (with `orcha down --project` stopping them symmetrically).
  Linux keeps the runtime ensure paths; `docs/notifier-autostart.md` carries a
  sample systemd user unit for reboot parity.

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
