# Contributing / hacking on Orcha

## Local install from a clone

End users install via the private Homebrew tap (see README). For working on
the CLI itself, install from your clone:

```bash
git clone git@github.com:Quantal-Labs-AI/Orcha.git ~/src/orcha
uv tool install --from ~/src/orcha/orcha-cli orcha-cli
```

Prefer an **editable** install if you're iterating on CLI code — it also lets
`orcha update` detect the checkout and self-reinstall before updating a
project:

```bash
uv tool install --editable ~/src/orcha/orcha-cli
```

### The uv wheel-cache footgun

uv caches the built wheel **by version number** — editing source without
bumping the version means `--force`/`--reinstall` alone can hand you the stale
wheel. Always do the full dance after template/CLI edits:

```bash
uv cache clean orcha-cli
uv tool install --reinstall --from ~/src/orcha/orcha-cli orcha-cli
```

Then re-render in a scratch project:

```bash
cd /tmp/orcha-demo && orcha down -v 2>/dev/null; rm -rf .orcha .claude && orcha init
```

(End users never hit this: brew installs a fresh keg per version.)

(The self-reinstall bonus above applies to **editable** installs only — the
plain `--from` install is a packaged wheel as far as `orcha update` is
concerned.)

## Tests

```bash
make test-install   # once: test deps (pip)
pytest -q           # needs Postgres at ORCHA_TEST_ADMIN_URL (default localhost:5432, user/pass orcha)
```

The CLI/distribution tests run without a DB:

```bash
pytest tests/test_cli_update.py tests/test_cli_version.py tests/test_homebrew_formula.py -q
```

## Cutting a release

1. In the release PR: bump `version` in `orcha-cli/pyproject.toml` and rename
   the `[Unreleased]` section of `CHANGELOG.md` to `[X.Y.Z] - <date>`.
   Semver 0.x discipline: patch bump per user-visible change (Orcha#17).
2. Merge, then tag the merge commit and push the tag:

   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

3. `.github/workflows/publish.yml` does the rest: version guard, build, wheel
   smoke test, GitHub Release (notes = the CHANGELOG section), and pushes the
   regenerated formulae (tracking `orcha.rb` + frozen `orcha@X.Y.Z.rb`) to the
   private tap.
4. Dry-run any time via the workflow's "Run workflow" button
   (`workflow_dispatch` = build + smoke only).

Runner prerequisites (self-hosted Mac pool): `gh` CLI installed and the
`TAP_GITHUB_TOKEN` repo secret set — the workflow's preflight step fails fast
if either is missing.

First-time setup (once per org, already done if the tap exists): run
`packaging/homebrew/bootstrap_tap.sh`, then add a fine-grained PAT with
contents:write on `homebrew-orcha` as the `TAP_GITHUB_TOKEN` secret in this
repo. Going public later (PyPI + public tap) is spec'd in
`docs/superpowers/specs/2026-06-11-homebrew-distribution-design.md` §10.
