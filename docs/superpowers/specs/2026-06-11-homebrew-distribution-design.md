# Orcha distribution via Homebrew — design

**Date:** 2026-06-11
**Status:** approved (design); implementation pending
**Tracking:** [Orcha#17 — Publish orcha-cli to PyPI for one-line install](https://github.com/Quantal-Labs-AI/Orcha/issues/17)
**Branch:** `feat/homebrew-distribution`

## Goal

A non-technical user installs, upgrades, and downgrades the `orcha` CLI without
knowing Python exists. One line to install, one command to upgrade, a documented
path to downgrade. Docker Desktop remains the only prerequisite we cannot remove.

## Constraints (from discussion)

- **No pipx.** Users must not need Python tooling literacy of any kind.
- Homebrew is the primary user-facing channel (approach A, chosen over a
  standalone PyInstaller/PyApp binary, which stays available as a follow-up).
- **Distribution is private for now.** PyPI has no private hosting, so the
  PyPI publish from issue #17 is **deferred to the going-public flip** (§10).
  Until then the formula installs directly from the private GitHub repo.
- Issue #17's remaining release-engineering asks are folded in: semver
  discipline, tag-driven release workflow, README restructure, CHANGELOG.

## 1. Channels & naming

| Thing | Name |
|---|---|
| Tap repo (**private**) | `Quantal-Labs-AI/homebrew-orcha` |
| Tap setup (once) | `brew tap quantal-labs-ai/orcha git@github.com:Quantal-Labs-AI/homebrew-orcha.git` |
| User install | `brew install quantal-labs-ai/orcha/orcha` |
| Installed command | `orcha` (unchanged) |
| Artifact source | git tag of the private `Quantal-Labs-AI/Orcha` repo (no PyPI while private) |

The formula depends on `python@3.13`, clones the source repo at the release
tag (`url "git@github.com:Quantal-Labs-AI/Orcha.git", tag:, revision:`), and
pip-installs `orcha-cli/` (plus the single pinned `websockets` resource from
public PyPI) into an isolated keg virtualenv — Homebrew installs Python
invisibly; the user never sees it. The formula's `caveats` block states the
Docker Desktop requirement and points at the README's Docker section.

**Access model (the "private" part):** both repos stay private; a user's
existing GitHub org access *is* the auth. SSH URLs mean brew reuses the
machine's SSH key — no token plumbing, nothing to leak. Cost: installers must
be org members with a working SSH key (`gh auth` or a standard key setup);
documented in the tap README. Anyone outside the org simply can't fetch.

## 2. Versioning & release pipeline

- **Single source of truth:** `version` in `orcha-cli/pyproject.toml`.
  First published release: `0.2.0`. Semver `0.x` until the agent-suggestion
  path lands (then `1.0`), patch bump per user-visible PR (issue #17 policy).
- **New:** `orcha --version` flag reading `importlib.metadata.version("orcha-cli")`
  (the CLI currently has no version flag at all).
- **Release flow** (`.github/workflows/publish.yml`, triggered by tag `vX.Y.Z`):
  1. Guard: tag version must equal `pyproject.toml` version; fail otherwise.
  2. Build sdist + wheel with hatchling (artifact sanity, even unpublished).
  3. Smoke test: install the wheel into a clean venv, run `orcha --version`,
     assert output matches the tag.
  4. Create a GitHub Release (private repo ⇒ release stays private); body is
     the matching `CHANGELOG.md` section.
  5. **Tap bump:** with a fine-grained PAT (`TAP_GITHUB_TOKEN`, write access to
     the tap repo only), push to `homebrew-orcha`:
     - update `Formula/orcha.rb` (new `tag:` + pinned `revision:` commit SHA —
       the git-source equivalent of a tarball `sha256`);
     - write a frozen `Formula/orcha@X.Y.Z.rb` for the downgrade story.
- **Tap CI** (in `homebrew-orcha`, self-hosted Mac runner so it has SSH access
  to the private source repo): `brew audit`, `brew install --build-from-source`,
  run `orcha --version`. (`brew audit --strict` rejects non-public URLs, so
  plain `audit` while private.)

## 3. Install / upgrade / downgrade semantics

**Install** — `brew install quantal-labs-ai/orcha/orcha`. Done.

**Upgrade** — two layers, one command:
- CLI: `brew upgrade orcha`.
- Project: the existing `orcha update` already re-renders templates, rebuilds
  the portal, restarts daemons, and lets forward-only idempotent migrations
  apply on portal startup. Its phase 0 currently self-reinstalls **editable**
  installs and only *prints guidance* for packaged installs. **Change:** detect
  a Homebrew-managed install (the resolved `orcha` executable lives under
  `$(brew --prefix)/Cellar/orcha…`), run
  `brew upgrade quantal-labs-ai/orcha/orcha`, and re-exec `orcha update
  --no-self`, exactly mirroring the editable-install path. Net effect: **one
  command (`orcha update`) upgrades CLI + project templates + portal + DB.**
- If `brew upgrade` fails (offline, etc.): warn and continue with current code,
  same as the editable path's failure mode today.

**Downgrade** — every release leaves a frozen versioned formula in the tap:

```
brew uninstall orcha
brew install quantal-labs-ai/orcha/orcha@0.2.1
```

Versioned formulae declare `conflicts_with "orcha"` so the two can't coexist.
`brew pin orcha` is documented for holding a version. After a CLI downgrade,
`orcha upgrade` in a project re-renders that older CLI's templates.

**Schema caveat (documented, never automated):** DB migrations are forward-only
and additive. Downgrading the CLI keeps the newer schema — safe, because older
portal code ignores columns/tables it doesn't know. A true schema rollback is
`orcha down -v` + re-init (data wipe), documented with the same warning the
CLAUDE.md working agreements already carry.

## 4. CLI changes (this repo)

- `orcha --version` (argparse `--version` action + `importlib.metadata`).
- `cmd_update` phase 0: add brew-managed-install detection + self-upgrade +
  re-exec (see §3). Editable-install behavior unchanged.
- `pyproject.toml`: version `0.2.0`, license, classifiers, project URLs,
  readme metadata — prep for the eventual PyPI flip (§10), harmless while
  private.

No HTTP routes or DB shapes change ⇒ `docs/orcha.postman_collection.json` is
untouched and FT-DEPLOY-4 is unaffected.

## 5. Docs & repo changes

- **README:** lead with the brew tap + install one-liner; technical
  alternative while private is uv from git
  (`uv tool install --from "git+ssh://git@github.com/Quantal-Labs-AI/Orcha.git#subdirectory=orcha-cli" orcha-cli`);
  move the clone/editable/cache-clean dance into a new **`CONTRIBUTING.md`**
  (including the uv wheel-cache footgun note from issue #17).
- **`CHANGELOG.md`:** Keep-a-Changelog format; the release workflow extracts
  the tagged version's section for the GitHub Release body.
- **Tap repo:** `Formula/orcha.rb`, versioned formulae, tap README with
  install/upgrade/downgrade/pin instructions, tap CI workflow.

## 6. One-time manual prerequisites (human, not CI)

1. Create the `Quantal-Labs-AI/homebrew-orcha` repo (**private**).
2. Add the `TAP_GITHUB_TOKEN` secret (fine-grained PAT, contents:write on the
   tap repo only) to this repo.
3. Ensure the tap-CI self-hosted runner's SSH key can read both private repos.

(No PyPI setup while private — see §10.)

## 7. Testing

- **This repo's CI:** on PRs touching `orcha-cli/`: build sdist+wheel,
  `twine check`, wheel smoke test (`orcha --version` from a clean venv).
- **Unit tests:** brew-detection logic in `cmd_update` phase 0 (detect via
  executable path under a fake brew prefix; assert the right subprocess command
  is chosen for editable vs brew vs plain-pip installs).
- **Tap CI:** `brew audit --strict` + source install + run.
- **Release dry-run:** the publish workflow runs its build+smoke steps on
  `workflow_dispatch` without the publish step, so the pipeline is testable
  before the first real tag.

## 8. Error handling

- Tag/pyproject version mismatch → publish workflow fails before any upload.
- PyPI publish succeeds but tap push fails → workflow marks the run failed;
  re-running only the tap-bump job is safe (idempotent file writes).
- `orcha update` with brew install but `brew` missing from PATH (e.g. weird
  shell env) → warn + continue, same as today's packaged-install guidance.

## 9. Follow-ups (out of scope here, recorded for continuity)

- **Desktop app** (separate project, own spec): a shell that bundles the CLI,
  manages stacks, and embeds the existing web portal. **Electron-leaning** —
  the portal is already a web UI, electron-updater gives auto-update, and the
  shell is cross-platform — but macOS-native (SwiftUI menubar + WKWebView) was
  also discussed. Either way it consumes this release pipeline's artifacts and
  ships as a signed/notarized DMG + `brew install --cask`. Blocker for
  "all platforms": Orcha's backend (notifier, terminal bridge, compose layer)
  is only exercised on macOS today; Windows/Linux backend validation comes
  before any shell. Decision deferred; file a tracking issue.
- **Standalone binary channel** (PyApp/PyInstaller + `curl | sh`) if a
  no-Homebrew install path is ever needed.
- Real schema-migration/rollback tooling (issue #17's open question) — current
  story (forward-only + `down -v` reset) is acceptable for 0.x.

## 10. Going public later (the flip)

Designed so going public is additive, not a rework:

1. Make the tap repo public (tap command shortens to
   `brew tap quantal-labs-ai/orcha`; installs need no GitHub access).
2. Add the PyPI publish step to `publish.yml` (Trusted Publisher OIDC,
   `pypi` environment) — the build + smoke-test steps it needs already run on
   every release. Package name `orcha-cli` (free; `orcha` taken — verified
   2026-06-11; worth registering early to hold the name).
3. Switch `Formula/orcha.rb` from the git `tag:`/`revision:` source to the
   PyPI sdist `url` + `sha256`; tap CI tightens back to `brew audit --strict`.
4. README's secondary install path `uv tool install orcha-cli` becomes real.

Everything else (versioning, `orcha update` brew-awareness, downgrade
formulae, CHANGELOG, docs) carries over unchanged.
