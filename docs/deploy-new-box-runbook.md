# Orcha Cloud — fresh Hetzner box runbook

> Rebuild the entire hosted Orcha Cloud deployment (portal + workspaces + auth +
> daemons) on a new machine, from zero to `https://orcha.<domain>` serving. Written
> 2026-08-26, when the original dogfood deployment on the shared VPS was
> decommissioned — this doc + the offline secrets backup are everything needed to
> stand it back up. Sibling docs: `deploy/README.md` (the original box bootstrap,
> more narrative), `deploy/local/README.md` (laptop solo tier).

## 0. What you need in hand

- A Hetzner machine (Cloud VPS ≥ 4 GB for portal-only; **dedicated AX-class with
  /dev/kvm** if this box will also run the future Firecracker sandbox tier).
- DNS control: an `A` record `orcha.<domain>` → the box IP.
- **The secrets backup tarball** (`orcha-box-backup-<date>.tar.gz`, kept OFFLINE,
  never in git). Contents and where each piece goes:
  - `orcha-secrets/github-app.pem` + `github-app.json` → `/opt/orcha-secrets/`
    (GitHub App private key — IRREPLACEABLE; without it, re-create the App via
    `deploy/setup-github.py` and reinstall it on the org).
  - `dogfood-env` (the stack's `.orcha/.env`: `ORCHA_SECRET_KEY`, `ORCHA_PLAN=team`)
    → new stack's `.orcha/.env`. **ORCHA_SECRET_KEY is what unseals every stored
    provider key / PAT in the DB dump — losing it orphans those rows.**
  - `db.dump` (pg_dump of the portal database — all workspaces, tasks, threads,
    runs/spend history).
  - `Caddyfile.orcha` (the site block) and `oauth2-proxy` env/compose.
  - GitHub OAuth app client id/secret (in the oauth2-proxy env): callback is
    `https://orcha.<domain>/oauth2/callback` — update the OAuth app if the domain
    changes.

## 1. Base system

```bash
apt-get update && apt-get install -y git curl ufw
curl -fsSL https://get.docker.com | sh
ufw allow 22,80,443/tcp && ufw enable
curl -LsSf https://astral.sh/uv/install.sh | sh   # installs to ~/.local/bin
```

## 2. Code + CLI

```bash
mkdir -p /opt/orcha-secrets && chmod 700 /opt/orcha-secrets
# restore github-app.pem / github-app.json from the backup, chmod 600
scp deploy/github-app-token.py deploy/bootstrap-clone.sh <box>:/tmp/
sh /tmp/bootstrap-clone.sh        # App-token clone → /opt/orcha-cloud, installs orcha-cli
# (equivalent manual form: mint an installation token with github-app-token.py,
#  git clone https://x-access-token:<tok>@github.com/Quantal-Labs-AI/orcha-cloud
#  /opt/orcha-cloud, then: uv tool install --from /opt/orcha-cloud/orcha-cli orcha-cli)
```

Re-running `bootstrap-clone.sh` later = pull + reinstall (the upgrade path).

## 3. The workspace stack

```bash
mkdir -p /opt/orcha-work/dogfood && cd /opt/orcha-work/dogfood
orcha init                        # renders .orcha/, starts db+portal, note the api port
```

Then pin the plan + secret key **before real use** — `.orcha/.env`:

```
ORCHA_SECRET_KEY=<from backup>    # BEFORE any key is stored; portal 503s key-writes without it
ORCHA_PLAN=team                   # hosted box = paid tier; unset means SOLO → member mutations 402
```

`docker compose up -d` again after editing so the env lands. Migrations auto-apply
at portal startup (`[migrate] applied: [...]` in `docker logs`).

### Restoring the old database (optional but usual)

```bash
docker compose stop portal
cat db.dump | docker exec -i <stack>-db-1 pg_restore -U orcha -d orcha --clean --if-exists
docker compose up -d portal       # migrations reconcile anything newer than the dump
```

## 4. GitHub App token plumbing (repo browse / hub / checks)

The portal reads installation tokens from files the HOST refreshes:

```bash
scp deploy/github-token-refresh.{sh,service,timer} <box>:/etc/systemd/system/  # .sh → /usr/local/bin
systemctl daemon-reload && systemctl enable --now github-token-refresh.timer
# writes /opt/orcha-work/<ws>/.orcha/github-token + github-tokens.json (multi-org map)
```

Same pattern for the optional timers if used: `sync-members.*`,
`provision-projects.*`, `push-forwarder.*` (all under `deploy/`).

## 5. Auth perimeter (Caddy + oauth2-proxy)

- Portal must be loopback-bound: `deploy/auth/docker-compose.portal-local.yml`
  overlay (`127.0.0.1:<port>:8000`), then `docker compose ... up -d portal`.
- oauth2-proxy: `deploy/auth/docker-compose.auth.yml` + restored env (GitHub OAuth
  client id/secret, cookie secret). It stamps `X-Auth-Request-User`.
- Set `ORCHA_TRUST_PROXY_USER=1` in the stack `.orcha/.env` (ONLY behind the proxy).
- Caddy (host systemd service): restore the `orcha.<domain>` site block from the
  backup into `/etc/caddy/Caddyfile` → `systemctl reload caddy`. If the box hosts
  other sites, ONLY add the orcha block — never replace the whole file.
- DNS A record → box IP; Caddy fetches certs automatically.

## 6. Host daemons (what actually runs agents)

Per workspace, from the workspace dir, with a CLEAN env (an inherited
`ANTHROPIC_API_KEY` silently overrides subscription auth — the Aug-10 lesson):

```bash
cd /opt/orcha-work/<workspace>
env -u ANTHROPIC_API_KEY -u ORCHA_LLM_API_KEY orcha up   # compose + notifier + terminal-bridge
```

Worker credentials come from `/root/.orcha-daemon-env` (BYOC subscription token or
API key) — restore it from the backup and `set -a; source` it before `orcha up` if
used. Sandbox mode per workspace: `orcha sandbox on && orcha sandbox build-image`.

## 7. Verify (the same checks used in production)

```bash
curl -s localhost:<port>/api/plan            # {"plan":"team","features":{"members":true},...}
curl -s localhost:<port>/api/containers      # workspaces listed
docker logs <stack>-portal-1 | grep migrate  # chain applied, tip = latest migration
curl -s localhost:<port>/api/containers/<cid>/github/issues | head -c 80   # App token works
# wake sanity: watch worker_runs count for 10 min — the wake circuit breaker
# (migration 048) suppresses no-progress loops; wake_backoff table should stay empty.
https://orcha.<domain>  → GitHub login → portal
```

## 8. Known operational gotchas (earned the hard way)

- `ORCHA_PLAN=team` lives in `.env` so `orcha upgrade` compose re-renders keep it.
- Never `orcha init --force` / `orcha down -v` on a live workspace (DB wipe);
  relaunch is `orcha up`.
- Deploy = rsync `portal_backend/ static/ main.py migrations/` into
  `.orcha/portal/` + `docker compose build portal && up -d portal`; the CLI/daemon
  side is `bootstrap-clone.sh` + `uv tool install --reinstall` + daemon restart.
- Subscription-billed agent runs record **$0** — watch RUN COUNTS in Metrics
  (the `subscription-loop` insight), not dollars.
- The box-wide sandbox concurrency cap derives from `/proc/meminfo`
  (`ORCHA_MAX_CONCURRENT_SANDBOXES` overrides).
- Firecracker/microVM runner tier needs bare metal (`/dev/kvm`) — Hetzner Cloud
  VPSes don't have it; dedicated AX-class does.
