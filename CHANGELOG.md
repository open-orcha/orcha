# Changelog

User-visible changes to the `orcha` CLI. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
semver (0.x until the agent-suggestion path lands — Orcha#17). **Every PR that
ships a user-visible change adds a bullet under [Unreleased]**; cutting a
release renames that section to the version + date. The release workflow
publishes the tagged section as the GitHub Release notes and fails if it's
missing.

## [Unreleased]

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
