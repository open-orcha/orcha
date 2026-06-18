# Orcha

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20753153.svg)](https://doi.org/10.5281/zenodo.20753153)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20740087.svg)](https://doi.org/10.5281/zenodo.20740087)

**Human-authoritative multi-agent orchestration as Claude Code slash commands.**
Multiple Claude Code sessions collaborate on a high-level objective through a
shared Postgres database; the human holds standing authority (approve,
reprioritise, reassign, arbitrate) over every subtask.

This repo is **the Orcha tool source** — the installable CLI, the per-project
backing service (FastAPI + Postgres), and the slash-command skill templates
that ship with it. End users don't read this repo; they install it once and run
`orcha init` in their own projects.

---

## Tech stack

| Layer | Built with |
|---|---|
| **CLI** (`orcha`) | Python ≥ 3.10 |
| **Backing service / API** | FastAPI + Uvicorn (Python), Pydantic |
| **Database** | PostgreSQL 16 |
| **Runtime** | Docker + Docker Compose — one isolated stack per project |
| **Web dashboard** | Vanilla HTML / CSS / JS, with xterm.js for the live terminal |
| **Desktop app** (optional) | Electron + React 19 + TypeScript (Vite) |
| **macOS widget** (optional) | Swift (WidgetKit) |
| **Agent layer** | Claude Code slash-command skills |

---

## Installation

> **Docker is required.** Orcha runs its Postgres database and web portal as
> containers, so install and start a container runtime first —
> [Docker Desktop](https://www.docker.com/products/docker-desktop/),
> [OrbStack](https://orbstack.dev/), or [Colima](https://github.com/abiosoft/colima)
> all work.

### Prerequisites

| Tool | Why | Needed by |
|---|---|---|
| **Docker** (Desktop / OrbStack / Colima) | runs Postgres + the portal | everyone |
| **Python ≥ 3.10** | runs the `orcha` CLI | everyone |
| **Claude Code** | where the slash commands run | everyone |
| **Node.js + npm** | builds the desktop app | optional desktop app only |
| **Xcode** | builds the macOS widget | optional widget only |

### Install the CLI

**Homebrew** (recommended) — installs the `orcha` command-line tool.

One-line install (Homebrew taps the repo for you automatically):

```bash
brew install open-orcha/orcha/orcha
orcha --version
```

Or tap first, then install with the short name — handy if you'll be running
other `orcha` formula commands later:

```bash
brew tap open-orcha/orcha
brew install orcha
orcha --version
```

This installs **only the CLI**. Orcha's web portal isn't a separate download —
it starts automatically as a Docker container the first time you run
`orcha init` in a project (see [First run](#first-run) below).

**From source** (for hacking on Orcha itself):

```bash
git clone git@github.com:open-orcha/orcha.git
cd orcha
pip install ./orcha-cli
orcha --version
```

### Mac desktop app (optional)

Most people don't need this — the CLI plus the web portal cover the whole
workflow. The desktop app is **not** installed through Homebrew (there's no
cask); if you want the native Mac app, download it directly:

- **GitHub Releases** — latest `.dmg` / `.zip`:
  <https://github.com/open-orcha/orcha/releases/latest>
- The **Download** button on the Orcha website (same build)

The current Mac build is unsigned, so on first launch right-click the app →
**Open** to get past macOS Gatekeeper. To build it from source instead:

```bash
cd desktop
npm install
npm run dev      # or: npm run build
```

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

In any project you want to orchestrate:

```bash
orcha init --objective "Ship the thing" --as <YourName>
```

This brings up the project's Docker stack and registers you as the first human.
See [How it works](#how-it-works-30-second-tour) below for the full tour.

---

## How it works (30-second tour)

1. You install a tiny CLI once: `orcha`.
2. In any project, `orcha init --objective "..." --as <YourName>` drops a
   docker-compose + slash-command skills into that project's `.orcha/` and
   `.claude/commands/`, brings up a per-project Postgres + REST API on free
   ports, **creates the project's container**, and **registers you as the first
   human agent** (`kind='human'`) so escalations/verifications have a real
   target from day one — no manual `/orcha-container` follow-up needed.
3. Inside Claude Code (in that project), slash commands like
   `/orcha-register-agent Max ...`, `/orcha-status` appear automatically.
   Claude executes them by calling the local REST API. The portal at
   `http://localhost:<api_port>/` auto-loads your container — no ID to paste.
4. State (containers, agents, tasks, requests, audit events) lives in the
   project's Postgres; a read-only HTML dashboard is at `http://localhost:<api_port>/`.

**Stack:db:container is 1:1:1.** Each `orcha init` produces one Docker
Compose stack with one Postgres and one container — enforced by a unique
index. `POST /api/containers` returns 409 if one already exists; to start a
new container, run `orcha down -v && orcha init` (wipes the volume).

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
the CWD pointing at the named stack's API. No second Docker stack — this
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
  Docker stack + skills, create the container, register the first human
- `orcha up` / `orcha down [-v]` / `orcha status` — Docker stack lifecycle
- `orcha migrate` — apply any pending `migrations/*.sql` to the live DB now,
  without a wipe (the portal also runs them on startup, so `orcha up` migrates
  automatically; use this for an explicit on-demand apply)
- `orcha upgrade` — re-render an existing project to the installed CLI's
  templates (compose + portal + migrations + skills, rebuild portal) **without**
  a data wipe. Use after a CLI reinstall so an existing project picks up new
  portal code + compose; then `orcha up` migrates the live volume
- `orcha ls` — list all running orcha Docker stacks (with each stack's single
  container) across the machine
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

**These erase the project's Postgres data (agents, tasks, runs, threads). NEVER run
them in a project whose state you want to keep** (e.g., a live multi-agent workspace) —
there is no undo.

- **`orcha down -v`** — stops the stack **and drops the `pgdata` volume** → full DB wipe.
  (`orcha down` without `-v` keeps the volume; data survives a plain `up` again.)
- **`orcha init --force`** does **NOT** wipe data. It only overwrites `.orcha/` config +
  recreates the container; it **reuses the existing `pgdata` volume**, so the old DB
  (agents, tasks) **survives**. To truly start fresh you must drop the **volume**.
- **`orcha init --force --reset-data`** **DOES** wipe: it drops this project's Postgres
  volume before starting so the DB comes up empty (the one in-place way to get a
  genuinely pristine re-init without the manual `docker volume rm` dance below).

**Reliable full reset of the *current* project** (only when you really mean it):
```bash
orcha down -v                                  # stop stack + drop the pgdata volume
docker volume ls | grep "$(basename "$PWD")"   # CONFIRM the pgdata volume is gone…
docker volume rm orcha-<project-name>_pgdata   # …if it's still listed, force-remove it
orcha up                                        # brings up a fresh, empty DB
```
The volume is project-scoped: `orcha-<project-name>_pgdata` (project name = the
`name:` in `.orcha/docker-compose.yml`, derived from the directory).

**Tip:** to test a *first-run / empty* experience, don't wipe an existing project —
just `orcha init` in a **brand-new empty directory** (new project name → new volume →
guaranteed clean), and `orcha down -v` that throwaway dir when finished.

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

The `/loop /orcha-checkpoint` and `/orcha-listen` patterns work great when the
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

## Prerequisites

| Tool | Why | Install |
|---|---|---|
| **Docker Desktop** (or OrbStack / Colima) | runs Postgres + portal | macOS: see "Docker Desktop on macOS" below |
| **Homebrew** | installs the orcha CLI | <https://brew.sh> |

Tested on macOS (Apple Silicon, Darwin 25.x). Linux should work; Windows untested.

---

## Install the `orcha` CLI

One-time tap (private repo — your GitHub org SSH access is the auth):

```bash
brew tap open-orcha/orcha git@github.com:open-orcha/homebrew-orcha.git
brew install open-orcha/orcha/orcha
```

Verify:

```bash
orcha --version
orcha --help
```

Upgrade with `brew upgrade orcha` — or just run `orcha update` inside a
project: it upgrades the CLI via brew, then the project's templates, portal,
and DB in one shot. Downgrade via the frozen per-release formulae
(`brew install open-orcha/orcha/orcha@<version>`); details in the
[tap README](https://github.com/open-orcha/homebrew-orcha).

Hacking on Orcha itself (editable install from a clone)? See
[CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Use Orcha in a project (the user flow)

```bash
cd ~/projects/your-project
orcha init                            # writes .orcha/, .claude/commands/, brings up docker
# (picks free ports automatically: api=8000+, db=5432+)

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

Inspect at `http://localhost:<api_port>/` — paste the container_id into the
input. The dashboard polls every 3s.

### Files Orcha drops into your project

```
your-project/
├── .orcha/                              # docker stack (commit this)
│   ├── docker-compose.yml               # project-prefixed, unique ports
│   ├── migrations/                      # 001_init.sql … 010_*.sql, applied in order
│   └── portal/{Dockerfile, requirements.txt, main.py, static/}
└── .claude/
    ├── commands/                        # all /orcha-* slash command skills (commit these)
    │   ├── orcha-container.md
    │   ├── orcha-register-agent.md
    │   ├── orcha-status.md
    │   └── …                            # ~27 skills total — see the skill table above
    ├── settings.json                    # SessionStart/SessionEnd/PostToolUse hooks (orcha enable-hook)
    ├── orcha.json                       # project-shared: api_base_url, ports, current_container_id
    └── orcha-tabs/                      # per-tab agent binding (DO NOT commit — per-developer)
        └── <tty>.json                   # {alias, agent_id, container_id}
```

`.claude/orcha-tabs/` is gitignored-by-convention (per-developer terminal
state). Everything else is safe to commit.

Everything in `.orcha/` and `.claude/` is safe to commit; it's how a teammate
reproduces the same stack with `orcha up`.

### Lifecycle

Two distinct concepts share the word "container," so the verbs are split:

**Docker stack lifecycle** (the Postgres + portal runtime):

```bash
# from the project's directory:
orcha up                  # bring the stack up (after orcha down)
orcha down                # stop, KEEP volume (data persists)
orcha down -v             # stop + drop the Postgres volume (re-runs migrations on next up)
orcha status              # show config + `docker compose ps` for THIS project

# from anywhere (no cd required):
orcha ls                                   # list ALL running orcha Docker stacks across
                                           # projects, with their API ports + db ports
orcha down --project <name> [-v]           # stop a specific project's stack from any dir
orcha up   --project <name>                # bring it back up (see caveat below)
```

`<name>` is whatever `orcha ls` shows in the PROJECT column (e.g. `news1`,
`movies`, `orcha-demo`). The CLI prepends `orcha-` internally to match the
actual docker compose project name.

**Caveat — `up --project` only works on stopped (not down-ed) stacks.** `down`
removes containers and breaks the link to the compose file's location, so a
fresh `up` needs the project directory. Use `orcha up` from inside the project
dir to bootstrap after a full `down`.

**Orcha container lifecycle** (the project/milestone entity in the DB — operate on the current project's API):

```bash
orcha pause [container_id]            # flip Orcha container status to 'paused'
orcha resume [container_id]           # flip back to 'active'
orcha stop  [container_id]            # mark 'completed' (or --cancel for 'cancelled')
                                      # NOTE: does NOT stop the Docker stack — use `orcha down`.
```

If `container_id` is omitted, the CLI reads `current_container_id` from `.claude/orcha.json` in your CWD — same fallback the slash skills use. So inside your project dir, plain `orcha pause` does what you'd expect.

These mirror the `/orcha-pause`, `/orcha-resume`, `/orcha-stop` slash skills — same API call under the hood. The host CLI is useful when you want to script lifecycle events from a shell loop or cron without launching Claude Code.

### Force-kill a stack by port (when you're not in the project dir)

If you've lost track of which directory owns a stack (e.g. an old project on
port 8001 that you can't `cd` to anymore), this one-liner finds the compose
project from the port and tears it down with its volume:

```bash
docker compose -p $(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' $(docker ps -q --filter publish=8001)) down -v
```

Swap `8001` for whichever port is in use. Use this when `orcha down` isn't an
option (no `.orcha/` dir on hand).

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
│           ├── docker-compose.yml.j2
│           ├── migrations/              # 001_init.sql … 010_wake_kind_ephemeral.sql
│           ├── portal/{Dockerfile, requirements.txt, main.py, static/}
│           └── skills/                  # all ~27 orcha-*.md slash-command templates
└── README.md                            # you are here
```

Iteration loop: see [CONTRIBUTING.md](./CONTRIBUTING.md) — local install from
a clone, the uv wheel-cache footgun, and the release runbook all live there.

---

## Docker Desktop on macOS — the gotcha that cost us an hour

If you've never installed Docker Desktop before, **install Docker.app into the
system-wide `/Applications/` folder, not `~/Applications` or `~/Downloads`.**
This one detail prevents a cascade of confusing failures.

### Why this matters (the AppTranslocation story)

macOS Gatekeeper sets the `com.apple.quarantine` extended attribute on any app
downloaded from the internet. When you run a quarantined app from **anywhere
other than `/Applications/`** (e.g. `~/Downloads`, `~/Applications`), Gatekeeper
runs it from a read-only translocated copy at:

```
/private/var/folders/.../T/AppTranslocation/<random-uuid>/d/Docker.app
```

**The random UUID changes every launch.** Docker Desktop's first-launch
installer creates symlinks like `/usr/local/bin/docker` →
`<AppTranslocation>/Docker.app/Contents/Resources/bin/docker`. Those symlinks
go stale the moment you quit and relaunch the app.

### Symptoms

- `zsh: command not found: docker` (despite Docker Desktop running)
- `docker compose build` fails with:
  `error getting credentials - err: exec: "docker-credential-desktop": executable file not found in $PATH`
- `ls -la /usr/local/bin/docker` shows a symlink to an
  `AppTranslocation/<uuid>/...` path that doesn't exist anymore

### Fix (one-time)

1. **Quit Docker Desktop** from the menu-bar whale icon → *Quit Docker Desktop*.
2. **Move `Docker.app` into `/Applications/`** (drag in Finder).
3. **Relaunch** from `/Applications/Docker.app`.
4. **Repoint the CLI symlinks** if they're still broken. All five may need it
   — the `docker-credential-*` ones are easy to forget but builds fail without
   them:
   ```bash
   sudo ln -sf /Applications/Docker.app/Contents/Resources/bin/docker                /usr/local/bin/docker
   sudo ln -sf /Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose /usr/local/bin/docker-compose
   sudo ln -sf /Applications/Docker.app/Contents/Resources/bin/docker-credential-desktop     /usr/local/bin/docker-credential-desktop
   sudo ln -sf /Applications/Docker.app/Contents/Resources/bin/docker-credential-osxkeychain /usr/local/bin/docker-credential-osxkeychain
   sudo ln -sf /Applications/Docker.app/Contents/Resources/bin/docker-credential-ecr-login   /usr/local/bin/docker-credential-ecr-login
   ```
5. **Apple Silicon only:** confirm `/usr/local/bin` is on your `$PATH`. The
   default zsh PATH on M-series Macs leans on `/opt/homebrew/bin` and may omit
   `/usr/local/bin`. Add to `~/.zshrc` if missing:
   `export PATH="/usr/local/bin:$PATH"`.
6. Verify: `docker version` shows BOTH Client and Server.

### Diagnostic one-liner

```bash
ls -la /usr/local/bin/docker /usr/local/bin/docker-compose /usr/local/bin/docker-credential-* 2>&1
pgrep -fl "Docker Desktop" | head -1   # confirm it's running from /Applications/
```

A symlink target starting with `/private/var/folders/.../AppTranslocation/` is
the smoking gun.

---

## Troubleshooting cheatsheet

| Symptom | Cause | Fix |
|---|---|---|
| `command not found: docker` | broken AppTranslocation symlinks | move Docker.app to `/Applications/`, repoint symlinks |
| `error getting credentials: docker-credential-desktop ... not found` | `docker-credential-*` symlinks stale | repoint all three cred-helper symlinks |
| `orcha init` says "no free port in range" | host ports 8000..8099 / 5432..5531 all in use | `--api-port` / `--db-port` to pick explicitly |
| `Bind for 0.0.0.0:5432 failed` | a host Postgres is bound there | `orcha init` should auto-skip; if not, `--db-port 5433` |
| `psycopg.OperationalError: connection refused` from a skill | stack down or wrong port | `orcha status`; `orcha up` |
| Skill prints "Orcha isn't initialized" | no `.claude/orcha.json` in CWD | run `orcha init` in this project root |
| `/orcha-register-agent` says "Run /orcha-container first" | no `current_container_id` in `.claude/orcha.json` | run `/orcha-container "..."` once |
| `/orcha-next` / `/orcha-done` says "tab isn't bound to an agent" | no `.claude/orcha-tabs/<tty>.json` in this terminal | re-run `/orcha-register-agent` in this tab |
| `/orcha-done` returns 409 "task is 'ready', not 'in_progress'" | task hasn't been claimed yet | `/orcha-next` first, or only `done` your own claimed task |
| `/orcha-verify` returns 409 "task is 'in_progress', not 'needs_verification'" | task hasn't been marked done yet | wait for `/orcha-done` from the assignee |
| `/orcha-next` returns 429 "turn budget exhausted" | agent has hit its `turn_budget` (default 50) | `UPDATE agents SET turns_used=0 WHERE id=...` in psql, or re-register the agent |
| Portal returns 404 on a UUID | DB was reset, container id is stale | `/orcha-container` to make a new one |
| Edited `001_init.sql` template, schema didn't change in a live project | `initdb.d` only runs on first boot | `orcha down -v && orcha up` |
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
- `docker version` and `which docker`
- `ls -la /usr/local/bin/docker*`
- `orcha status` output from the project where things broke
