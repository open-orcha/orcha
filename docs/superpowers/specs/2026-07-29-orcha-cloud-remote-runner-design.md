# Orcha Cloud — system map & remote runner design

**Date:** 2026-07-29
**Status:** approved design, pre-implementation
**Scope of this spec:** the overall Orcha Cloud system map (context for everything that
follows) and the full design of **sub-project 1: the remote runner**. Sub-projects 2–4
get their own specs when their turn comes.

## 1. Vision and product decisions

Orcha Cloud is a managed platform in the shape of Snap's Casper — task in, isolated
remote sandbox spins up, a durable agent loop runs off-laptop, a reviewable change
comes out — with Orcha's differentiator kept intact: the human stays authoritative
through plan approval and `needs_verification`, on the portal or the phone.

Decisions locked during design (each one shapes the architecture below):

| Decision | Choice |
|---|---|
| Business model | **Open core.** Self-hosted Orcha stays free and complete; Orcha Cloud is the paid managed tier. |
| First customer | **Small teams (5–50 devs).** Team workspaces, org billing, admin visibility. |
| Billable core | **Sandbox provisioning + runtime.** Customers pay for compute-hours of isolated agent runs plus a platform fee. |
| Substrate | **Rented VMs (Hetzner-class) + Docker.** One VM per team; one container per agent run. No sandbox-API vendor (E2B etc.) in the serving path; microVMs are a later migration if scale demands. |
| Model tokens | **BYO keys.** Teams bring provider keys (Orcha already stores per-provider keys encrypted). We never resell tokens in v1. |
| Tenancy | **Stack-per-team ("fleet of Orchas").** Each team gets its own Orcha stack (portal + Postgres) on its own VM. Cloud code = OSS code; the paid product is the layer that manages the fleet. |

## 2. System map

```
                    ┌─────────────────────────────────────────────┐
                    │   CONTROL PLANE  (closed-source, new repo)  │
                    │  accounts/teams · GitHub OAuth · Stripe     │
                    │  metered billing · VM pool · provisioner    │
                    │  auth proxy · TLS · *.orcha.cloud subdomains│
                    └───────────────┬─────────────────────────────┘
                                    │ provisions / upgrades / meters
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
┌─────────────────────┐   ┌─────────────────────┐
│  TEAM VM (acme)     │   │  TEAM VM (globex)   │     ... one VM per team
│  ┌───────────────┐  │   │      same shape     │     = exactly today's
│  │ Orcha stack   │  │   └─────────────────────┘       `orcha init` stack
│  │ portal + PG   │  │
│  └──────┬────────┘  │      Billing meter = sandbox-container runtime
│         │ wakes     │      (worker_runs.started_at/ended_at)
│  ┌──────▼────────┐  │
│  │ notifier +    │  │
│  │ sandbox       │  │
│  │ spawner       │  │
│  └──┬───┬───┬────┘  │
│   ┌─▼┐┌─▼┐┌─▼┐      │     ← one isolated sandbox container per
│   │s1││s2││s3│      │       agent run (the billable unit)
│   └──┘└──┘└──┘      │
└─────────────────────┘
          ▲
          │ HTTPS (auth proxy in front)
┌─────────┴────────────┐
│ web portal · iOS app │    ← iOS already pairs to remote URLs
│ (existing, reused)   │      (shipped: remoteBaseUrl + failover)
└──────────────────────┘
```

**Sub-projects, in dependency order:**

1. **Remote runner** (this spec; open-source, lands in `open-orcha/orcha`) — agent
   wakes execute inside per-run sandbox containers instead of host processes.
2. **Control plane** (closed-source) — team accounts (GitHub OAuth), Stripe metered
   billing on sandbox-hours, VM pool, remote provisioning (drives `orcha init` /
   `orcha update` on team VMs), auth proxy, TLS, subdomains.
3. **Cloud glue** — GitHub App (repo clone tokens, PR creation as a bot identity),
   phone pairing against cloud URLs, team invites.
4. **AI pre-review** — an automated review pass on the diff *before* the existing
   `needs_verification` human gate (the CodePal analog).

**The open-core boundary:** everything running *inside* a team VM is the open-source
project. Everything that manages the *fleet* of them is the paid product. Cloud and
OSS never fork: the cloud provisioner installs the same released `orcha-cli`.

## 3. Remote runner — design

### 3.1 The change in one sentence

Today the notifier daemon spawns `claude -p` / `codex exec` as a raw host process
(`notifier.py` builds `env = dict(os.environ)` + `Popen`); the runner makes that same
wake happen inside a disposable Docker container — no host secrets, capped resources,
survives daemon restarts, meterable per run.

### 3.2 Execution mode, not replacement

