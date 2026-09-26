# GitHub-aware project dashboard

The portal home page shows each workspace's GitHub binding on the context card: the
GitHub mark + `owner/name`, linking to the repository. Unbound workspaces show a subtle
**Connect repo** affordance instead, which opens a modal listing every repository the
Orcha GitHub App is installed on (name, private badge, description). Selecting one binds
it (`containers.github_repo`, migration 035); an **Unbind** option clears it. The binding
rides the container snapshot the home page already polls, so the card updates in place.

## API

- `GET /api/github/repos` → `{"available": true, "repos": [{full_name, private,
  description, html_url}]}` — the GitHub App's repositories
  (`GET https://api.github.com/installation/repositories`, first 100 per
  installation). With the multi-org token map (below) this spans **all**
  installations: merged, deduped, sorted by `full_name`; `available` is true if
  any installation answered and per-owner failures ride a `detail` string.
- `GET /api/containers/{cid}/github` → `{"repo": "owner/name" | null}`.
- `PUT /api/containers/{cid}/github` body `{"repo": "owner/name" | null}` — validates
  the owner/name shape (422 otherwise), persists, returns the binding.
- `github_repo` is also included in `GET /api/containers` and the
  `GET /api/containers/{cid}` snapshot's `container`.

## The token-file dependency

The portal never holds GitHub App credentials. A **host-side** refresh timer
(`deploy/github-token-refresh.*`, the sandbox-mode companion — see `deploy/README.md`)
mints a short-lived **installation token** from the App's PEM and writes it to
`<project>/.orcha/github-token`. The PEM stays on the host, always; only the 1-hour
token ever reaches a container.

**Multi-org**: the App can be installed on several orgs/users (e.g. `quantal-health`
and `Quantal-Labs-AI`). The refresh timer discovers every installation and writes a
second, portal-facing file `<project>/.orcha/github-tokens.json` — a JSON map
`{"<owner-lowercase>": "<token>", ...}` with one installation token per owner —
which `ORCHA_GITHUB_TOKENS_FILE` points the portal at. When that map is present and
non-empty the repos endpoint queries each token and merges the results; when it is
absent/unreadable/empty the legacy single-token file below is used unchanged. The
legacy `<project>/.orcha/github-token` is what agents keep using for git credentials:
for a repo-bound container it is minted from the **owner-matched** installation and
scoped to the bound repo; unbound workspaces get the first installation's token as
before.

The compose template mounts the stack dir read-only (`./:/app/stack-dir:ro`) and points
`ORCHA_GITHUB_TOKEN_FILE` at `/app/stack-dir/github-token` (and
`ORCHA_GITHUB_TOKENS_FILE` at `/app/stack-dir/github-tokens.json`). It deliberately does NOT
bind-mount the token file itself: a missing file would make Docker create a root-owned
*directory* at the source (breaking `docker compose up` and every later refresh), and a
single-file mount pins the inode so the timer's atomic write-then-rename refresh would
never be visible inside the container.

## Self-hosting without the App (the off state)

No token file (or an empty/unreadable one) is a **normal** state, not an error:
`GET /api/github/repos` answers `200 {"available": false, "repos": []}` and the modal
shows a short explanation of how to wire the App. Everything else in the portal works
unchanged; the dashboard simply stays off. A GitHub-side failure returns the same shape
plus a `detail` string.
