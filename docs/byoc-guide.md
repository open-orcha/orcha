# Orcha Cloud BYOC — the complete guide

Bring-your-own-cloud, end to end: what it is, how the deployed system actually
works, what is automated versus still done by hand, and the exact steps that
turn a bare Ubuntu VM into an auth-fronted Orcha with sandboxed agent wakes.
Everything here describes what ships on this repo's `main` **today** — nothing
aspirational. Where a piece is manual or has a known gap, it says so.

Reference deployment used throughout: `orcha.nursoftai.com` — one shared
Hetzner box that also serves unrelated sites behind a **host (systemd) Caddy**,
with the Orcha portal loopback-bound on `127.0.0.1:8001`. Your box may instead
be dedicated (nothing else on 80/443), which is the simpler path; both shapes
are covered.

Related reading: `docs/orcha-cloud.md` (repo overview + tiers),
`deploy/README.md` (terse bootstrap), `docs/sandbox-mode.md` (runner),
`docs/device-tokens.md` (phone auth), `docs/collab.md` (identity + members),
`docs/github-dashboard.md` (repo binding), `docs/metrics.md` (cost page),
`docs/superpowers/specs/2026-07-30-auth-perimeter-design.md` and
`docs/superpowers/specs/2026-07-29-orcha-cloud-remote-runner-design.md` (the
designs behind all of this).

---

## 1. What BYOC is

Orcha is open-core. Three product tiers share one codebase:

1. **Self-host (free, OSS)** — today's Orcha, DIY on your laptop or server.
   No auth perimeter, no fleet layer; you run `orcha init` and you're on your
   own. Complete and unrestricted.
2. **BYOC — bring your own VPC (paid)** — this guide. The customer hands us a
   VM in *their* cloud (SSH access or a bootstrap script); we install Docker +
   orcha-cli, bring up the stack, front it with the auth perimeter, and apply
   fleet upgrades. Billing is a platform fee (per workspace/seat) — we don't
   sell the machine.
3. **Full cloud (paid)** — our rented VMs, all-inclusive; billing includes
   sandbox compute-hours.

**What the customer keeps** (BYOC):

- **The VM** — theirs, in their cloud account, their network rules.
- **The data** — the per-project Postgres and every workspace live on their
  disk. Nothing is copied out.
- **The repos** — their GitHub App installation, on their orgs, scoped to the
  repos they select. Uninstall the app and Orcha's repo access is gone.
- **The model credential** — BYO keys (`ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` / `ORCHA_LLM_API_KEY`), or — legitimate on BYOC because it
  is their box and their seat — their own **Claude subscription** via
  `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` in the daemon environment.
  The sandbox runner passes it through to containers exactly like an API key
  (`ENV_PASSTHROUGH` in `orcha-cli/orcha_cli/sandbox.py`). Caveat: a
  setup-token binds one individual seat with personal rate limits — fine for
  testing and small teams, not team-scale production throughput.

**What Orcha Cloud operates**: orchestration of the box — bootstrap, the auth
perimeter (TLS, GitHub sign-in, token lanes), project provisioning, the
box-side timers, upgrades, and fleet visibility.

**The open-core boundary**: everything running *inside* the VM is open-source
Orcha — the same `orcha-cli`, portal, Postgres, notifier, and sandbox runner a
self-hoster gets. The fleet layer — `deploy/` (auth perimeter, provisioner,
timers), and later the control plane — is this private repo and stays closed.
Cloud and OSS never fork: the BYOC bootstrap installs the same CLI from the
same tree.

---

## 2. Architecture

### Topology

```
                             internet
                                │ :443 (TLS, ACME; :80 stays open for HTTP-01)
                     ┌──────────▼──────────┐
                     │        Caddy        │  containerized (dedicated box)
                     │                     │  or host systemd (shared box)
   browser ──────────┼─► forward_auth ─────┼──► oauth2-proxy :4180
   (GitHub OAuth)    │    /oauth2/auth     │    (GitHub, username allowlist)
                     │                     │
   iOS app ──────────┼─► Bearer <device> ──┼──► forward_auth portal
   (device token)    │    /api/auth/check  │    202 + X-Auth-Request-User
                     │                     │
   break-glass ──────┼─► Bearer <team> ────┼──► straight through (no validator)
   (team token)      │                     │
                     └──────────┬──────────┘
                                │ loopback / compose network
                                │ (the portal NEVER binds a public port)
                    ┌───────────▼───────────┐
                    │  Orcha stack (OSS)    │  one per project, from `orcha init`
                    │  portal :8000 ── PG   │  portal published on 127.0.0.1 only
                    └───────────┬───────────┘
                                │ wakes (decided by the portal, executed by…)
                 ┌──────────────▼──────────────┐
                 │  notifier daemon            │  one per project workspace
                 │  (host process, env from    │  /opt/orcha-work/<slug>
                 │   /root/.orcha-daemon-env)  │  supervised by orcha-notifier@<slug>
                 │                             │  .service when installed (#77),
                 │                             │  else nohup + `--ensure` self-heal
                 └──────┬───────┬───────┬──────┘
                     ┌──▼─┐  ┌──▼─┐  ┌──▼─┐      one docker container per
                     │ s1 │  │ s2 │  │ s3 │      agent run: non-root, capped,
                     └────┘  └────┘  └────┘      labeled, fail-loud

   box-side systemd timers (root):
     provision-projects (2 min)  portal projects → workspace + clone + notifier
     sync-members       (2 min)  portal roster → OAuth allowlist
     github-token-refresh (40 m) App PEM → 1-hour repo tokens in each workspace

   box-side systemd template unit (optional, root):
     orcha-notifier@<slug>.service   Restart=on-failure, one instance/workspace
```

### Components, each one's job and trust level