`wake_kind` today is `headless | tmux`. This adds **`sandbox`**, opt-in per workspace
(a setting in `.claude/orcha.json`, editable from the portal's container controls).

- Self-hosters: default stays `headless` — zero behavior change until they opt in.
  Opting in buys laptop users isolation (the agent can no longer read `~/.ssh`,
  browser profiles, or unrelated repos).
- Cloud team VMs: always `sandbox`; the provisioner sets it and the portal shows the
  mode read-only.

**Hard rule:** if Docker is unavailable, the image is missing, or the spawn fails,
the run **fails loudly with a visible reason. There is no fallback to a host
process.** De-sandboxing must never be an error path.

### 3.3 Components

**(a) Runner image — `orcha/runner`** (published to a registry, version-pinned to the
CLI release). Contents: Claude Code CLI, Codex CLI, git, ripgrep, node, python, uv.
One batteries-included image in v1; per-team custom images are explicitly out of
scope until a customer needs them.

**(b) Sandbox spawner — `orcha_cli/sandbox.py`** (new module; the notifier calls it
where it Popens today). Responsibilities, all as pure-as-possible functions:

- Build the `docker run -d` invocation:
  - **Workspace volume** per agent mounted at `/workspace` (cloud) or a bind-mount of
    the existing project dir (self-host). Repo checkout and build caches persist
    across wakes; the container is throwaway.
  - **Env**: `ORCHA_ALIAS`, `ORCHA_HEADLESS_WORKER=1`, the unsealed provider key
    (notifier already unseals), and the portal API base reachable over the compose
    network (`http://portal:8000`) — the runner container is always attached to
    the stack's compose network, in both cloud and self-host modes (the host's
    `localhost:8000` is not reachable from inside a container). The orcha skills
    already reach the API via curl/Bash, so the agent loop runs unmodified.
  - **Caps**: `--memory`, `--cpus`, `--pids-limit` (defaults: 4g / 2 / 512,
    overridable per workspace). Network: the compose network plus egress (LLM API,
    git). No docker socket. No host mounts beyond the workspace.
  - **Labels**: `orcha.run_id`, `orcha.agent`, `orcha.container_id` — the handle for
    adoption, reaping, and accounting.
- Poll/inspect running containers; map exit codes and `OOMKilled` to run status.

**(c) Durability + adoption.** Containers run detached. `worker_runs` gains a
`sandbox_container_id` column (new migration). On notifier restart, an adoption pass
scans live containers by label and re-attaches to their logs and lifecycle instead of
orphaning them — a daemon restart (or `orcha update`) no longer kills in-flight work.
On a VM this is the full Casper property: close the laptop, runs continue.

**(d) Log flow unchanged in shape.** The run's stream-json log is written inside the
container onto the workspace volume; `worker_runs.log_path` points at the same file
via the volume's host mountpoint, so the existing tailing, run feed, and portal run
detail work without modification.

**(e) Metering for free.** `worker_runs` already records `started_at` / `ended_at`.
Sandbox-mode rows *are* the billable record; the control plane later reads this table
per team. No new metering system is built.

### 3.4 One wake, end to end

portal decides an agent wakes → notifier picks it up (unchanged) → spawner
`docker run -d orcha/runner` with volume + env + caps + labels → agent loop runs
inside, curls the portal API, streams json log to the workspace volume → container
exits → notifier reaps by container id, stamps `worker_runs`, follow-up behavior
(retries, status recompute, notifications) proceeds exactly as today.

### 3.5 Failure modes

Every failure becomes a `worker_runs` status plus a human-readable reason surfaced in
the portal run detail — never silent:

| Failure | Behavior |
|---|---|
| Docker down / image pull fails | Run fails before start, reason visible. No host fallback. |
| OOM / CPU runaway | Docker kills; `OOMKilled` read from inspect → status `killed: out of memory` (raise caps, don't blame the agent). |
| Runaway run | Enforced max-runtime deadline (default 2h, per-workspace override); reaper `docker stop`s past-deadline containers. |
| Orphans | Reaper sweeps by `orcha.*` labels: live container with no open `worker_runs` row → stopped. **Workspace volumes are never auto-deleted.** |
| Portal restarts mid-run | Sandbox container unaffected; skills' API calls retry; run continues. |
| Disk pressure | Free-space watermark check before each spawn; per-team VM bounds the blast radius. |
| Key exposure | v1 passes the provider key via container env (inspectable only by the VM admin — us in cloud, the team itself in self-host). tmpfs-file injection is a noted v2 hardening, not a v1 blocker. |
| Double wakes | Existing single-flight guard (`002_wake_single_flight.sql`) applies unchanged. |

### 3.6 Testing

1. **Unit** — `sandbox.py` argv/env construction as pure functions (mirroring the
   notifier's existing spawn-repr tests); adoption logic against canned
   `docker inspect` payloads.
2. **Integration** (CI-able wherever Docker exists) — a stub "claude" script inside a
   real container emits stream-json; assert spawn → log tail → exit → reap →
   `worker_runs` stamps. The load-bearing case: **kill the notifier mid-run, restart
   it, assert the run is re-adopted and completes.**
3. **E2E dogfood** — one Hetzner box, a real workspace in sandbox mode, our own
   agents doing real work, supervised from the iOS app over the already-shipped
   remote path. We are customer zero.

### 3.7 Rollout

1. Runner lands as a PR to `open-orcha/orcha`, flag off by default — an OSS feature
   first, with community eyes on the isolation model before anyone is billed for it.
2. One Hetzner box runs our own team in sandbox mode for a week.
3. The control plane (sub-project 2, separate spec) builds against a substrate we
   have already lived on.

## 4. Out of scope for sub-project 1

- Accounts, auth proxy, billing, VM provisioning (sub-project 2).
- GitHub App / PR-bot identity (sub-project 3) — v1 sandbox uses whatever git
  credentials the workspace volume holds, same as a laptop workspace today.
- Custom per-team runner images; microVM isolation; tmpfs key injection (hardening
  backlog).
- AI pre-review (sub-project 4).

## 5. Success criteria

- A workspace flipped to `sandbox` mode runs real agent wakes end-to-end with **zero
  changes** to portal UI flows, mobile supervision, or skill behavior.
- `ps` on the host during a wake shows **no** `claude`/`codex` process; `docker ps`
  shows one labeled container per active run.
- Killing the notifier mid-run and restarting loses nothing: the run completes and
  its log and status are correct.
- A week of dogfood on a Hetzner box produces no de-sandboxing incident, no orphaned
  container older than the deadline, and no lost run.
