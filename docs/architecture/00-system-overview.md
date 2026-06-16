# Orcha — System Overview (code-verified)

*Page (Technical Communicator), 2026-06-03. Validated against the real source at the
file:line cited below; trust the code over this doc, then fix this doc. Seeded from
Tim's `_orientation-from-tim.md`; the deltas I found are flagged in **§11**.*

Source roots (everything is in the CLI's templated app):
- DB schema — `orcha-cli/orcha_cli/templates/migrations/001_init.sql` … `005_worker_run_diff.sql`
- API (read + mutate, SSE, wake, decisions) — `orcha-cli/orcha_cli/templates/portal/main.py` (3085 lines)
- Wake daemon / worker spawn / watchdog — `orcha-cli/orcha_cli/notifier.py` (940 lines)
- CLI / hooks / snapshot / rehydrate — `orcha-cli/orcha_cli/__main__.py` (1748 lines)
- Portal pages — `orcha-cli/orcha_cli/templates/portal/static/{home,agents,tasks,requests}.html`

---

## 1. The mental model (one paragraph)

Orcha is a **human-authoritative, multi-agent orchestration platform**. A human operator
(Kedar) runs a team of **agents** — each agent is a Claude session — that collaborate on
**tasks** and exchange **requests**. **There is no message broker: Postgres IS the bus.**
Agents read/write rows through one FastAPI service; a **notifier daemon** (the only non-AI,
long-lived process) wakes idle agents out-of-band. Two ideas carry the whole design:

- **Episodic agents.** An "agent" is *not* a long-running process. It's woken on demand as a
  short-lived headless `claude -p` worker; each wake is a fresh process that **rehydrates**
  from a memory digest + DB state. One agent = many discrete **runs** over time. Continuity is
  *injected*, never retained.
- **Async human-authority gates.** Instead of synchronous "allow this tool?" prompts, the human
  governs via durable **decisions** (approve/reject a plan, verify a finished task, answer a
  request) — recorded in a `decisions` table with a **reason required on reject**. Agents
  **never self-certify**: their work stops at `needs_verification` and a human approves it.

---

## 2. Core entities (the vocabulary)

All in `001_init.sql` unless noted. Field names below are **exact** — they bite when wrong.

| Entity | Table | Key fields & notes |
|---|---|---|
| **Container** | `containers` (L4) | The project/workspace. `status` = active·paused·completed·failed (L8); `execution_mode` = human·agent (L17); `root_task_id`, `max_tasks`, `max_auto_agents`, `wakes_enabled` (002:L12, the global wake kill-switch). **1:1:1** — one stack → one DB → one container, enforced by a unique index on a constant: `CREATE UNIQUE INDEX containers_singleton ON containers ((true))` (L26). So the portal never needs a container picker. |
| **Agent** | `agents` (L29) | `alias`, `role`, `kind` ∈ {`ai`,`human`} (L39), `system_prompt` (NULL for humans), `status` ∈ idle·working·blocked·awaiting_request·awaiting_human·terminated (L43-44), `turn_budget`/`turns_used`, `last_heartbeat_at`, `is_auto_created`, `parent_agent_id`. **Humans are first-class agents** (a `kind='human'` row). `is_auto_created`/`parent_agent_id` are **audit-only** — agents never spawn agents; humans do (L46-53). |
| **Task** | `tasks` (L67) | `title`, `description`, `definition_of_done` (NOT NULL — explicit completion criteria), `status` ∈ pending·ready·in_progress·blocked·needs_verification·completed·cancelled (L73-74), `priority` (**lower = higher**, L75), `is_root`, `result` (JSONB). **Assignment is a join, not a column** → `agent_tasks` (L94). DAG edges → `task_dependencies` (L85, acyclicity enforced in app code). Collaboration thread → `task_messages` (L138, append-only so co-workers don't clobber `result`). |
| **Request** | `requests` (L103) | Agent→agent message. `requester_id`, **`target_id`** (NB: *not* `*_agent_id`; `target_id = NULL` + `open` = **escalated to a human**, L108), `type` ∈ {`info`,`task`}, `status` ∈ open·accepted·rejected·answered·converted_to_task·closed (L110-111), `payload`/`response`, `expires_at` (deadlock guard), `parent_request_id`+`chain_depth` (request chains, Orcha#1, L117-121), `detail` JSONB (structured task/agent-suggestion payloads, L123). |
| **Decision** | `decisions` (003:L10) | The human-authority audit record. `subject_type`/`subject_id` (generic free-text, so one contract serves every surface), `decision` ∈ {`approve`,`reject`}, `reason`, `actor_agent_id` (the human), `target_agent_id` (who consumes `{decision,reason}` on next wake). **DB CHECK** `decisions_reject_needs_reason` (003:L23) makes a reason-less reject impossible even via raw psql. |
| **Run** | `worker_runs` (004:L5) | One row per wake. `status` ∈ **running·exited·killed** (004:L11 — see §11 correction), `exit_code`, `log_path`, `output` (captured stream-json), `diff` (net git diff vs origin/main, 005). `task_id` nullable (a wake may just drain events). |
| **Digest** | `agent_memory_digests` (001:L253) | Per-agent reasoning snapshot (`current_focus`, `decisions`, `learnings`, `open_threads`). Append-only; newest row is the live view. Agent-composed (server never synthesizes it). |
| **Event bus** | `agent_events` (001:L186) | **Durable** event log (Orcha#25). `event_key` = the target agent's id, or `c:<container_id>` for container-wide. `ts` = epoch seconds, matches the `?since_ts=` cursor. `_publish_event` INSERTs in the **same transaction** as the mutation that emits it (no event without its cause; none lost to a crash). |
| **Reachability / wake state** | `agent_reachability` (001:L209), `agent_wake_state` (001:L222) | *How* to wake an agent (`wake_enabled`, `tmux_target`, `headless_cwd`, `headless_flags`) and the daemon's per-agent cursor (`delivered_ts`) + single-flight `wake_lease_until` (002:L8). |
| **Audit** | `events` (001:L147) | Separate append-only human/system audit log (distinct from the `agent_events` bus). |

---

## 3. The wake path — how an episodic agent actually runs (the heart)

Source: `notifier.py` (daemon) + the wake endpoints in `main.py`. The **wake decision is
server-side** (`GET /api/containers/{cid}/wake-scan`, `main.py:1116`), so the host-side daemon
stays a thin transport executor and the invariant "only the API touches the DB" holds.

```
                         ┌─────────────────────────────────────────────┐
                         │  notifier daemon  (orcha notifier)           │
                         │  non-AI, long-lived, one per project         │
   every ~interval s     │                                              │
   ┌────────────────────▶│  1. reap_workers()  — release leases of      │
   │                     │     workers that exited; watchdog the rest   │
   │                     │  2. tick() → GET /wake-scan                   │
   │                     └───────────────┬──────────────────────────────┘
   │                                     │ candidates[] + should_wake
   │                                     ▼
   │              ┌──────────────────────────────────────────┐
   │              │  for each should_wake candidate:          │
   │              │   select_transport() → tmux | headless    │
   │              │   POST /wake-claim  (single-flight lease)  │──┐ loser: skip,
   │              │   ─ win? ─▶ provision worktree (if code)   │  │ don't spawn
   │              │            build persona+digest            │  │
   │              │            spawn_headless(claude -p ...)   │  │
   │              │            POST /agents/{id}/runs (running)│  │
   │              └───────────────┬──────────────────────────┘  │
   │                              ▼                              │
   │     ┌────────────────────────────────────────────┐         │
   │     │  headless worker:  claude -p  in worktree    │        │
   │     │  --append-system-prompt <persona+digest>     │        │
   │     │  ORCHA_ALIAS=<alias> ORCHA_HEADLESS_WORKER=1  │       │
   │     │  --dangerously-skip-permissions  stdin=/dev/null │    │
   │     │  → drains inbox, makes progress, EXITS        │       │
   │     │  stream-json → per-wake .log (tailable)       │       │
   │     └───────────────┬──────────────────────────────┘        │
   │                     │ on exit / stall / completion          │
   └─────────────────────┴── POST /runs/{id}/finish (status+output+diff)
                             POST /wake-ack (release_lease=true)
```

Step by step:

1. **Reachability** (`agent_reachability`, 001:L209) records *how* to wake — set by
   `orcha reachability` / the SessionStart hook / on register.
2. **Wake state** (`agent_wake_state`, 001:L222 + 002:L8) tracks the delivered-events cursor
   and a single-flight `wake_lease_until`.
3. **wake-scan verdict** (`main.py:1196`): `should_wake = container active AND wakes_enabled AND
   per-agent wake_enabled AND (pending events OR an assigned ready task) AND agent looks idle
   (heartbeat older than min_idle) AND not in cooldown AND no live lease`. Each non-wake gets a
   human-readable `reason` (`main.py:1199-1219`).
4. **Single-flight claim** (`POST /api/agents/{aid}/wake-claim`, `main.py:1275`): an atomic
   conditional UPDATE hands out an exclusive TTL-bounded lease; concurrent scans serialize to
   exactly **one winner**. The loser gets `{claimed:false}` and does not spawn. **This is the
   runaway fix** — before it, nothing stopped a 2nd/3rd/12th worker per agent. Also the
   enforcement point for the global kill-switch.
5. **Spawn AS the agent** (`spawn_headless`, `notifier.py:211`): exact argv —
   `claude -p "<prompt>" --output-format stream-json --verbose --append-system-prompt
   "<persona+digest>" --dangerously-skip-permissions`, run in `headless_cwd` (or an isolated
   worktree) with `ORCHA_ALIAS=<alias>` and `ORCHA_HEADLESS_WORKER=1`, `stdin=/dev/null`,
   `start_new_session=True`. The persona+digest (`format_persona`, `notifier.py:176`) is what
   makes the worker reason *as* Forge/Vault/Page rather than a generic Claude.
6. **Why bypass permissions** (`notifier.py:234-242`): a headless worker has no tty, so any
   permission prompt would hang it forever. Hence the human-authority gate is the **async Orcha
   decision layer**, not Claude's synchronous prompts.
7. **Output capture (A1/A2)**: stream-json → a per-wake NDJSON log under
   `<cwd>/.claude/.orcha-wakes/` (`notifier.py:678`); on reap a `worker_runs` row is finished
   with status+output+diff (`_finish_run`, `notifier.py:390`). Live view = SSE
   `GET /api/agents/{aid}/runs/{run_id}/stream`.
8. **Worktree isolation (ISS-8)** (`_provision_worktree`, `notifier.py:443`): code-touching
   wakes run in their own git worktree off `origin/main` under `.orcha-worktrees/` so parallel
   workers don't collide; the net `git diff vs origin/main` is captured on the run
   (`_capture_diff`, `notifier.py:488`). Pure single no-code wakes (a request-answer/note) skip
   the worktree to save ~200–500ms (`notifier.py:696-702`). *(You are reading this inside such a
   worktree right now.)*
9. **Watchdog (ISS-15/29/31)** (`reap_workers`, `notifier.py:518`): the daemon kills a worker
   that **stalls** (no log growth for `stall_secs`=120s) or blows a generous hard-cap backstop
   (`HARD_CAP_MIN_SECS=1200s`, decoupled from the lease by #66). A worker that already emitted a
   terminal `result` is treated as **completed**: it gets a `GRACEFUL_EXIT_SECS=180s` window for
   its SessionEnd hook to run and is recorded **`exited`**, not `killed` (`notifier.py:563-591`).
   Kills signal the whole **process group** so claude's tool-subprocess children die too
   (`_kill_worker`, `notifier.py:333`).

---

## 4. Continuity — N wakes read as ONE agent (Epic C)

Because workers are episodic, continuity is **injected at boot**, not held in a conversation —
so context compaction is a non-issue for workers; the digest is the deliberate, curated stand-in.

- **C2 rehydrate-on-boot** ✅ — SessionStart `orcha rehydrate` (`__main__.py:1223`) injects a
  "where we left off" brief (identity + live tasks + open inbox + answered outbox + latest
  digest) via `GET /api/agents/{aid}/rehydrate` (`main.py:2860`).
- **C1 digest write-on-exit** — SessionEnd `orcha snapshot` (`cmd_snapshot`, `__main__.py:1363`)
  writes a continuity digest before the worker dies. It **self-gates on `ORCHA_HEADLESS_WORKER=1`**
  (`__main__.py:1377`) so interactive human tabs are unaffected.
- **Ownership boundary** (locked with Dock's D3 spec): Claude Code file-memory (MEMORY.md +
  typed facts, *outside* the repo) owns durable user/project/feedback facts; the DB digest owns
  per-agent work/reasoning state. Two **parallel** SessionStart injectors, **no bidirectional
  sync** (001:L229-263).

> ⚠️ **ISS-40 (live gap, verified):** the C1 hook *is* in the canonical hook writer
> (`_write_hook_config`, `__main__.py:1057`), but the **already-deployed** live
> `/Users/kedar/ai_apps/Orcha/.claude/settings.json` SessionEnd block currently contains only
> `orcha unwatch` — `orcha snapshot` is **missing**. Remediation: `orcha enable-hook`
> (`__main__.py:1071`) re-runs `_write_hook_config` idempotently and materializes it. See §11.

---

## 5. Human-authority gates

- **Task verification:** an agent marks a task **done → `needs_verification`** (never
  `completed`); a human runs `/orcha-verify` → `completed` (may unblock downstream), or rejects
  **with a required reason** → back to `in_progress`. (`/api/tasks/{tid}/done` `main.py:1696`,
  `/verify` `main.py:1741`.)
- **The decision contract (B0/G1):** one endpoint `POST /api/decisions` (`main.py:2998`) backs
  every approval surface. It enforces **reject-needs-reason server-side** (422 if missing,
  `main.py:3002`), persists `{decision, reason}`, and emits a `decision_made` event to the target
  agent so its next wake sees the *why*, not just yes/no. Only a `kind='human'` actor may decide
  (`_require_kind`, `main.py:3010`).
- **Reads:** `POST /api/decisions` + `GET /api/decisions/{did}` only — **no list endpoint** yet
  (that gap is **ISS-41**: an approved plan can re-surface because the portal can't read prior
  decisions).

---

## 6. The portal (the human surface)

- **Stack:** static HTML + **vanilla JS** hitting the **FastAPI** backend (`templates/portal/
  main.py`). Pages `static/{home,agents,tasks,requests}.html` served at `/`, `/agents`,
  `/tasks`, `/requests`. Home auto-refreshes every **3s** (`home.html:295`).
- **Data:** `GET /api/containers` → `GET /api/containers/{cid}` returns the one snapshot every
  page reuses: `{container, agents, tasks, requests}` (also aliased as `GET /api/snapshot/{cid}`,
  `main.py:2939`). Detail via `/api/agents/{aid}/{runs,digest,persona,inbox,outbox,rehydrate}`,
  `/api/tasks/{tid}/messages`, the SSE stream, and `/api/decisions`. Tasks expose `assignees` as
  **aliases** (joined from `agent_tasks`).
- **Live run feed (B1):** the agents/tasks detail panels open an **EventSource** on a running
  run's `/runs/{run_id}/stream` and classify the stream into a typed taxonomy
  (`agents.html:401`, `tasks.html:911`; consumes Forge's PR #58).

> ⚠️ **ISS-39 (nuance):** the live tail showing "seq 1 then stall" is **macOS Docker VirtioFS
> per-mount attr-cache lag (1–5s)**, *not* a generator bug — it won't occur on Linux prod. The
> robust fix is to have the daemon push lines into a `worker_run_lines` table and have SSE tail
> the DB (sequenced after PR #66). *(From the issues log / Page's findings — not re-derived from
> code here; flagged as such.)*

---

## 7. CLI · skills · hooks

- **CLI** (`__main__.py`): `init`, `up`, `connect`, `watch`/`unwatch`, `notifier`,
  `reachability`, `rehydrate`, `snapshot`, `enable-hook`, `poll-inbox`. **Relaunch with
  `orcha up`** — never `init --force` (new container) or `down -v` (DB wipe).
- **Hooks** (written to `.claude/settings.json` by `_write_hook_config`, `__main__.py:996`):
  SessionStart → `orcha watch --detach` + `orcha rehydrate` + `orcha notifier --ensure` +
  `orcha reachability --quiet`; SessionEnd → `orcha unwatch` (+ `orcha snapshot` once §11/ISS-40
  is materialized); PostToolUse → `orcha poll-inbox`. **SessionStart hooks short-circuit to a
  no-op inside a headless worker** (ISS-21, gated on `ORCHA_HEADLESS_WORKER`, `__main__.py:739`)
  so a worker doesn't spawn daemons or poll itself.
- **Skills** (`/orcha-*`): work loop (`next`, `post`, `done`, `task-new`), requests (`ask`,
  `respond`, `close`, `escalate`, `convert`, `inbox`, `outbox`), events (`listen`, `checkpoint`),
  human-only (`verify`, `decide-suggestion`, `pause`/`resume`/`stop`, `sweep`), continuity
  (`snapshot`, `rehydrate`, `use`), registration (`register-agent`, `register-human`). Agents
  **suggest** new agents (`/orcha-suggest-agent`); the human decides (`decide-suggestion`).

---

## 8. Request lifecycle (quick reference)

```
  /orcha-ask ──▶ open ──┬─ /orcha-respond ─▶ answered ─▶ /orcha-close ─▶ closed
   (info|task)          │  (target answers)              (requester satisfied)
                        ├─ /orcha-escalate ─▶ target_id := NULL  (now a human's)
                        ├─ /orcha-reject-task ─▶ rejected ─▶ suggest-agent / re-ask
                        ├─ /orcha-accept-task ─▶ accepted ─▶ in_progress task
                        └─ /orcha-convert ─▶ converted_to_task (spawned_task_id set)
  expires_at passes while still open ─▶ /orcha-sweep re-targets at a human (deadlock guard)
```
Chains: a follow-up asked *in service of* answering a parent carries `parent_request_id` +
`chain_depth` (001:L117). `target_id = NULL` + `open` is the canonical "this is now a human's to
answer" state.

---

## 9. Key invariants (good brainstorm anchors)

- **DB-as-bus** — no broker (a Kafka spike was cancelled by design: a broker would split the seat
  of authority + the audit log).
- **1:1:1** stack:db:container; **humans-as-agents**.
- **Episodic workers** + injected continuity; **single-flight lease** per agent (the runaway fix).
- **Human authority is async + reasoned**, not synchronous permission prompts.
- **SSE over WebSocket** for the run feed (one-way tail).
- **Never self-certify**; relaunch safely (`orcha up`); the API contract's source of truth is the
  generated **Swagger / OpenAPI** spec (`/openapi.json`) — reviewers verify routes/schemas against it
  (repo CLAUDE.md; the former Postman-lockstep / FT-DEPLOY-4 mandate was retired 2026-06-12).

---

## 10. Source map

| Area | Path |
|---|---|
| DB schema | `orcha-cli/orcha_cli/templates/migrations/001_init.sql` … `005_*.sql` |
| API (read/mutate, SSE, wake, decisions) | `orcha-cli/orcha_cli/templates/portal/main.py` |
| Portal pages | `orcha-cli/orcha_cli/templates/portal/static/*.html` |
| Wake daemon / worker spawn / watchdog | `orcha-cli/orcha_cli/notifier.py` |
| CLI / hooks / snapshot / rehydrate | `orcha-cli/orcha_cli/__main__.py` |
| Roadmap + findings | `docs/orcha-roadmap-and-findings.md` |
| Issues register | `docs/orcha-issues-log.md` |
| Functional tests | `docs/orcha-functional-tests.md` |
| API contract source of truth | Swagger / OpenAPI — `/docs`, `/openapi.json` |
| Postman collection (_lockstep retired 2026-06-12; frozen artifact_) | `docs/orcha.postman_collection.json` |

---

## 11. Deltas from Tim's orientation (what I corrected against the code)

1. **`worker_runs.status` has three values, not four.** The orientation's Run bullet lists
   `running·exited·killed·timeout_killed`. The schema is **`running·exited·killed`** only
   (004:L11), and `reap_workers` ever writes only `exited` or `killed` (`notifier.py:539`,
   `:594`). The `timeout`/`stall` distinction lives in the **wake-ack `kind`**
   (`worker_timeout_killed` / `worker_stalled_killed`, `notifier.py:596`), not on the run row.
2. **ISS-29 is addressed in the current code, not open.** The orientation flags ISS-29 as an open
   "completed worker lingers → gets stall-killed → recorded `killed` + digest lost." The current
   `reap_workers` detects the terminal `result` event, holds off, grants a 180s graceful-exit
   window for SessionEnd, and records **`exited`** (`notifier.py:563-591`); the ISS-29 reaping
   landed in commit `1923c98`. So the linger→mislabel→lost-digest failure is handled — pending
   the human's verification of that fix.
3. **ISS-40 is real *and* currently live.** The orientation says the C1 snapshot hook "is coded
   but `_write_hook_config` only runs at init/connect so live settings lacks it." I confirmed
   both halves: the hook **is** in `_write_hook_config` (`__main__.py:1057`), **and** the live
   `/Users/kedar/ai_apps/Orcha/.claude/settings.json` SessionEnd block currently has only
   `orcha unwatch`. Fix is `orcha enable-hook` (idempotently re-runs `_write_hook_config`).
4. **The event bus is durable, not in-memory.** Worth stating plainly (the orientation lists the
   `/wait`+`/events` surface but not its backing): events are persisted in `agent_events`
   (001:L186, Orcha#25) and replay via the `delivered_ts` cursor, so a portal restart or a
   reconnecting agent loses nothing. (An earlier internal assumption that the bus was an
   in-process ring buffer was the *pre*-Orcha#25 design; the table replaced it.)
5. **`events` (audit) ≠ `agent_events` (bus).** Two different append-only tables; don't conflate
   them. `events` (001:L147) is the human/system audit log; `agent_events` is the wake/SSE bus.

---

## 12. Open questions

1. **ISS-40 remediation:** should I (or Forge) run `orcha enable-hook` on the live project now to
   materialize the `orcha snapshot` SessionEnd hook, or is that intentionally deferred until C1
   (PR #60) clears verification? Right now headless workers exit **without** writing a digest.
2. **ISS-41 (no decisions list endpoint):** is the intended fix a `GET /api/decisions?subject=…`
   read endpoint, or should the portal derive "already approved" from the `decision_made` event
   stream? This changes whether we add API surface (reflected in Swagger `/openapi.json`) or just portal JS.
3. **ISS-39 fix scope:** commit to the `worker_run_lines` DB-tail approach (a new table + endpoint,
   schema change), or accept the VirtioFS lag as a macOS-dev-only artifact and document it as
   non-blocking for Linux prod?
4. **Doc scope:** want me to split this into per-subsystem deep-dives next (e.g.
   `01-wake-path.md`, `02-requests-and-chains.md`, `03-continuity.md`), or keep one overview and
   add topic docs only as brainstorm requests arrive?

---
*Validated 2026-06-03 against the cited source. Stops at `needs_verification` — a human verifies.*