**Caddy (TLS + routing)** — the only public entrance. Terminates TLS (ACME;
port 80 must stay open for HTTP-01 renewal) and routes by credential, in
order (`deploy/auth/Caddyfile` — handle blocks match top-down, and the order
is load-bearing because the team token also matches the wildcard):

1. `Authorization: Bearer <team token>` — exact match → proxied straight to
   the portal, **no validator involved**. This is the break-glass lane: it
   works even if the portal's device-token validator is down. It carries no
   identity by definition, so Caddy **strips any client-forged
   `X-Auth-Request-User`** on this lane (`header_up -X-Auth-Request-User`) —
   without that strip a team-token caller could impersonate any member.
2. Any other `Bearer *` — treated as a **device token**: `forward_auth` →
   `GET /api/auth/check` on the portal. Valid → 202 with
   `X-Auth-Request-User: <github_login>`, which `copy_headers` carries
   upstream. Invalid/revoked → plain `401` body (never the browser redirect —
   API clients need a clean status).
3. `/oauth2/*` — proxied to oauth2-proxy (sign-in, callback, sign-out).
4. Everything else (browsers) — `forward_auth` → oauth2-proxy `/oauth2/auth`;
   a valid session forwards `X-Auth-Request-User` + `X-Auth-Request-Email`
   upstream; 401 redirects to `/oauth2/sign_in?rd=<original url>`.

**oauth2-proxy (GitHub sign-in)** — `quay.io/oauth2-proxy/oauth2-proxy:v7.6.0`
in auth-only mode (`OAUTH2_PROXY_UPSTREAMS: static://202`); Caddy does the
proxying, oauth2-proxy only answers `/oauth2/*` and the auth check. Access is
limited to an explicit comma-separated GitHub username allowlist
(`OAUTH2_PROXY_GITHUB_USERS` ← `ALLOWED_GITHUB_USERS` in `deploy/auth/.env`).
The allowlist is the **hard door**; everything identity-shaped inside the
portal only decides what a signed-in user can see and do.

**The device-token lane (phones)** — per-device revocable bearer tokens tied
to one member's verified GitHub identity (`docs/device-tokens.md`, migration
038). Pairing: the portal's pairing modal shows a QR; the iOS app opens
`https://<box>/auth/device` in an in-app browser sheet → that page rides the
browser lane (GitHub OAuth, allowlist enforced) → it fetches
`POST /api/device-tokens` same-origin → the portal resolves the login to a
live member and mints `secrets.token_urlsafe(32)` → the page redirects to
`orcha://auth/callback?host=…&token=…` (manual copy fallback stays on
screen). Only the **sha256** of the token is stored; validation is
`GET /api/auth/check` (matches by hash against unrevoked rows whose member is
still live; stamps `last_used_at` at most once per 60 s per token, so a
3-second-polling phone costs one UPDATE a minute). Revocation is immediate;
removing a member kills all their tokens with no separate step. Non-members
who sign in get a 403 and "ask an owner to invite you."

**Portal + Postgres (OSS, per project)** — exactly the stack `orcha init`
renders; one compose stack, one Postgres, one portal per project. On a BYOC
box the portal's published port is rebound to `127.0.0.1` (compose override
`deploy/auth/docker-compose.portal-local.yml`) so the perimeter is the only
way in from outside. **Inside** the box, agents and sandbox containers reach
`portal:8000` over the compose network directly — the perimeter guards the
outside only; in-box calls are the same trust domain as a laptop self-host.

**Identity flow, end to end** — the portal reads `X-Auth-Request-User` only
when its env carries `ORCHA_TRUST_PROXY_USER=1` (safe *only* because the
portal is loopback-bound behind the proxy; never set it on a
directly-reachable portal, where any client could forge the header). From the
trusted header:

- `GET /api/me?cid=` maps the login to the container's live human agent
  (`agents.github_login`, migration 036). **Binding rule**: on a fresh
  container whose only human is the unnamed `orcha init` one, the first
  verified arrival *is* that human — it gets the login, is renamed to it, and
  is promoted to owner.
- **Roles** (migration 039): `owner` / `member` / `viewer`. Viewer is
  read-only, absolutely — no grant unlocks a viewer write. **Grants** are
  additive extras on member/viewer, held implicitly by owners: `manage_keys`
  (LLM/provider keys + model settings), `manage_members` (invite/remove/
  re-role below owner + see the full roster), `manage_repo` (bind/unbind the
  GitHub repo), `manage_autonomy` (notifier/wake switches), `manage_agents`
  (register/retire/model changes), `assign_reviewers`.
- **Project isolation**: `GET /api/containers` is filtered to containers
  where the signed-in login is a live human member — a member of nothing sees
  nothing. Multi-project boxes get the `/projects` landing hub (bare `/`
  redirects there when project count ≠ 1). Roster privacy: non-
  `manage_members` members see only their own row.
- The **team-token lane carries no identity** — the portal treats those
  requests as trust-off (permissive body-actor semantics, same as self-host).

**Notifier daemons (one per project)** — the OSS wake daemon
(`orcha notifier`), running as a host process per workspace, pidfile
`<ws>/.claude/.orcha-notifier.pid`, log `<ws>/.claude/.orcha-notifier.log`.
Its environment is the credential boundary: the provider key or subscription
token must be present in the process env that starts it (sourced from
`/root/.orcha-daemon-env` by the provisioner). Interactive host login state
(`claude login`) does **not** reach sandbox containers.

**Sandbox runner (OSS, `docs/sandbox-mode.md`)** — every agent wake is one
`docker run` of `orcha/runner:0.5` instead of a host process:

- **Non-root**: the runner image runs as uid 1000 (`USER node` in
  `orcha-cli/orcha_cli/templates/runner/Dockerfile`) — Claude Code
  hard-refuses `--dangerously-skip-permissions` under root, and
  least-privilege is right anyway. Workspaces are chowned to uid 1000 on
  Linux hosts (the provisioner does this).
