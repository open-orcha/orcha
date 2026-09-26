# Local run — the full Orcha Cloud portal on your laptop

Everything the box (`deploy/README.md`) gives you — premium portal, projects,
GitHub hub, repo browser, Code Space, members — running on `localhost`, no
VM, no domain, no GitHub App registration. This is the sibling guide: the box
is the auth-fronted multi-user deployment, this is the single-operator one.

## TL;DR

```bash
# 1. Install the CLI (from a checkout of this repo)
uv tool install --from <path-to-orcha-cloud-checkout>/orcha-cli orcha-cli

# 2. Bootstrap a project — this renders the stack, starts Postgres + the
#    portal in Docker, and creates your first container + human agent.
mkdir myproj && cd myproj
orcha init
orcha up          # idempotent; safe to re-run any time you come back

# 3. Open the portal (the port orcha init picked — usually 8000; it's
#    printed at the end of `orcha init` and saved in .claude/orcha.json)
open http://localhost:8000
```

Or run `sh deploy/local/up.sh` from your project directory instead of steps
1–2 by hand — it checks for Docker + `orcha` on PATH, runs `orcha init` only
if `.orcha/` isn't there yet, then `orcha up`, and prints the portal URL.

Don't have `uv`? `curl -LsSf https://astral.sh/uv/install.sh | sh`. Docker
Desktop, OrbStack, or Colima all work as the container runtime — one of them
needs to be installed and running before `orcha up`.

### Unlock GitHub features: paste a PAT

In the portal, go to **Settings → GitHub access** and paste a GitHub
[personal access token](https://github.com/settings/tokens) (classic, `repo`
scope, or a fine-grained token scoped to the repos you want Orcha to see).
Alternatively, set it before bringing the stack up so it's there from the
first request:

```bash
export ORCHA_GITHUB_PAT=ghp_...
orcha up
```

A PAT unlocks:

- the **GitHub hub** (issues/PRs list, detail pages, checks)
- the **repo browser** (Connect-repo, file tree, tarball snapshots)
- **Code Space** anchors (agents reading/writing against a bound repo)

What a PAT does **not** unlock: check runs posted *as the GitHub App* and
inbound webhooks — see "What stays hosted-only" below. Everything else works
identically to the box.

### Identity: no login by default

Out of the box the portal trusts nobody's GitHub identity — it doesn't need
to. `ORCHA_TRUST_PROXY_USER` is unset, so `/api/me` reports
`{identity: null, trusted: false}` and the frontend falls back to the local
human `orcha init` registered for you (the `--as <name>` you passed, or your
`$USER`). Members/permissions UI still works; you're just the project's one
operator, unauthenticated, because there's nothing to authenticate against on
your own laptop. This is the documented self-host path, not a degraded mode.

If you want a real GitHub sign-in on localhost — e.g. to test the members/
roles UI as more than one identity — see the next section.

## Optional: real login on localhost

This runs [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) in
front of the portal so the browser has to complete a GitHub OAuth sign-in,
and the verified username reaches the portal the same way it does on the box
(`X-Auth-Request-User` + `ORCHA_TRUST_PROXY_USER=1`). Useful for dogfooding
the real auth path or testing multi-user flows without a box.

