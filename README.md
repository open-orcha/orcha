# Orcha

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20753153.svg)](https://doi.org/10.5281/zenodo.20753153)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20740087.svg)](https://doi.org/10.5281/zenodo.20740087)
[![build](https://img.shields.io/github/actions/workflow/status/open-orcha/orcha/test.yml?branch=main&label=build)](https://github.com/open-orcha/orcha/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/github/license/open-orcha/orcha)](LICENSE)
[![Release](https://img.shields.io/github/v/release/open-orcha/orcha)](https://github.com/open-orcha/orcha/releases/latest)

**Human-authoritative multi-agent orchestration as Claude Code slash commands.**
Multiple Claude Code sessions collaborate on a high-level objective through a
shared SQLite database; the human holds standing authority (approve,
reprioritise, reassign, arbitrate) over every subtask.

> **Product name: Embodent** (formerly Quorate). The portal, desktop and mobile
> apps are branded Embodent; the `orcha` CLI command, the `ORCHA_*` env vars,
> API paths, the `orcha://` URL scheme and the `open-orcha/orcha` repo keep
> their names.

This repo is **the Orcha tool source** — the installable CLI, the per-project
backing service (FastAPI + SQLite), and the slash-command skill templates
that ship with it. End users don't read this repo; they install it once and run
`orcha init` in their own projects.

## Status (last updated 2026-08-26)

- **The hosted dogfood deployment (orcha.nursoftai.com) is decommissioned** —
  its DB and secrets were backed up offline; rebuilding it (or any new box) is
  fully documented in [`docs/deploy-new-box-runbook.md`](docs/deploy-new-box-runbook.md).
- **Local-first is the primary mode**: the free solo tier runs the complete
  cloud portal on a laptop — local git code source, PAT/`gh` GitHub access,
  Code Space (line threads, worktree Changes, file history, symbol index with
  background warmer), roster suggestions, Gold skin. See
  [`deploy/local/README.md`](deploy/local/README.md) and the desktop app.
- **Plan gating**: `ORCHA_PLAN` — `solo` (default, free) vs `team` (hosted/paid:
  members, invites, roles). Migration chain tip: **048** (wake circuit breaker).
- **Reliability**: no-progress wake circuit breaker (server-side, DB-backed,
  3/6/10-strike ladder) + the ported open-orcha directive-consumption fixes —
  see `docs/` and the 048 migration header for the incident that motivated them.
- **Metrics**: per-agent spend drilldown (in/out/cached tokens, per-task, $) and
  rule-based reduce-spending insights, including subscription-billed loop
  detection (runs with ~$0 recorded).

> **Deploying Orcha Cloud on your own VM (BYOC)?** Start with
> [`docs/byoc-guide.md`](docs/byoc-guide.md) — the complete guide: tiers,
> architecture, the automated-vs-manual matrix, the full setup walkthrough,
> operations, and the honest security posture.

---

## Tech stack

| Layer | Built with |
|---|---|
| **CLI** (`orcha`) | Python ≥ 3.10 |
| **Backing service / API** | FastAPI + Uvicorn (Python), Pydantic |
| **Database** | SQLite (Python's built-in `sqlite3`) — one file per project |
| **Runtime** | Host processes supervised by `orcha serve`, kept alive by launchd (macOS) / systemd (Linux) — no Docker |
| **Web dashboard** | React + TypeScript (Vite), with xterm.js for the live terminal |
| **Desktop app** (optional) | Electron + React 19 + TypeScript (Vite) |
| **macOS widget** (optional) | Swift (WidgetKit) |
| **Agent layer** | Claude Code slash-command skills |

---

## Installation

Orcha runs as ordinary background processes on your machine — **no Docker, no
Postgres.** Each project keeps all of its data in one file,
`<project>/.orcha/orcha.db`.

> Already have a project that runs in Docker? It keeps working; move it with
> `orcha migrate-runtime` — see
> [docs/legacy-docker-runtime.md](docs/legacy-docker-runtime.md).

### Prerequisites

| Tool | Why | Needed by |
|---|---|---|
| **Claude Code** (or **Codex**), signed in | the agents run in it | everyone |
| **git** | GitHub-backed projects and the Code view | optional |

That's it — the Mac app carries its own runtime, and `uv` brings its own
Python (≥ 3.10).

### Option 1 — the Mac app (recommended)

<!-- TODO(#258): the bundled runtime ships with the desktop sidecar (plan PR 16); until then the app installs the CLI with uv on first run (plan PR 14). -->

Download **Orcha.app** (macOS, Apple Silicon):

- **GitHub Releases** — latest `.dmg`:
  <https://github.com/open-orcha/orcha/releases/latest>
- The **Download** button on the Orcha website (same build)

Open it, pick a project folder, and sign in to Claude Code. The app is signed
and notarized, so macOS asks only once, on first open. It installs the `orcha`
command for you at `~/.local/bin/orcha`.

### Option 2 — the command line, with uv (macOS or Linux)

<!-- TODO(#258): needs `orcha-cli` published to PyPI (plan PR 13; owner question Q-H — who owns the PyPI name). -->

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh   # once, if you don't have uv
uv tool install orcha-cli
orcha --version
```

Upgrade later with `orcha update` inside a project (it updates the CLI, then
restarts Orcha on the new version).

### Option 3 — Homebrew (still supported)

```bash
brew install open-orcha/orcha/orcha
orcha --version
```

Upgrade with `brew upgrade orcha`. Downgrade via the frozen per-release
formulae (`brew install open-orcha/orcha/orcha@<version>`); details in the
[tap README](https://github.com/open-orcha/homebrew-orcha).

**From source** (for hacking on Orcha itself):

```bash
git clone git@github.com:open-orcha/orcha.git
cd orcha
uv tool install --editable ./orcha-cli   # or: pip install -e ./orcha-cli
orcha --version
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contributor loop.

### Add your Anthropic API key

Orcha's agents run on Claude, so they need an Anthropic API key. The lowest-lift
way to get going — and the one we recommend for onboarding and handoffs — is to
create a key, **load $20 of credit**, and drop it in your environment:

1. Go to [console.anthropic.com](https://console.anthropic.com/), create an API
   key, and add **$20** of credit under **Billing**.
2. Set it in your shell (add to `~/.zshrc` or `~/.bashrc` to make it stick):

   ```bash
   export ORCHA_LLM_API_KEY="sk-ant-..."   # or: ANTHROPIC_API_KEY
   ```

> **Trust me — $20 will go a long way, easily a couple of months** of normal
> use, **and it'll save you a ton of tokens.** You can top up later if you ever
> run low; there's no subscription to manage.

### First run

<!-- TODO(#258): `orcha init` defaulting to native + installing the login service lands in plan PR 10. Until then init defaults to Docker; `orcha init --runtime native` opts in (plan PR 6). -->

In any project you want to orchestrate:

```bash
cd ~/projects/your-project
orcha init --objective "Ship the thing" --as <YourName>
```

This starts Orcha for the project in the background, prints the portal address
(`http://localhost:<port>/`), installs a small login service so it keeps
running after you close the terminal and after a reboot, and registers you as
the first human. If anything looks wrong, `orcha doctor` tells you what.
See [How it works](#how-it-works-30-second-tour) below for the full tour.

---

## How it works (30-second tour)

1. You install a tiny CLI once: `orcha`.
2. In any project, `orcha init --objective "..." --as <YourName>` drops the
   slash-command skills into that project's `.claude/commands/`, starts the
   portal (REST API + web UI) on a free port as a background process,
   **creates the project's container**, and **registers you as the first
   human agent** (`kind='human'`) so escalations/verifications have a real
   target from day one — no manual `/orcha-container` follow-up needed.
3. Inside Claude Code (in that project), slash commands like
   `/orcha-register-agent Max ...`, `/orcha-status` appear automatically.
   Claude executes them by calling the local REST API. The portal at
   `http://localhost:<api_port>/` auto-loads your container — no ID to paste.
4. State (containers, agents, tasks, requests, audit events) lives in one
   SQLite file, `<project>/.orcha/orcha.db`.

**Project:db:container is 1:1:1.** Each `orcha init` produces one project
with one database file and one container — enforced by a unique
index. `POST /api/containers` returns 409 if one already exists; to start a
new container, run `orcha down -v && orcha init` (deletes the database file).

**Cross-folder usage.** Stacks are discoverable from anywhere on the
machine:

```
$ orcha ls
PROJECT                API                          DB     CONTAINER                    STATUS
todo-app               http://localhost:8001/       5433   Build a CLI todo app         active

$ cd ~/some/other/folder
$ orcha connect todo-app --as Priya   # registers Priya as a 2nd human
$ # /orcha-register-agent Dev ... from here now lands in todo-app's stack
```

`orcha connect <project>` writes `.claude/orcha.json` + skill templates into
the CWD pointing at the named project's API. No second runtime — this
folder is a client. Multiple Claude Code tabs `cd`'d into the same folder
share the same container scope via that `.claude/orcha.json`.

### Load-bearing invariants

- **The task graph SHOULD be a DAG.** Vertices are tasks; directed edges are
  `depends_on_id → task_id`. Readiness propagation, the verification gate, and
  parallel execution all assume acyclicity. *Currently only self-loops are
  blocked at the DB; transitive-cycle rejection was scoped out
  (see [closed open-orcha/orcha#4](https://github.com/open-orcha/orcha/issues/4))
  because humans are the only edge-builders by design and an accidental cycle
  produces a visible deadlock that's trivial to fix.*
- **Agent-to-agent communication is NOT required to be acyclic.** Two agents
  can ask each other questions in any order — back-and-forth dialog is
  expected. The task *relationship* graph is the only structure constrained.
- **Agents never create other agents.** All agents are created by a human.
  Existing agents may *suggest* a new agent be created (proposing alias, role,
  prompt, and rationale) when they hit work outside their role; the human
  decides whether to create it, reassign to an existing agent, or refuse.
  This makes agent count growth bounded by human attention, not exponential.
- **No agent self-certifies task completion.** `/orcha-done` flips a task to
  `needs_verification`; only a human (or human-delegated reviewer agent) flips
  it to `completed` via `/orcha-verify`. The load-bearing piece of Orcha's
  "human-authoritative" guarantee.
- **Humans are first-class agents** (`kind='human'`). They live in the same
  `agents` table as AI agents (`kind='ai'`), get an alias, and the API
  authorises authoritative actions — `/orcha-verify`, `/orcha-decide-suggestion`,
  `/orcha-pause`/`resume`/`stop`, `/orcha-sweep`, and accepting escalations —
  by `kind='human'` (returns 403 otherwise). The first human is registered
  automatically by `orcha init --as <name>`; add more with
  `/orcha-register-human`. Escalations target a specific human row, not a
  `NULL` target — see the `_pick_human()` resolver in the portal API.

---

## Status

**Shipped today** — containers, agents (AI + human), the work loop, the
verification gate, container lifecycle, the agent-to-agent **info + task**
request bus (Phase 3), server-sent-event push (`/wait` + SSE), the **Epic A
wake daemon** (`orcha notifier` wakes idle agents out-of-band), and **Epic C**
per-agent continuity (`orcha rehydrate`/`snapshot`, `/orcha-snapshot`). See
"What's next" below for the remaining roadmap (portal write-actions, tighter
guardrails, remote).

Lifecycle (host shell):
- `orcha init [--objective "..." --as <YourName>]` — bootstrap a project with
  the native runtime + skills, create the container, register the first human
- `orcha up` / `orcha down [-v]` / `orcha status` / `orcha logs` / `orcha doctor` — runtime lifecycle (see [Lifecycle](#lifecycle))
- `orcha migrate` — apply any pending `migrations/*.sql` to the live DB now,
  without a wipe (the portal also runs them on startup, so `orcha up` migrates
  automatically; use this for an explicit on-demand apply)
- `orcha upgrade` — re-render an existing project to the installed CLI's
  templates (compose + portal + migrations + skills, rebuild portal) **without**
  a data wipe. Use after a CLI reinstall so an existing project picks up new
  portal code + compose; then `orcha up` migrates the live volume
- `orcha ls` — list every Orcha project on this machine (native and, if
  `docker` is installed, legacy Docker ones) with its container
- `orcha connect <project-name> [--as <YourName>]` — point THIS folder at an
  existing running stack so `/orcha-* ` skills here target that stack's
  container. Optionally register an additional human in one step
- `orcha pause/resume/stop [<container_id>]` — flip the Orcha *container* (project/milestone) status
- `orcha watch [--detach] [--interval N]` — per-session background poller
  that surfaces inbox + answered-outbox items to the bound AI agent (Orcha#33).
  Spawned by the SessionStart hook; queues new items into
  `.claude/.orcha-watch-state-<alias>.json`. Default cadence 10s.
- `orcha unwatch` — SessionEnd partner; SIGTERMs the watcher.
- `orcha poll-inbox` — PostToolUse hook entry. Drains the watcher's queue
  into Claude's next-turn context (cheap file read, no API call).
- `orcha enable-hook` — idempotently registers all the session hooks in THIS
  folder's `.claude/settings.json`. For folders that pre-date Orcha#33
- `orcha notifier [--once|--ensure|--dry-run] [--interval N]` — **Epic A wake
  daemon**. Wakes IDLE agents out-of-band (tmux `send-keys`, or `claude -p` for
  headless workers) when they have pending events or an assigned ready task, so
  they resume without a human nudge. `--ensure` starts a detached singleton
  (used by `orcha init`/`up` + the SessionStart hook); `--once` is the cron
  stopgap; `--dry-run` prints wake decisions without sending anything. A
  single-flight wake lease (`--lease-ttl`, default 1200s) prevents double-spawn;
  a stalled worker is killed only after `--stall-secs` (default 120s) with no
  log growth. NON-AI; never self-certifies.
- `orcha reachability` — **Epic A** SessionStart hook: record this session's
  bound-agent reachability (headless cwd + tmux pane) so the notifier can wake
  it. Silent no-op outside an Orcha project.
- `orcha rehydrate` — **Epic C** SessionStart brief: rebind the alias and print
  a "where we left off" summary (tasks + inbox/outbox + memory digest) into
  Claude's context. Runs alongside `orcha watch`.
- `orcha snapshot` — **Epic C / C1** SessionEnd hook: a woken headless worker
  (`ORCHA_HEADLESS_WORKER=1`) writes a continuity digest before exiting.
  No-op for interactive tabs (they author via `/orcha-snapshot`).
- `orcha use <alias>` — print `export ORCHA_ALIAS=<alias>` for `eval` into your
  shell (ssh-agent idiom: `eval "$(orcha use Vault)"`), so `/orcha-*` skills in
  that shell resolve to that agent without `--alias`.

### ⚠️ Destructive commands — wiping a project's data

**This erases the project's data (agents, tasks, runs, threads). NEVER run it in
a project whose state you want to keep** (e.g., a live multi-agent workspace) —
there is no undo unless you made a backup with `orcha backup`.

- **`orcha down -v`** — stops Orcha **and deletes `.orcha/orcha.db`** (plus its
  `-wal`/`-shm` side files) after a `y/N` prompt; scripts must pass `--yes`.
  (`orcha down` without `-v` keeps the file; data survives a plain `orcha up`.)
- **`orcha init --force`** does **NOT** wipe data. It only rewrites `.orcha/`
  config and `.claude/` skills; the existing `orcha.db` is reused.
  <!-- TODO(#258): confirm whether `orcha init --force --reset-data` survives on the native runtime. -->

**Tip:** to test a *first-run / empty* experience, don't wipe an existing project —
just `orcha init` in a **brand-new empty directory**, and `orcha down -v` that
throwaway dir when finished.

Projects still on the Docker runtime: see
[docs/legacy-docker-runtime.md](docs/legacy-docker-runtime.md#️-wiping-a-docker-projects-data).

Slash skills in Claude Code (after `orcha init`):

| Skill | For | What it does |
|---|---|---|
| `/orcha-container` | human | create container + root task (rarely needed — `orcha init` does this for you) |
| `/orcha-register-agent` | human | register an AI agent (`kind='ai'`) — optionally with `--initial-task` so it starts working immediately |
| `/orcha-register-human` | human | register an additional human (`kind='human'`) mid-run; the first human comes in via `orcha init --as <name>` |
| `/orcha-status` | both | snapshot of the project |
| `/orcha-task-new` | both | create a new task (optionally `--assign <alias>`, optionally `--depends-on ...`) |
| `/orcha-next` | agent | atomically claim the highest-priority ready task |
| `/orcha-post` | agent | append to a task's collaboration thread |
| `/orcha-done` | agent | mark a task `needs_verification` (NOT completed) |
| `/orcha-verify` | human | approve → `completed` (may unblock deps), or reject with feedback → `in_progress` |
| `/orcha-inbox` | agent | two-section: incoming open requests + my asks now answered |
| `/orcha-outbox` | agent | full audit of my outgoing requests (any status) |
| `/orcha-ask` | agent | ask another agent for info OR work — `--task --task-dod "..."` makes it a Phase-3 task request; `--in-service-of <parent_rid>` chains |
| `/orcha-respond` | agent | answer an info request addressed to me |
| `/orcha-close` | agent | close an answered request when satisfied |
| `/orcha-escalate` | agent | push a stuck/poorly-answered request to a human (target is the human's agent row, picked by `_pick_human()`) |
| `/orcha-convert` | agent | turn an answered-but-insufficient info request into a real task (optional `--assign <alias>`) |
| `/orcha-accept-task` | agent | accept a task request — spawns + claims the task |
| `/orcha-reject-task` | agent | reject a task request with `--reason "..."` |
| `/orcha-suggest-agent` | agent | propose to the human that a new agent be created (`--proposed-alias --proposed-role --proposed-prompt --rationale`). Agents NEVER spawn themselves. |
| `/orcha-decide-suggestion` | human | resolve an agent suggestion: `--create` / `--reassign <alias>` / `--refuse` |
| `/orcha-listen` | agent | wait (long-poll) for the next server-pushed event — ~zero LLM cost per quiet minute. Pair with `/loop` for the autonomous turn protocol. |
| `/orcha-checkpoint` | agent | one-shot inbox + outbox poll (legacy; `/orcha-listen` is cheaper) |
| `/orcha-snapshot` | agent | snapshot my memory digest (focus/decisions/learnings/open-threads) to the DB so a future re-binding tab can rehydrate (Epic C) |
| `/orcha-sweep` | human | escalate any open requests past their `expires_at` |
| `/orcha-pause` / `/orcha-resume` | human | flip container status |
| `/orcha-stop` | human | mark container `completed` (or `--cancel`) |

Each work or request skill bumps `agents.last_heartbeat_at` and
`agents.turns_used` so the portal shows live activity. Tab→agent binding is
automatic on `/orcha-register-agent` via a per-tty file under
`.claude/orcha-tabs/`.

### Agent status auto-flip

`agents.status` is now derived from current activity (not set ad-hoc):

| Has any open outgoing request? | Has any in-progress assigned task? | → status |
|---|---|---|
| yes | (either) | `awaiting_request` |
| no | yes | `working` |
| no | no | `idle` |
| (any) | (any) | `terminated` is never auto-revived |

Every endpoint that changes an agent's task assignment or outgoing requests
re-runs the rule. So as soon as Bob answers Sam's question, Sam auto-flips
from `awaiting_request` back to `working` (if Sam still has a task) or `idle`.
Snapshots include a `waiting_on` array per agent: `{request_id, target_alias,
payload_preview, chain_depth, created_at, expires_at}` — surfaced by
`/orcha-status` as `→ Bob: "auth scheme?" (depth=0, asked 3m ago)` under the
agent line.

### Autonomous polling (Orcha#3)

The original protocol — agent only acts when a human types a slash command —
left agents idle while requests piled up. Now:

```bash
# inside the agent's Claude Code session, after /orcha-register-agent <alias>:
/loop /orcha-listen --alias <alias>                # recommended — long-poll, ~zero LLM cost while idle
```

`/orcha-listen` is the default loop primitive — see the "Server-sent events"
section below. `/orcha-checkpoint` (fixed-interval polling) is a **legacy
fallback** for when the server doesn't support `/wait`, or for an explicit
one-shot status check:

```bash
/loop /orcha-checkpoint --alias <alias>            # self-paced
# or fixed cadence:
/loop 30 /orcha-checkpoint --alias <alias> --auto-close
```

`/orcha-checkpoint` is one iteration: fetches inbox + answered-outgoing, optionally
auto-answers anything it can confidently synthesize, auto-closes answered outgoing
when `--auto-close` is set, and reports the suggested next interval based on the
agent's current status:

- `idle`     → next check in `--idle-interval N` seconds (default **10**, or `$ORCHA_IDLE_INTERVAL`)
- `working` / `awaiting_*` → next check in `--working-interval N` seconds (default **30**, or `$ORCHA_WORKING_INTERVAL`)
- `terminated` / `blocked` → no further polling; human intervention needed

Self-paced `/loop` (no interval arg) reads the "next check" hint and adapts each
iteration. Tighter idle polling catches fresh incoming work fast; looser working
polling avoids interrupting tasks.

#### Background watcher + PostToolUse drain (Orcha#33)

The `/loop /orcha-listen` and `/loop /orcha-checkpoint` patterns work great when the
agent has yielded back to Claude Code, but a deeply working agent (mid-`/orcha-next`
→ code → `/orcha-done`) can go minutes without checking the inbox — and
`/loop` itself sometimes drifts. To close that gap, `orcha init` and
`orcha connect` register three hooks in `.claude/settings.json`:

```jsonc
// .claude/settings.json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "orcha watch --detach" }] }],
    "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "orcha unwatch" }] }],
    "PostToolUse":  [{ "matcher": "*",
                       "hooks": [{ "type": "command", "command": "orcha poll-inbox" }] }]
  }
}
```

**`orcha watch`** is a per-session background daemon (spawned by SessionStart,
killed by SessionEnd). It resolves the acting agent via the 4-step pattern,
forks into the background via `--detach`, and polls
`/api/agents/<aid>/inbox` + `/api/agents/<aid>/outbox?status=answered` every
`--interval` seconds (default 10s). Any item whose request id isn't in
`seen_ids` is added to a queue in
`.claude/.orcha-watch-state-<alias>.json`. The watcher tracks its parent
Claude process and exits cleanly if Claude dies; `orcha unwatch` SIGTERMs it
on SessionEnd. Humans (`kind='human'`) are a silent no-op — no automated nag.

**`orcha poll-inbox`** is now a cheap file read, not an API call. On every
tool-call boundary it drains the watcher's queue, prints any pending items
(both incoming asks and answers to outgoing asks the agent hasn't closed
yet), and clears the queue atomically. Working agents see the work in their
next turn's context without paying for a polling turn.

Item rendering:
```
[orcha] 🔔 4 new items for Sam (from background watcher):
  ← info b1da70b9 from Max (p=50): "what API base path for /v2?"
  ← info 7a7e8945 from Max (p=50): "INBOX item"
  → answer to your ask 04b37443 (Max): "Yes — at schema/v2.sql in main."
  → answer to your ask 01b736da (Max): "answer to your outgoing"
Handle at the next step boundary: `/orcha-inbox --alias Sam` for full thread,
or `/orcha-outbox --alias Sam` for answered asks.
```

Every failure mode is a silent no-op so the hooks never break an unrelated
Claude session. Existing folders opt in with `orcha enable-hook`. This
aligns with the design doc §1 principle #2 — interruption is cooperative
at step boundaries — by making every tool-call boundary an implicit step
boundary that drains a queue populated on a reliable 10s server-side cadence.

**What the checkpoint will NOT do**:
- Invent answers when the response isn't derivable from context
- Auto-close without `--auto-close` (the requester decides satisfaction)
- Create new tasks, new agents, or escalate. The verification gate, agent creation,
  and approve/reject still belong to the human.

### Info request lifecycle

```
   /orcha-ask              /orcha-respond            /orcha-close
       │                        │                         │
       ▼                        ▼                         ▼
   ┌──────┐    (target)    ┌────────┐  (requester)   ┌────────┐
   │ open │ ─────────────▶ │answered│ ──────────────▶│ closed │
   └──────┘                └────────┘                 └────────┘
       │                                                     │
       │ (no answer or                                       │
       │  poor answer)                                       │
       │       ┌──────────────────────────────────────┐      │
       └──────▶│ target_id ◀── _pick_human()           │◀─────┘
               │ (re-targeted at the human's row)     │
               └──────────────────────────────────────┘
                          ▲
                          │
                  /orcha-escalate
                  /orcha-sweep (auto, when expires_at < now)
```

### Request chains (Orcha#1)

When answering an incoming request requires asking somebody else first, pass
`--in-service-of <parent_rid>` to `/orcha-ask`:

```
   Max ─── P ──▶ Dev        (Max asks Dev a question)
                  │
                  │ Dev doesn't know without asking Max something else
                  ▼
   Max ◀─── C ─── Dev        (/orcha-ask --in-service-of <P>;
   (target)       (requester)  C.parent_request_id = P, C.chain_depth = 1)
        │
        │ Max answers C
        ▼
   "C is answered" surfaces in Dev's /orcha-inbox as ★ "unblocks P"
   (because C.parent = P AND Dev is the target of P)
        │
        ▼
   Dev now answers P using info from C       → Max closes P
```

Cycles in `parent_request_id` are structurally impossible: parent is set at
insert and immutable, and the new request has no children yet — so a single
insert can never close a loop. Chain depth is exposed in the snapshot so a
human can see if a chain is going pathologically deep.

**Phase 3 (shipped)** — task requests (`/orcha-ask --task ...`),
accept/reject with negotiation, and a **human-mediated agent-suggestion path**
— when an agent encounters work outside its role, it can ask the human to
create a new agent (with a proposed alias / role / prompt and a rationale);
the human decides whether to create, reassign to an existing agent, or refuse.
**Agents never auto-spawn other agents.**

### Server-sent events (replaces poll-based checkpoints)

To cut the LLM cost of `/loop /orcha-checkpoint` polling (every iteration was
a full Claude turn), the portal now exposes push:

- **`GET /api/agents/{aid}/wait?since_ts=<epoch>&timeout=<s>`** — long-poll. Blocks
  until an event lands or the timeout elapses (max 120s). The new `/orcha-listen`
  skill wraps this; pair with `/loop` for the cheapest autonomous polling.
- **`GET /api/agents/{aid}/events`** — Server-Sent Events stream. For dashboards
  and any client that can hold a long-lived HTTP connection.
- **`GET /api/containers/{cid}/events`** — container-wide SSE for escalations,
  agent suggestions, task readiness changes.

Every state-changing API call (`/respond`, `/close`, `/escalate`, `/sweep`,
`/accept-task`, `/reject-task`, `/suggest-agent`, `/decide-suggestion`, `/verify`,
task creation with assignee) publishes a typed event onto the in-process bus.
Event shape: `{event: "<name>", ts: <epoch>, ...payload}`.

`/orcha-checkpoint` is still available for explicit one-shot status checks.
Don't put it in a tight loop anymore — `/orcha-listen` is strictly cheaper.

---


## Use Orcha in a project (the user flow)

```bash
cd ~/projects/your-project
orcha init                            # writes .orcha/ + .claude/commands/, starts Orcha in the background
# (picks a free port automatically: api=8000+)

# Set the workspace objective up front (recommended) — it becomes the container's name:
orcha init --objective "Build the thing"
# Without --objective it defaults to the project directory name (rename later via the API/portal).
# Add --as <YourName> to set the operator in one shot (else it uses your $USER).

# Now open Claude Code in this directory:
claude

# Inside Claude Code:
/orcha-container "Build a news app"
# → creates container + root task, writes current_container_id to .claude/orcha.json

/orcha-register-agent Max --role "product/research" --prompt "You are Max. ..." \
   --initial-task "Define MVP feature set" \
   --task-dod "List of 5 launch features with rationale"
# → registers Max AND creates+claims a task for him. Max can start working immediately.

# Open a SECOND terminal tab, cd to the same project, launch Claude Code again:
cd ~/projects/your-project && claude
/orcha-register-agent Kedar --role "architect" --prompt "You are Kedar. ..." \
   --initial-task "Sketch system architecture" \
   --task-dod "1-pager diagram + component list"
# → Kedar joins the SAME container automatically (.claude/orcha.json shared by tabs)

# As either tab makes progress:
/orcha-post <task_id> "Made decision X because Y"     # append to thread
/orcha-done <task_id> "Result summary or link"        # mark needs_verification

# Human (any tab) verifies completion:
/orcha-verify <task_id>                               # approve → completed
/orcha-verify <task_id> --reject "missing piece X"    # reject → in_progress

# Inspect at any time:
/orcha-status

# Close out:
/orcha-stop                  # mark container completed
/orcha-pause / /orcha-resume # mid-flight pause
```

Open `http://localhost:<api_port>/` (the port `orcha init` printed) — the
portal loads your container automatically.

### Files Orcha drops into your project

```
your-project/
├── .orcha/
│   ├── orcha.db                         # the whole project's data (SQLite; back up with `orcha backup`)
│   ├── .env                             # secret key + local settings (DO NOT commit)
│   ├── logs/                            # portal / notifier / bridge / serve logs (5 × 10 MB each)
│   └── state.json                       # what `orcha serve` is running right now
└── .claude/
    ├── commands/                        # all /orcha-* slash command skills (commit these)
    │   ├── orcha-container.md
    │   ├── orcha-register-agent.md
    │   ├── orcha-status.md
    │   └── …                            # see the skill table above
    ├── settings.json                    # SessionStart/SessionEnd/PostToolUse hooks (orcha enable-hook)
    ├── orcha.json                       # project-shared: api_base_url, ports, runtime, current_container_id
    └── orcha-tabs/                      # per-tab agent binding (DO NOT commit — per-developer)
        └── <tty>.json                   # {alias, agent_id, container_id}
```

The portal code itself is not copied into your project — `orcha serve` runs
it straight from the installed CLI, so updating the CLI updates every project.

`.claude/commands/`, `.claude/settings.json` and `.claude/orcha.json` are safe
to commit. Keep `.orcha/` and `.claude/orcha-tabs/` out of git: they hold your
data, secrets and per-terminal state.

<!-- TODO(#258): confirmed by the orcha serve author (plan PR 6): up, down, down -v, status, logs, ls, serve. Still unconfirmed: doctor (R4), backup/restore (S7), service + --no-service (plan PR 10), migrate-runtime (plan PR 8). -->
### Lifecycle

Two distinct concepts share the word "container," so the verbs are split:

**Runtime lifecycle** (the portal, the wake daemon and the terminal bridge —
plain background processes supervised by `orcha serve`):

```bash
# from the project's directory:
orcha up                  # make sure Orcha is running for this project
orcha down                # stop it, KEEP the data (.orcha/orcha.db stays)
orcha status              # runtime, ports, and each process's health
orcha logs [-f] [-n N] [portal|notifier|bridge|serve]   # last 50 lines of each log in .orcha/logs/; -f follows
orcha doctor              # one-screen health check — paste it into bug reports
orcha backup              # snapshot .orcha/orcha.db (safe while running)
orcha restore <file>      # put a backup back (stop with `orcha down` first)

# from anywhere (no cd required):
orcha ls                  # list every Orcha project on this machine, with ports
```

`orcha init` also installs a small **login service** (a launchd user agent on
macOS, label `io.openorcha.<project>`; a systemd user unit
`orcha-<project>` on Linux) so Orcha keeps running after you close the
terminal and comes back after a reboot. Manage it with
`orcha service install|uninstall|status`; skip it at init with
`--no-service`. On Linux, run `loginctl enable-linger $USER` once if you want
it to keep running while you're logged out.

Projects created before the no-Docker release still run in Docker until you
move them with `orcha migrate-runtime` — see
[docs/legacy-docker-runtime.md](docs/legacy-docker-runtime.md).

**Orcha container lifecycle** (the project/milestone entity in the DB — operate on the current project's API):

```bash
orcha pause [container_id]            # flip Orcha container status to 'paused'
orcha resume [container_id]           # flip back to 'active'
orcha stop  [container_id]            # mark 'completed' (or --cancel for 'cancelled')
                                      # NOTE: does NOT stop the runtime — use `orcha down`.
```

If `container_id` is omitted, the CLI reads `current_container_id` from `.claude/orcha.json` in your CWD — same fallback the slash skills use. So inside your project dir, plain `orcha pause` does what you'd expect.

These mirror the `/orcha-pause`, `/orcha-resume`, `/orcha-stop` slash skills — same API call under the hood. The host CLI is useful when you want to script lifecycle events from a shell loop or cron without launching Claude Code.

---

## Source repo layout (for contributors)

```
orcha/                                   # this repo
├── orcha-cli/                           # the installable Python package
│   ├── pyproject.toml
│   └── orcha_cli/
│       ├── __init__.py
│       ├── __main__.py                  # the `orcha` CLI
│       └── templates/                   # rendered into a user's project by `orcha init`
│           ├── portal/{main.py, portal_backend/, static/}   # run in place by `orcha serve` (no per-project copy)
│           ├── migrations/              # schema migrations
│           ├── docker-compose.yml.j2    # legacy Docker runtime only (one release)
│           └── skills/                  # all orcha-*.md slash-command templates
└── README.md                            # you are here
```

Iteration loop: see [CONTRIBUTING.md](./CONTRIBUTING.md) — local install from
a clone, the uv wheel-cache footgun, and the release runbook all live there.

---


## Troubleshooting cheatsheet

<!-- TODO(#258): `orcha doctor` (R4) and `orcha service` (plan PR 10) are not built yet; the other commands below are confirmed. -->
| Symptom | Cause | Fix |
|---|---|---|
| Anything odd, and you want to file a bug | — | run `orcha doctor` and paste its output into the issue |
| `orcha init` says "no free port in range" | host ports 8000..8099 all in use | `--api-port` to pick explicitly |
| Agents stop waking after you close the terminal | the login service isn't installed | `orcha service install` (or re-run `orcha up`) |
| A project still runs in Docker | it was created before the switch | see [docs/legacy-docker-runtime.md](docs/legacy-docker-runtime.md) |
| Skill prints "Orcha isn't initialized" | no `.claude/orcha.json` in CWD | run `orcha init` in this project root |
| `/orcha-register-agent` says "Run /orcha-container first" | no `current_container_id` in `.claude/orcha.json` | run `/orcha-container "..."` once |
| `/orcha-next` / `/orcha-done` says "tab isn't bound to an agent" | no `.claude/orcha-tabs/<tty>.json` in this terminal | re-run `/orcha-register-agent` in this tab |
| `/orcha-done` returns 409 "task is 'ready', not 'in_progress'" | task hasn't been claimed yet | `/orcha-next` first, or only `done` your own claimed task |
| `/orcha-verify` returns 409 "task is 'in_progress', not 'needs_verification'" | task hasn't been marked done yet | wait for `/orcha-done` from the assignee |
| Portal returns 404 on a UUID | DB was reset, container id is stale | `/orcha-container` to make a new one |
| Portal page won't load | the portal process stopped or is restarting | `orcha status`; `orcha logs portal`; `orcha up` |
| Templates edited in source repo not picked up by `orcha init` | **uv caches the built wheel by version** — `--force` alone doesn't rebuild | See [CONTRIBUTING.md](./CONTRIBUTING.md) ("uv wheel-cache footgun"), then `rm -rf .orcha .claude && orcha init` in the target project. |
| Agent hallucinated an endpoint that doesn't exist | skill briefing didn't enumerate capabilities clearly | tell the agent which Phase the system is at; the register-agent briefing now lists "NOT IN PHASE 1" — direct the agent back to it |


---

## Citing Orcha

If you use Orcha in your research or build on it, please cite the archived
release. Each version is permanently archived on Zenodo with its own DOI:

> Kedar Haldankar. *Orcha: Human-authoritative multi-agent orchestration.*
> Zenodo, 2026. https://doi.org/10.5281/zenodo.20740087

BibTeX:

```bibtex
@software{haldankar_orcha_2026,
  author    = {Haldankar, Kedar},
  title     = {Orcha: Human-authoritative multi-agent orchestration},
  year      = {2026},
  publisher = {Zenodo},
  doi       = {10.5281/zenodo.20740087},
  url       = {https://doi.org/10.5281/zenodo.20740087}
}
```

The DOI above resolves to the latest release. To cite a specific version, use
that version's DOI from the [Zenodo record](https://doi.org/10.5281/zenodo.20740087).

---

## Contributing

If you hit a setup issue not in the cheatsheet, please open an issue with:

- macOS version + chip (Intel / Apple Silicon)
- `orcha doctor` output from the project where things broke