- **Capped**: `--memory` / `--cpus` / `--pids-limit` (defaults 4g / 2 / 512;
  the provisioner sets conservative 1536m / 1 per project), plus a 2-hour
  wall-clock deadline enforced by the reaper.
- **Labeled**: `orcha.managed=1`, `orcha.container_name=<name>`,
  `orcha.cid=<project container id>` (scopes the reaper's sweeps to *this*
  project on a multi-stack host), `orcha.sidecar=1` for drain sidecars
  (orphan-sweep exemption).
- **Scoped filesystem**: only the workspace is mounted — **path-identically**
  (same absolute path inside the container, so git-worktree `.git` pointer
  files and token paths stay valid; the spawner stamps
  `ORCHA_WORKSPACE_ROOT=<root>`) — plus a durable agent-home mount
  (`<root>/.orcha/agent-home` → `~/.claude`, session continuity across
  containers) and a read-only api-config override that rewrites
  `api_base_url` to `http://portal:8000` so the agent's skill calls reach the
  portal over the compose network. No docker socket, no other host mounts.
- **Secrets via env, never argv**: identity and keys ride the client
  process's environment through `docker run -e KEY` — they never appear in
  `ps` output.
- **Fail-loud, never fall back**: if Docker is down, the image is missing, or
  disk is under 5 GiB, the wake fails with a visible reason. De-sandboxing is
  never silent.
- **Durable**: runs are re-adopted by container name on daemon restart —
  `orcha update` or a notifier crash never kills in-flight work. The resident
  (conversation) lane is sandboxed too (`docker run -i`, deadline-exempt).

**The GitHub App — one app, three jobs** (created once by
`deploy/setup-github.py`):

1. **Sign-in** — its OAuth client id/secret drive oauth2-proxy. The app is
   created **public** by the manifest, deliberately: a private GitHub App
   404s the OAuth authorize step for every account except its owner, so
   invited members could never sign in.
2. **Repo listing + binding** — the portal's Connect-repo modal lists every
   repo the app is installed on (`GET /api/github/repos`, merged across all
   installations via the `github-tokens.json` per-owner token map) and binds
   one per project (`PUT /api/containers/{cid}/github`, migration 035).
3. **Installation tokens for clone/push/PR** — `deploy/github-app-token.py`
   mints 1-hour, repo-scoped installation tokens from the app's PEM. The PEM
   stays on the host at `/opt/orcha-secrets/`, always; containers only ever
   see the short-lived tokens via the workspace mount
   (`<workspace-root>/.orcha/github-token`, resolved through
   `$ORCHA_WORKSPACE_ROOT`), which the standard git credential helper reads. Agents open PRs as the app bot; the human PR review remains
   the authority gate. Multi-org: install the app once per org; the refresh
   timer discovers all installations and owner-matches bound repos.

