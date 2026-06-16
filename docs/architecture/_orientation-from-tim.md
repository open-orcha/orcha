# Orcha — Architecture Orientation (Tim → Page)

Page — this is your ramp. It's everything I (Tim, TPM) know about how Orcha is built, with pointers to the
real source so you can verify each claim. **Treat this as a seed, not gospel:** your first job is to read
the cited code/docs, confirm or correct what's below, and produce the canonical `00-system-overview.md` for
Kedar — flagging anything here that differs from the code. Ground everything in real files/endpoints/schema;
never invent. Cite `file:line`.

---

## 1. What Orcha is (the mental model)
Orcha is a **human-authoritative, multi-agent orchestration platform**. A human operator (Kedar) runs a team
of **agents** — each agent is a Claude session — that collaborate on **tasks** and exchange **requests**.
There is no message broker: **the Postgres database IS the bus.** Agents read/write rows; an event/poll loop
moves work; a notifier daemon wakes idle agents. The human is always in command — agents **never
self-certify**: their work stops at `needs_verification` and a human approves it.

Two ideas everything else hangs off:
- **Episodic agents.** An agent is *not* a long-running process. It is woken on demand as a short-lived
  **headless `claude -p` worker**; each wake is a fresh process that **rehydrates** from a memory digest +
  DB state. So "one agent" = many discrete **runs** over time. Continuity is *injected*, not retained.
- **Async human-authority gates.** Instead of synchronous "allow this tool?" prompts, the human governs via
  deliberate, durable **decisions**: approve/reject a plan, verify a finished task, answer/close a request.
  These are recorded in a `decisions` table with a **required reason on reject**.

## 2. The core entities (the vocabulary)
(Schema lives in `orcha-cli/orcha_cli/templates/migrations/001_init.sql` + later `migrations/*.sql`; the
read API is `orcha-cli/orcha_cli/templates/portal/main.py`.)

- **Container** — the project/workspace. **1:1:1**: one stack → one DB → one container (so the portal
  auto-resolves it; no picker needed). Columns incl. `name, description, status` (active/paused/completed/…),
  `execution_mode` (`human` = human-authoritative), `root_task_id`, `max_tasks`.
- **Agent** — `agents` table: `id, container_id, alias, role, kind` (`human` | `ai`), `system_prompt`,
  `status` (idle · working · awaiting_request · awaiting_human · blocked · terminated), `turn_budget/turns_used`,
  `last_heartbeat_at`, `is_auto_created`, `parent_agent_id`. **Humans are first-class agents** (PR #31, the
  1:1:1 + humans-as-agents shift) — a human teammate is an `agents` row with `kind='human'`.
- **Task** — `title, description, definition_of_done, status` (ready · in_progress · needs_verification ·
  completed · blocked · cancelled · pending), `priority`, `is_root`. **Assignment is a join** (`agent_tasks`),
  not a column. Thread = `task_messages`. Per-wake execution = `worker_runs`.
- **Request** (agent → agent) — `requester_id, target_id` (NB: *not* `*_agent_id`), `type` (`info` | `task`),
  `priority`, `status` (open · answered · closed · rejected · accepted · converted_to_task), `payload`,
  `in_service_of` (request chains) + `chain_depth`. A `target_id` of NULL + `open` = **escalated to human**.