**1. Create a GitHub OAuth app** — [github.com/settings/developers](https://github.com/settings/developers)
→ New OAuth App:

- Homepage URL: `http://localhost:4180`
- Authorization callback URL: `http://localhost:4180/oauth2/callback`

Note the Client ID, and generate a Client Secret.

**2. Rebind the portal to loopback + trust the proxy header.** The overlay
below only stands up oauth2-proxy; the portal itself still needs to (a) bind
its published port to `127.0.0.1` only (so the only public entrance is
oauth2-proxy) and (b) opt in to trusting the header. Reuse the box's overlay
pattern (`deploy/auth/docker-compose.portal-local.yml`) adjusted to your
project's port, or add the two lines directly to `.orcha/docker-compose.yml`
under the `portal` service:

```yaml
services:
  portal:
    ports: !override
      - "127.0.0.1:8000:8000"     # adjust 8000 if orcha init picked another port
```

and export the trust flag before `orcha up` (or add it to `.orcha/.env`,
which `orcha up` already reads):

```bash
echo "ORCHA_TRUST_PROXY_USER=1" >> .orcha/.env
orcha up
```

**3. Fill in the oauth2-proxy env file:**

```bash
cp deploy/local/oauth2-proxy.env.example deploy/local/oauth2-proxy.env
$EDITOR deploy/local/oauth2-proxy.env   # client id/secret, cookie secret, portal port
```

Generate the cookie secret:

```bash
python3 -c "import secrets;print(secrets.token_urlsafe(32))"
```

**4. Bring the overlay up:**

```bash
docker compose --env-file deploy/local/oauth2-proxy.env \
  -f deploy/local/docker-compose.oauth.yml up -d
```

**5. Verify.** Open `http://localhost:4180` → GitHub sign-in → portal, now
carrying your verified GitHub identity (check Settings → the identity should
no longer read as the local fallback operator). `http://localhost:8000`
(the raw portal port) should now refuse external connections — only
loopback — confirming step 2 took effect.

Set `ALLOWED_GITHUB_USERS` in `oauth2-proxy.env` (comma-separated GitHub
usernames) to restrict who can sign in; empty means any GitHub account.

To go back to no-login local admin: `docker compose -f
deploy/local/docker-compose.oauth.yml down`, undo the portal's loopback
rebind, and unset `ORCHA_TRUST_PROXY_USER`.

## What stays hosted-only

These are box/BYOC-only by design — they depend on systemd timers or a
publicly reachable box, neither of which a laptop behind NAT has:

- **Webhooks / push relay** — GitHub can't POST to your laptop. The portal
  features that would otherwise react instantly to a push instead poll,
  unchanged.
- **Members auto-sync timers** — the box's periodic sync of installation
  membership runs as a systemd timer alongside the App-token refresh; there's
  no equivalent local daemon. Manage members by hand in the portal instead.
- **Check-runs posted *as the app*** — a PAT posts checks as *you*, not as a
  bot identity; this is a GitHub App-only capability (`checks:write` on an
  App installation). Everything else a PAT can reach (issues, PRs, file
  contents, tarballs) works the same.

None of these block the core loop — agents, tasks, requests, the terminal,
provider keys, and (with a PAT) the GitHub hub all work fully locally.

## Troubleshooting

**Port already in use.** `orcha init` picks a free port starting at 8000 (and
similarly for Postgres from 5432, the terminal bridge from 8765) — a second
local project shifts up automatically, so this is usually only surprising if
something *other* than Orcha is squatting on 8000. Check
`.claude/orcha.json`'s `api_port` for what actually got picked, or force one:
`orcha init --api-port 8010`. If you need to reclaim a specific port, stop
whatever's on it first — `orcha init` won't fight for a busy port.

**Docker not running.** `orcha up` / `orcha init` shell out to `docker
compose`; if the daemon isn't up you'll see a connection error from Docker,
not an Orcha-specific message. Start Docker Desktop/OrbStack/Colima and
re-run — nothing on the Orcha side needs to change.

**PAT scope errors / a 404 on a private repo.** GitHub's API returns 404
(not 403) for a repo the token can't see — same response whether the repo
doesn't exist or you lack access, so a 404 in the repo browser or GitHub hub
almost always means the PAT's scope doesn't cover that repo. Fix: for a
classic PAT, make sure `repo` scope is checked; for a fine-grained PAT, make
sure the specific repo is selected under "Repository access". Re-test from
Settings → GitHub access → Test after fixing scope — it round-trips through
`GET /user` with the token before anything is saved, so a bad token is caught
immediately, not on first use.

**Re-running / starting fresh.** Always `orcha up` to relaunch — it's the
compose-level idempotent bring-up and never touches data. Do **not** use
`orcha init --force` (fine for re-rendering config, but only add
`--reset-data` if you deliberately want to wipe the Postgres volume) or
`orcha down -v` (drops the DB volume) unless you actually want a clean slate.
See the main `deploy/README.md`'s notes on `init --force` vs `--reset-data`
for the same rule as the box.
