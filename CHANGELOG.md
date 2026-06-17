# Changelog

User-visible changes to the `orcha` CLI. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
semver (0.x until the agent-suggestion path lands — Orcha#17). **Every PR that
ships a user-visible change adds a bullet under [Unreleased]**; cutting a
release renames that section to the version + date. The release workflow
publishes the tagged section as the GitHub Release notes and fails if it's
missing.

## [Unreleased]

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