**Provisioner (`deploy/provision-projects.sh`, 2-min timer)** — closes the
"portal-only project" gap. A project created from the portal
(`POST /api/containers`) starts as a DB row with no runtime; each tick the
provisioner gives every such container: a workspace at
`/opt/orcha-work/<slug>` (cloned from the bound repo via a once-used,
scrubbed App token, or empty with an explanatory README), a
`.claude/orcha.json` binding it to the loopback portal with sandbox ON and
the stack network **pinned** (auto-detected from the running portal
container — a cloned repo carrying its own `.orcha/docker-compose.yml` would
otherwise derive a nonexistent network and wakes die with exit 125), a chown
to uid 1000, a line in the box-wide registry
`/opt/orcha-work/workspaces.list` (`<cid> <dir>`), and a notifier. When the
`orcha-notifier@.service` template unit is installed (issue #77), the
provisioner enables+starts a per-workspace systemd instance
(`orcha-notifier@<slug>`, `Restart=on-failure`) instead; otherwise it falls
back to `orcha notifier --ensure` (env from `/root/.orcha-daemon-env`). Both
paths write the same pidfile/heartbeat/claim, so they compose safely and
never double-spawn. Idempotent throughout; pre-registry hand-built workspaces
are *adopted*; the notifier pass re-runs/re-affirms every tick either way, so
daemons self-heal after a reboot (systemd instances also restart on crash
without waiting for the timer).

**Members → allowlist sync (`deploy/sync-members.sh`, 2-min timer)** — the
portal roster is the source of truth for *who is a member* (owners invite in
Settings → Members); the OAuth allowlist is the hard door. The sync unions
the member logins of **all** projects (an invite on any project must open the
door), rewrites `ALLOWED_GITHUB_USERS` in `deploy/auth/.env`, and restarts
oauth2-proxy only when the roster actually changed. An invite becomes a
working sign-in within ~2 minutes, no operator action.

**Token refresh (`deploy/github-token-refresh.sh`, 40-min timer; tokens live
60)** — reads the provisioner's registry, and per workspace writes
`.orcha/github-token` (repo-bound containers get an owner-matched,
repo-scoped mint) and `.orcha/github-tokens.json` (the per-owner map the
portal reads for multi-org repo listing).

**Metrics (`docs/metrics.md`)** — the portal's `/metrics` page: estimated
spend, runs, sandbox compute time, tokens per agent over 7/30 days
(`GET /api/containers/{cid}/metrics?days=`). Cost comes from
daemon-recorded columns or a tail-parse of the run output; the total is
labeled honestly ("N of M runs reported cost"). Sandbox rows in
`worker_runs` (`started_at`/`ended_at`, migration 034) are also the future
billing meter — no separate metering system exists or is needed.

---

## 3. Automated vs manual — the honest matrix

Every step from zero to operating, who does it, and the exact artifact.
"Manual-ssh" means you type commands on the box today; the planned control
plane (§7) exists to eat that column.

| # | Step | Done by | Artifact / where |
|---|------|---------|------------------|
| 1 | DNS A record `orcha.<domain>` → box IP | **manual** (registrar) | your DNS provider |
| 2 | Firewall: 22/80/443 only | one manual command | `ufw allow 22,80,443/tcp && ufw enable` |
| 3 | Docker on the box | one command | `curl -fsSL https://get.docker.com \| sh` |
| 4 | GitHub App creation (sign-in + repo credentials, complete `.env`) | **script + ONE GitHub click** (on your laptop) | `deploy/setup-github.py` (manifest flow; writes `deploy/auth/.env`, `github-app.json`, `github-app.pem`) |
| 5 | App made public | automatic | the manifest sets `"public": true` — required, or invited members' sign-in 404s |
| 6 | Install App + select repos | **GitHub clicks** | app page → Install App → pick repos; repeat once per org |
| 7 | Secrets placement | **manual scp** | `github-app.pem` + `github-app.json` → box `/opt/orcha-secrets/` (`chmod 600` the PEM); `.env` → `/opt/orcha-cloud/deploy/auth/.env` (after step 8's clone) |
| 8 | Clone repo + install orcha-cli | one script | `deploy/bootstrap-clone.sh` (App-token clone → `/opt/orcha-cloud`, token scrubbed, `uv tool install`) — re-run anytime to pull + reinstall |
| 9 | First project stack | manual-ssh (one-time) | `orcha init` in `/opt/orcha-work/<name>` + `orcha sandbox on` + `orcha sandbox build-image` |
| 10 | Daemon credentials + trust env | **manual-ssh** | `/root/.orcha-daemon-env` (`chmod 600`): `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (or `ANTHROPIC_API_KEY`), `ORCHA_TRUST_PROXY_USER=1`; the trust flag also in `<ws>/.orcha/.env` for the portal |
| 11 | Portal loopback rebind | one compose command | `deploy/auth/docker-compose.portal-local.yml` (adjust the port if the stack rendered ≠ 8000) |
| 12 | Auth stack (dedicated box) | one compose command | `docker compose --env-file .env -f docker-compose.auth.yml up -d` |
| 13 | Auth stack (shared box, host Caddy) | compose command **+ manual Caddy edit** | `-f oauth2-proxy-host.yml up -d oauth2-proxy` (loopback :4180) + hand-add the site block to `/etc/caddy/Caddyfile` (§4 step 9 has the reference block) — **manual today** |
| 14 | Branded sign-in landing (`/welcome`) | **manual today** (optional) | `deploy/auth/welcome/index.html` exists in the repo but nothing wires it; the reference box hand-serves it from host Caddy |
| 15 | systemd timers (×3) | scp + two commands each | `deploy/{github-token-refresh,sync-members,provision-projects}.{service,timer}` → `/etc/systemd/system/` → `systemctl enable --now <name>.timer` |
| 15b | Notifier template unit (issue #77, recommended) | scp + two commands | `deploy/orcha-notifier@.service` → `/etc/systemd/system/` → `systemctl daemon-reload`; the provisioner then enables+starts one instance per workspace on its next tick — no per-workspace unit files by hand |
| 16 | Timer → portal port alignment | **manual check** | the timer scripts default `ORCHA_PORTAL_URL=http://127.0.0.1:8001` (the reference box); if your portal is on another loopback port, set `Environment=ORCHA_PORTAL_URL=…` on the units |
| 17 | New projects after setup | **automatic** | portal "New project" → `provision-projects` timer gives it workspace + clone + notifier within 2 min |
| 18 | Team invites | **portal UI** (owner) | Settings → Members; `sync-members` opens the OAuth door within 2 min |
| 19 | Phone pairing | **portal UI** (QR) | pairing modal → `/auth/device` → GitHub OAuth → device token via `orcha://` callback |
| 20 | iOS app on the phone | **manual build/install today** | `ios/` in this repo (no TestFlight yet) |
| 21 | Upgrades | **manual today** | re-run `bootstrap-clone.sh`, then `orcha update` per workspace (§5); auth stack: `docker compose up -d`. Control plane later |
| 22 | Swap provisioning (recommended) | **manual-ssh, one script, run once** | `deploy/provision-swap.sh` — 4GB swapfile (`SIZE_GB` to override), fstab-persisted, idempotent; a swapless box thrashes instead of degrading under an agent burst (§5 Known failure modes) |

---

## 4. Setup walkthrough — bare Ubuntu VM to first agent reply

Budget **about an hour** of real time, most of it the one-time GitHub and
secrets choreography. Steps 1–3 and 5–8 run on the **box** (as root); step 4
runs on your **laptop** (it needs a browser). `<box>` is your SSH target,
`orcha.example.com` your domain. Each step ends with its verification.

**1. DNS + firewall.**

Create the A record `orcha.example.com` → the box's public IP, then on the
box:

```bash
ufw allow 22,80,443/tcp && ufw enable
```

Verify: `dig +short orcha.example.com` prints the box IP.

**2. Docker.**

```bash
curl -fsSL https://get.docker.com | sh
```

Verify: `docker info` shows a server.

**3. Secrets directory** (populated in step 4):

```bash
mkdir -p /opt/orcha-secrets /opt/orcha-work
```

**4. GitHub App — laptop, one command + one click.**

From a checkout of this repo on your laptop:

```bash
python3 deploy/setup-github.py \
  --domain orcha.example.com --acme-email you@example.com \
  --users your-github-username \
  --stack-network orcha-<project>_default        # the name your step-6 project will get
```

Your browser opens; click **Create GitHub App** — that's the only click. The
script exchanges the one-time code for the app's credentials and writes a
complete `deploy/auth/.env` (cookie secret and team bearer token generated
too), plus `github-app.json` / `github-app.pem`. Use `--org <name>` to create
the app under an organization.

Then: on the app's page → **Install App** → select the repos Orcha should
reach (repeat per org, for multi-org teams). Copy the credentials to the box:

```bash
scp deploy/auth/github-app.pem deploy/auth/github-app.json <box>:/opt/orcha-secrets/
ssh <box> chmod 600 /opt/orcha-secrets/github-app.pem
```

Verify (box): `python3 -c "import json;print(json.load(open('/opt/orcha-secrets/github-app.json'))['id'])"`
prints the app id.

**5. Clone + install orcha-cli** (via the App — no PATs, no deploy keys):

```bash
scp deploy/github-app-token.py deploy/bootstrap-clone.sh <box>:/tmp/
ssh <box> 'sh /tmp/bootstrap-clone.sh'     # → /opt/orcha-cloud, installs orcha-cli
scp deploy/auth/.env <box>:/opt/orcha-cloud/deploy/auth/.env
```

The mint token is used once for the clone and scrubbed from git config.
Verify: `ssh <box> orcha --version`.

Recommended here, not automatic — provision swap while you're already on the
box (a swapless box thrashes instead of degrading under an agent burst; §5
Known failure modes has the sizing rationale):

```bash
ssh <box> 'sh /opt/orcha-cloud/deploy/provision-swap.sh'    # 4GB default, SIZE_GB to override
```

**6. First project + sandbox mode** (on the box; use `/opt/orcha-work/` so
the provisioner's registry adopts it):

```bash
mkdir -p /opt/orcha-work/myproj && cd /opt/orcha-work/myproj
orcha init            # renders the stack; NOTE the portal port it picks (8000+)
orcha sandbox on
orcha sandbox build-image
```

If the directory is a clone of your repo, `orcha init` auto-binds the GitHub
origin to the project. Verify: `orcha sandbox status` shows
`enabled: true` and the image present.

**7. Daemon credentials + proxy trust.**

```bash
# on any machine with Claude Code + your subscription:
claude setup-token                      # one interactive mint

# on the box:
cat > /root/.orcha-daemon-env <<'EOF'
CLAUDE_CODE_OAUTH_TOKEN=<the token>     # or: ANTHROPIC_API_KEY=sk-ant-...
ORCHA_TRUST_PROXY_USER=1
EOF
chmod 600 /root/.orcha-daemon-env
echo 'ORCHA_TRUST_PROXY_USER=1' >> /opt/orcha-work/myproj/.orcha/.env
```

The daemon-env file feeds every notifier the provisioner starts; the
`.orcha/.env` line feeds the portal container (compose passthrough). Sandbox
containers get credentials **only** via env passthrough from the notifier's
process — host `claude login` state never reaches them.

Bring the stack up with the env sourced:

```bash
cd /opt/orcha-work/myproj
set -a; . /root/.orcha-daemon-env; set +a
orcha up
```

Verify: `curl -s http://127.0.0.1:<port>/api/containers` returns JSON.

**8. Bind the portal to loopback** (public entrance = Caddy only):

```bash
cd /opt/orcha-work/myproj/.orcha
docker compose -f docker-compose.yml \
  -f /opt/orcha-cloud/deploy/auth/docker-compose.portal-local.yml up -d portal
```

The overlay publishes `127.0.0.1:8000:8000`; edit your copy if `orcha init`
picked a different port (the reference box runs `127.0.0.1:8001` because 8000
was taken by an unrelated service). Verify from your laptop:
`curl -sI http://<box-ip>:<port>` → connection refused.

**9. Auth perimeter.** Two shapes:

**(a) Dedicated box** — containerized Caddy owns 80/443:

```bash
cd /opt/orcha-cloud/deploy/auth
docker compose --env-file .env -f docker-compose.auth.yml up -d
```

**(b) Shared box (the reference deployment)** — a host systemd Caddy already
fronts other sites, so run only oauth2-proxy (published loopback :4180):

```bash
cd /opt/orcha-cloud/deploy/auth
docker compose --env-file .env -f docker-compose.auth.yml \
  -f oauth2-proxy-host.yml up -d oauth2-proxy
```

…and hand-add the Orcha site block to `/etc/caddy/Caddyfile` — **manual
today**; this is the reference block (portal on loopback `:8001` — substitute
your port; substitute the literal team token from `deploy/auth/.env`, or wire
an `EnvironmentFile=` drop-in on `caddy.service` and keep the placeholder):

```caddyfile
orcha.example.com {
    # Bearer lane 1: exact team-token match — break-glass, no validator.
    # MUST stay ahead of the wildcard lane; strip forged identity headers.
    @team header Authorization "Bearer {$ORCHA_TEAM_TOKEN}"
    handle @team {
        reverse_proxy 127.0.0.1:8001 {
            header_up -X-Auth-Request-User
        }
    }

    # Bearer lane 2: any other bearer token is a per-device token.
    @bearer header Authorization "Bearer *"
    handle @bearer {
        forward_auth 127.0.0.1:8001 {
            uri /api/auth/check
            copy_headers X-Auth-Request-User
            @error status 401
            handle_response @error {
                respond "unauthorized: invalid or revoked token" 401
            }
        }
        reverse_proxy 127.0.0.1:8001
    }

    # OAuth plumbing (sign-in, callback, auth check).
    handle /oauth2/* {
        reverse_proxy 127.0.0.1:4180 {
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-Uri {uri}
        }
    }

    # Slack lane: unauthenticated-but-signed inbound webhooks (Slack commands +
    # interactivity). Slack can't complete OAuth or send a bearer token, so this
    # bypasses forward_auth entirely — the app-level Slack v0 HMAC signature check
    # (slack_routes.verify_slack_signature) is the real gate, and the whole surface
    # stays 503 unless SLACK_SIGNING_SECRET + SLACK_BOT_TOKEN are configured.
    handle /api/slack/* {
        reverse_proxy 127.0.0.1:8001
    }

    # Everything else: browsers behind forward_auth.
    handle {
        forward_auth 127.0.0.1:4180 {
            uri /oauth2/auth
            header_up X-Real-IP {remote_host}
            copy_headers X-Auth-Request-User X-Auth-Request-Email
            @error status 401
            handle_response @error {
                redir * /oauth2/sign_in?rd={scheme}://{host}{uri}
            }
        }
        reverse_proxy 127.0.0.1:8001
    }
}
```

Then `systemctl reload caddy`.

Verify the perimeter (the four checks, from your laptop):

```bash
# 1. Browser → https://orcha.example.com → GitHub sign-in → portal (allowlisted users only)
# 2. Bearer lane answers JSON:
curl -H "Authorization: Bearer $ORCHA_TEAM_TOKEN" https://orcha.example.com/api/containers
# 3. No credential → sign-in redirect, not data:
curl -sI https://orcha.example.com/api/containers        # → 302 to /oauth2/sign_in
# 4. The portal itself is unreachable from outside:
curl -sI http://<box-ip>:8001                            # → connection refused
```

**10. Box-side timers:**

```bash
cd /opt/orcha-cloud/deploy
cp github-token-refresh.{service,timer} sync-members.{service,timer} \
   provision-projects.{service,timer} /etc/systemd/system/
cp orcha-notifier@.service /etc/systemd/system/    # issue #77: notifier supervision
systemctl daemon-reload
systemctl enable --now github-token-refresh.timer sync-members.timer provision-projects.timer
```

Installing `orcha-notifier@.service` needs no `enable --now` of its own — it's
a template unit (`orcha-notifier@<workspace>.service` per instance), and the
`provision-projects` timer enables+starts the right instances for you on its
next tick (existing and future workspaces alike). Without this unit
installed, notifiers still run — the provisioner falls back to its nohup
`orcha notifier --ensure` path — just without systemd restart-on-crash or
reboot persistence ahead of the 2-min timer.

**Port alignment**: the three scripts default to
`ORCHA_PORTAL_URL=http://127.0.0.1:8001`. If your portal loopback port
differs, add `Environment=ORCHA_PORTAL_URL=http://127.0.0.1:<port>` to each
`.service` (systemd override or edit) before enabling. Verify:
`systemctl start provision-projects.service && journalctl -u provision-projects.service -n 20`
shows the adopt/provision pass, and `/opt/orcha-work/workspaces.list` lists
your project. With the notifier unit installed, also verify
`systemctl status 'orcha-notifier@*'` shows an active instance per workspace.

**11. First agent reply.** In the portal (signed in via GitHub): your first
arrival binds you as the project's owner (the `orcha init` human takes your
GitHub identity). Register an agent, give it a task or send a chat message,
and watch the run: `docker ps` on the box shows one `orcha-run-*` container
during the wake, `pgrep -x claude` on the host stays empty, and the reply
lands in the portal. That's the whole loop, sandboxed.

From here on, **new projects need no SSH**: create them in the portal, the
provisioner gives them a runtime within 2 minutes; invite teammates in
Settings → Members, the allowlist follows; pair phones from the pairing QR.

---


## GitHub App — permissions & settings reference (field-hardened)

Everything the Orcha GitHub App needs, with the failure you'll see when it's
missing. `deploy/setup-github.py` now creates apps with all of this baked in;
apps created before 2026-08-01 need the manual fixes below.

| Setting | Required value | Where | Symptom when wrong |
|---|---|---|---|
| App visibility | **Public** | App settings → Advanced → Make public | Any account except the app owner gets GitHub's 404 on the OAuth authorize step — invitees can never sign in (private apps are owner-authorizable only) |
| Account permissions → Email addresses | **Read-only** | App settings → Permissions & events | OAuth callback 500s: oauth2-proxy fetches `/user/emails` to mint the session → GitHub 403 "Resource not accessible by integration" |
| Repository permissions → Contents | **Read and write** | App settings → Permissions & events | Read-only: clone and repo listing work, but the agent's `git push` 403s — no branches, no PRs |
| Repository permissions → Pull requests | **Read and write** | App settings → Permissions & events | `gh pr create` fails as the bot |
| Repository permissions → Issues | **Read and write** | App settings → Permissions & events | `gh issue create` 403s — agents cannot file findings as issues |
| Repository permissions → Metadata | Read-only (automatic) | — | — |
| Webhook | Inactive (none needed) | App settings → Webhook | — |
| **Installation** | App installed on EVERY org/account whose repos agents touch | App page → Install App → *Only select repositories* | Repos absent from the Connect-repo list; token mint fails "installed on nothing"; multi-org is supported (tokens are minted per-owner) |
| **Permission-update approval** | Org admin accepts pending request after any permission change | Org → Settings → GitHub Apps → Configure | New scopes silently absent from freshly minted tokens until accepted — pushes keep 403ing after you "fixed" the permission |
| **App rename** | Update `slug` in `/opt/orcha-secrets/github-app.json` to the new `github.com/apps/<slug>` | box secrets file | Bot commits stop linking to the bot account (unknown author, no avatar) — the provisioner stamps identity from the stored slug |

Credentials placement (never in a container, never in git): client id/secret →
`deploy/auth/.env` (0600); private key + app metadata → `/opt/orcha-secrets/`
on the box (0600). Installation tokens (1 h) are the only credentials agents
ever see.

## 5. Operations

### Upgrades (manual today; control plane later)

```bash
ssh <box> 'sh /opt/orcha-cloud/deploy/bootstrap-clone.sh'   # pull + reinstall CLI
# then, per workspace (repeat for each line in /opt/orcha-work/workspaces.list):
ssh <box> 'cd /opt/orcha-work/<proj> && set -a; . /root/.orcha-daemon-env; set +a; orcha update'
```

`orcha update` reinstalls the project's templates/portal/migrations and
restarts the stack without a data wipe; sandbox runs in flight survive (the
daemon re-adopts them by container name). Rebuild the runner image when the
CLI release notes say so: `orcha sandbox build-image`. Auth stack upgrades:
edit/pull under `/opt/orcha-cloud/deploy/auth`, then
`docker compose --env-file .env -f docker-compose.auth.yml up -d`.

### Boot resilience (restart policies)

Every long-running container in both stacks — the Orcha stack's `portal` and
`db` (`docker-compose.yml.j2`), and the auth stack's `caddy` and
`oauth2-proxy` (`deploy/auth/docker-compose.auth.yml`) — runs with
`restart: unless-stopped`. After a host reboot or a Docker-daemon restart,
all four come back with zero manual commands: `docker compose up -d` is not
needed. `unless-stopped` is chosen over the bare `always` specifically so an
operator's deliberate `docker compose stop <service>` (or `down`, without
`-v`) stays sticky — Docker will not silently resurrect a service you
intentionally took offline on the next daemon restart. `restart: "no"`
(compose's implicit default when the key is absent) was the original gap on
the Orcha stack: `portal` and `db` had no policy at all, so only the auth
stack's `caddy`/`oauth2-proxy` (which already carried `restart:
unless-stopped`) came back after a power cycle.

If you rsync a working tree to the box instead of pulling, **always** exclude
the live secrets — a `--delete` rsync has wiped a box's `.env` before:

```bash
rsync -az --delete --exclude 'deploy/auth/.env' --exclude 'deploy/auth/github-app*' \
      ./ <box>:/opt/orcha-cloud/
```

Standing rule (same as everywhere in Orcha): relaunch with `orcha up` /
`orcha update` — never `orcha init --force` (new container) or
`orcha down -v` (DB wipe) on a live box.

### Token rotation

- **Team token** (break-glass, iOS/API): edit `ORCHA_TEAM_TOKEN` in
  `/opt/orcha-cloud/deploy/auth/.env`, then `docker compose --env-file .env
  -f docker-compose.auth.yml up -d`. On a **host-Caddy** box the token lives
  in `/etc/caddy/Caddyfile` (or its env drop-in) — edit there too and
  `systemctl reload caddy`.
- **Device tokens**: self-serve. `GET /api/device-tokens` lists the acting
  identity's tokens; `DELETE /api/device-tokens/{id}` revokes (own tokens;
  project owners can revoke any member's). Effective on the next request.
  Lost phone and no portal access? The team token bypasses the validator —
  an operator can always get in to revoke.
- **GitHub tokens**: nothing to rotate — 1-hour installation tokens,
  refreshed every 40 minutes by the timer. Compromise response: revoke the
  App's key on GitHub, re-generate, replace `/opt/orcha-secrets/github-app.pem`.
- **Subscription token**: re-run `claude setup-token`, update
  `/root/.orcha-daemon-env`, restart notifiers (kill them; the provisioner's
  next tick re-ensures each with the fresh env).

### Member removal

`DELETE /api/containers/{cid}/members/{aid}` (or Settings → Members →
Remove): retire semantics — the agent row gets `terminated_at`, its tasks are
released, its reviewer assignments revert to *anyone*, **every device token
it held stops validating immediately**, and within 2 minutes `sync-members`
drops the login from the OAuth allowlist. One action closes both doors. The
last owner can't be demoted or removed.

### Backup surface

All state is on the box:

- **Postgres volumes** — one per project stack, named
  `orcha-<project>_pgdata` (agents, tasks, runs, threads, device-token
  hashes, encrypted provider keys).
- **Workspaces** — `/opt/orcha-work/*` (repo checkouts, build caches, run
  logs) + the registry file `workspaces.list`.
- **Secrets** — `/opt/orcha-secrets/` (App PEM + id) and
  `/opt/orcha-cloud/deploy/auth/.env` (OAuth secret, cookie secret, team
  token). Neither is recoverable from the repo — lose them and you re-run
  `setup-github.py` and re-pair.

Snapshotting the VM covers everything; otherwise `pg_dump` per stack plus a
tar of the three paths above.

### Known failure modes and where the logs are

| Symptom | Likely cause | Look at |
|---|---|---|
| Browser gets 502 | oauth2-proxy down (bearer lanes keep working — independent path) | `docker logs orcha-auth-oauth2-proxy-1`; `docker compose … up -d oauth2-proxy` |
| Sign-in works, then 403 page | user not on the allowlist (not yet invited, or signed into the wrong GitHub account — an invite for `alice` does not admit `alice-work`) | `deploy/auth/.env` `ALLOWED_GITHUB_USERS`; `journalctl -u sync-members.service` |
| Phone gets 401 on everything | device token revoked, or its member removed | portal → device tokens; re-pair |
| Cert not issuing | port 80 blocked (HTTP-01 needs it) | host: `journalctl -u caddy`; container: `docker logs orcha-auth-caddy-1` |
| Agents never wake in a portal-created project | provisioner can't reach the portal (port mismatch, §4 step 10) or clone/mint failing (App not installed on the repo) | `journalctl -u provision-projects.service` — it warns and retries next tick |
| Wake fails instantly, "sandbox unavailable" | Docker down / runner image missing / disk < 5 GiB — the fail-loud contract, never a silent host fallback | portal run detail (the reason is stamped on the run); `docker info`; `orcha sandbox status` |
| Run killed, "out of memory" | container hit its memory cap | raise `sandbox.memory` in `<ws>/.claude/orcha.json` |
| Agent can't push / PR fails | stale or missing workspace token (timer stopped, or App not installed on that org) | `journalctl -u github-token-refresh.service`; `<ws>/.orcha/github-token` mtime |
| Notifier dead for one project | crashed; with `orcha-notifier@.service` installed, systemd restarts it (`RestartSec=10`) — without it, the provisioner re-ensures within 2 min — check why either way | systemd path: `journalctl -u orcha-notifier@<slug>.service`; nohup path: `<ws>/.claude/.orcha-notifier.log` (pidfile beside it) |
| Wakes die with exit 125 | sandbox network pinned wrong (cloned repo shipped its own compose file) | `sandbox.network` in `<ws>/.claude/orcha.json`; `PROVISION_NETWORK` on the provisioner unit |
| Box hangs / thrashes instead of degrading under an agent burst | no swap — the OOM path becomes disk-thrash-to-death rather than a graceful kill; provision it once (§3 step 22): `sh deploy/provision-swap.sh` (4GB default, `SIZE_GB` to override — sized against the sandbox concurrency cap's per-wake memory math, §2 Components: runner default 4g/2cpu, provisioner-set 1536m/1cpu per project) | `free -h` (swap row); `swapon --show` |
| GitHub sign-in 500s at `/oauth2/callback` right after a reboot | a stale OAuth `state` minted before the reboot (oauth2-proxy's session store reset) — cosmetic, just retry | start sign-in fresh from the domain root (`https://orcha.<yourdomain>`), not the old callback URL/tab |

### Soak / verification checks (run these after any upgrade)

- `pgrep -x claude` on the host is **empty** during a wake (exact match —
  the docker client's argv contains the string "claude", so don't string-grep).
- `docker ps` shows exactly one labeled `orcha-run-*` container per active
  run; `docker ps -a | grep orcha-run | wc -l` is not growing without bound
  (the exited-orphan sweep is a tracked follow-up — today the reaper stops
  but does not always remove).
- Kill a notifier mid-run, restart (or wait for the provisioner tick): the
  run completes, its log and exit status are stamped correctly.
- The four perimeter curls from §4 step 9.
- `/metrics` shows the runs you just exercised, with cost coverage labeled.

---

## 6. Security posture

### Enforced today

- **TLS everywhere public**; the portal never binds a public port (loopback
  rebind + the outside-only perimeter); box firewall 22/80/443.
- **Every browser request** passes GitHub OAuth plus an explicit username
  allowlist; **every phone request** carries a per-device revocable token
  validated per-request against a sha256 hash (raw token stored nowhere);
  tokens die with their member.
- **The break-glass team-token lane strips forged identity headers**, so it
  can never impersonate a member; identity headers on the other lanes are
  always overwritten by the validator, never client-supplied.
- **Roles + grants** (owner/member/viewer + six granular grants): keys and
  roster are gated, viewers are read-only absolutely, container lists are
  membership-filtered (project isolation), and no agent self-certifies —
  the human verification gate is unchanged from OSS Orcha.
- **Sandboxed wakes**: non-root (uid 1000), resource-capped, pids-limited,
  2-hour deadline, workspace-only filesystem, no docker socket, fail-loud
  with no silent host fallback, secrets via env passthrough (never argv, so
  never in `ps`).
- **GitHub credentials**: the App PEM never leaves the host; containers see
  only 1-hour repo-scoped tokens; mint tokens are scrubbed from git config
  after every clone; commits/PRs are attributed to the app bot with human PR
  review as the authority gate.

### Tracked gaps — real, known, not yet shipped

Copied honestly from the tracked follow-ups
(`docs/superpowers/plans/2026-07-29-remote-runner.md` §Tracked follow-ups);
none are silent — each is written down and owned:

- **Sandbox egress is open.** A wake container has ordinary outbound
  internet and can reach the stack's `db:5432` on the compose network. The
  egress allowlist (LLM API + git hosts) and a portal-only network split are
  follow-ups; a prominent caveat is **required before the OSS runner PR**.
- **Config fail-open.** A present-but-corrupt `.claude/orcha.json` currently
  yields sandbox-disabled — i.e., a silent host-mode wake. Loud-fail on
  corrupt (vs missing) config is **required before the OSS PR**.
- **iOS token storage.** The app keeps its tokens in `UserDefaults`, not the
  Keychain. Keychain migration is deferred, tracked.
- **Exited-orphan accretion.** Stopped/exited row-less containers are not
  yet swept by a `docker ps -a` pass; watch the count manually (§5).
- **Provider key visibility.** Keys ride container env — inspectable by the
  VM admin (which on BYOC is the customer themselves). tmpfs-file injection
  is a noted v2 hardening.
- **The team token is static and box-wide** with no identity; per-agent
  token enforcement is a later line of work. Rotation is manual (§5).
- **Codex conversation lane** is not sandbox-compatible yet (host-absolute
  paths, host `~/.codex` state) — Claude is the supported sandbox runtime
  for the resident lane today.
- **Sandbox api-config files accrete** (one `.orcha/sandbox/<name>.json` per
  wake) until the reaper learns to unlink them; and a host reboot mid-run
  can truncate a captured log (a `docker logs` fallback is tracked).

---

## 7. Roadmap pointer

Two things intentionally *not* in this guide because they don't exist yet:

- **The control plane** (sub-project 2, separate closed repo, not started) —
  team accounts, Stripe metering read straight off `worker_runs`, and a
  provisioner that drives everything in §3's manual column — DNS/TLS,
  App setup, secrets placement, Caddy config, timers, upgrades — against
  arbitrary customer VMs, not just our pool. The `deploy/` scripts in this
  repo are the manual v1 of exactly that automation, which is why this guide
  documents them so precisely: they are the spec.
- **The OSS runner PR** — the sandbox runner lands as a PR to
  `open-orcha/orcha` after the dogfood soak passes, with the two
  "required before OSS" items in §6 fixed first. Until then the runner ships
  only in this repo.

When those land, this guide's §3 matrix shrinks; its architecture (§2) does
not.