- **Decision** — `decisions` table: `subject_type` (plan_approval / task_close / request_close …),
  `subject_id`, `decision` (approve|reject), `reason`, `actor_agent_id`, `target_agent_id`. The human-authority
  audit record. (Today there's only `POST /api/decisions` + `GET /api/decisions/{did}` — no list endpoint;
  this gap is **ISS-41**, where an approved plan re-surfaces because the portal can't read prior decisions.)
- **Run** — `worker_runs`: one row per wake, `status` (running · exited · killed · timeout_killed), `output`
  (captured at reap), `diff` (git diff vs origin/main, ISS-8). Exposed via `GET /api/agents/{aid}/runs` +
  `/api/tasks/{tid}/runs`.
- **Events / messages** — the bus surface: `GET /api/agents/{aid}/wait` (long-poll), `/api/agents/{aid}/events`,
  `/api/containers/{cid}/events`, `/api/tasks/{tid}/messages`.

## 3. The wake path (how an episodic agent actually runs) — the heart of the system
Source: `orcha-cli/orcha_cli/notifier.py` (the daemon) + `__main__.py` (CLI) + the wake endpoints in `main.py`.
1. **Reachability** — `agent_reachability` (`wake_enabled`, `headless_cwd`) records *how* to wake an agent
   (the project dir where a worker spawns). Set by `orcha reachability` / SessionStart hook / on register.
2. **Wake state** — `agent_wake_state` tracks a delivered-events cursor + a single-flight `wake_lease_until`
   (so two daemons can't double-spawn).
3. **The daemon** — `orcha notifier` polls `GET /api/containers/{cid}/wake-scan` (returns `candidates`),
   takes a lease, and **spawns a headless worker**:
   `claude -p "<prompt>" --output-format stream-json --verbose --append-system-prompt "<persona+digest>"
   --dangerously-skip-permissions` (in `headless_cwd`, `ORCHA_HEADLESS_WORKER=1`, `start_new_session=True`,
   stdin=/dev/null). See `notifier.py` ~L215-273.
4. **Boots AS the agent** — the `--append-system-prompt` carries the agent's persona + "where you left off"
   digest (`format_persona()` in `notifier.py` ~L176). So the worker reasons as Forge/Vault/Page/etc.
5. **Output capture (A1/A2)** — stream-json → a per-wake NDJSON log under `<cwd>/.claude/.orcha-wakes/`;
   at reap a `worker_runs` row is written (status, output, diff). Live view = SSE
   `GET /api/agents/{aid}/runs/{run_id}/stream`.
6. **Isolation (ISS-8)** — each worker gets its own git worktree under `.orcha-worktrees/` so parallel
   workers don't collide; the net `git diff vs origin/main` is stored on the run.
7. **Watchdog (ISS-15/31)** — the daemon kills a worker that **stalls** (no log growth for ~120s) or exceeds a
   **hard cap** (`HARD_CAP_MIN_SECS=1200`, decoupled from the lease by #66). *Open:* **ISS-29** — a worker
   that finishes (`result/success`) but lingers gets stall-killed (recorded `killed`, and a SIGKILL skips the
   exit hook).
8. **Why bypass permissions** — a headless worker has no stdin, so any permission prompt would hang it
   forever. The human-authority gate is therefore the *async* Orcha decision layer, NOT Claude's prompts.
   (Future: `A5` allowlist + a PreToolUse→Orcha-decision gate + an attended/PTY mode for live Q&A/MCP.)

## 4. Continuity — N wakes read as ONE agent (Epic C)
- **C2 rehydrate-on-boot** — SessionStart `orcha rehydrate` injects the latest digest so a fresh wake
  continues where the last left off. ✅ shipped.
- **C1 digest write-on-exit** — SessionEnd `orcha snapshot` writes a continuity digest (current_focus,
  decisions, open_threads) to `agent_memory_digests` before the worker dies. `cmd_snapshot` self-gates on
  `ORCHA_HEADLESS_WORKER=1`. *Open:* **ISS-40** — the hook *is* coded (`__main__.py:1057`) but
  `_write_hook_config` only runs at `init`/`connect`, so the live `.claude/settings.json` lacks it → run
  `orcha enable-hook` to materialize it.

## 5. Human-authority gates
- `needs_verification` + `/orcha-verify` (human approves → `completed`, or rejects with reason → back to
  in_progress). `B0` is the one reusable Approve/Reject+reason control; `B10` is the plan-approval surface;
  reason is **required on reject** (UI + API + a DB CHECK). All recorded in `decisions`.

## 6. The portal (the human surface)
- **Stack:** static HTML + **vanilla JS** hitting a **FastAPI** backend (`templates/portal/main.py`). Pages:
  `static/{home,agents,tasks,requests}.html`, served at `/`, `/agents`, `/tasks`, `/requests`. Auto-refresh 3s.
- **Data:** `GET /api/containers` → `GET /api/containers/{cid}` = `{container, agents, tasks, requests}`;
  detail via `/api/agents/{aid}/{runs,digest,persona,inbox,outbox}`, `/api/tasks/{tid}/messages`, the SSE
  stream, `/api/decisions`.
- **Live feed (B1):** worker stream classified into ~9 event types. *Open:* **ISS-39** — the SSE endpoint
  emits only `seq 1` then stalls (so the live feed shows one event).
- **Redesign (D-series):** a Claude-Design handoff in `docs/portal-redesign-ref/` (teal-orca brand, full
  light/dark, dense dashboard) is scoped to replace the bespoke per-page CSS — see pivot-tasks §3.5.

## 7. CLI · skills · hooks
- **CLI** (`orcha-cli/orcha_cli/__main__.py`): `init`, `up`, `connect`, `watch`/`unwatch`, `notifier`,
  `reachability`, `rehydrate`, `snapshot`, `enable-hook`. Relaunch with **`orcha up`** — never `init --force`
  (new container) or `down -v` (DB wipe).
- **Hooks** (programmatically written to `.claude/settings.json` by `_write_hook_config`): SessionStart →
  `orcha watch --detach` + `rehydrate` + `notifier --ensure` + `reachability`; SessionEnd → `orcha unwatch`
  (+ `snapshot` once ISS-40 lands); PostToolUse → `orcha poll-inbox`. **Note:** SessionStart hooks are gated
  off for headless workers (ISS-21) so a worker doesn't spawn daemons/poll itself.
- **Skills** (`/orcha-*`): work loop (`next`, `post`, `done`, `task-new`), requests (`ask`, `respond`, `close`,
  `escalate`, `convert`, `inbox`, `outbox`), events (`listen`, `checkpoint`), human-only (`verify`,
  `decide-suggestion`, `pause`/`resume`/`stop`), continuity (`snapshot`, `rehydrate`, `use`), registration
  (`register-agent`, `register-human`). Agents **suggest** new agents (`/orcha-suggest-agent`); the human decides.

## 8. Source map (where to look)
| Area | Path |
|---|---|
| DB schema | `orcha-cli/orcha_cli/templates/migrations/*.sql` |
| API (read + mutate, SSE, wake, decisions) | `orcha-cli/orcha_cli/templates/portal/main.py` |
| Portal pages | `orcha-cli/orcha_cli/templates/portal/static/*.html` |
| Wake daemon / worker spawn / watchdog | `orcha-cli/orcha_cli/notifier.py` |
| CLI / hooks / snapshot / rehydrate | `orcha-cli/orcha_cli/__main__.py` |
| Roadmap + findings | `docs/orcha-roadmap-and-findings.md` |
| Pivot plan / tasks (v1) | `docs/orcha-portal-pivot-{plan,tasks}.md` |
| Live status board | `docs/orcha-status-board.md` |
| Issues register | `docs/orcha-issues-log.md` |
| Functional tests | `docs/orcha-functional-tests.md` |
| Portal redesign reference | `docs/portal-redesign-ref/` |

## 9. Key decisions / invariants (good brainstorm anchors)
- **DB-as-bus** (no broker — a Kafka spike was cancelled by design: a broker would split the seat of authority + audit log).
- **1:1:1** stack:db:container; **humans-as-agents** (PR #31).
- **Episodic workers** + injected continuity (digest), not long-lived processes — so context **compaction is a non-issue** for workers; the digest is the deliberate, curated stand-in.
- **Human authority is async + reasoned**, not synchronous permission prompts.
- **SSE over WebSocket** for the run feed (one-way tail).
- **Never self-certify**; relaunch safely (`orcha up`); **Postman collection stays in lockstep** with API/DB changes (G6 / FT-DEPLOY-4). _[Superseded 2026-06-12: Postman lockstep retired → Swagger/OpenAPI `/openapi.json` is the API source of truth; see `docs/orcha-review-protocol.md` §4.]_

## 10. Current state (so you have context)
A.B.C epics (engine / surface / continuity) are largely built (PRs #39/#40/#41) on a portal-only pivot.
Open right now (the "gate"): **ISS-39** (SSE stalls), **ISS-29** (worker linger→stall-kill), **ISS-40** (C1
hook not in live settings), **ISS-41** (plan card re-surfaces). The D-series portal redesign is scoped but
not built. The status board is the live source of truth.

---
*When in doubt, read the code and trust it over this doc — then fix this doc.*
