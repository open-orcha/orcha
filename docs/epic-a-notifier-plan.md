# Epic A — Wake & Self-Movement (Implementation Plan)

**Owner:** Forge (Backend/Infra, Agent Orchestration & Eventing)
**Subsumes:** Orcha#5 (event bus / push) and Orcha#33 (poll-inbox hook).
**Status:** PLAN — posted to the Epic A task thread before coding (DoD gate).

---

## 0. The problem, precisely

The platform's #1 pain is that **an idle agent never resumes on its own**.

What already exists (and is *not* the gap):
- A **durable** event bus — `agent_events` (Orcha#25), written in the same txn as the
  state change it announces. Events are never lost to a restart.
- A **long-poll** `GET /api/agents/{aid}/wait?since_ts=` and SSE `/events` (Orcha#5).
  Consumed by `/orcha-listen`.
- Orcha#33's `orcha watch` (SessionStart-spawned background poller) + `orcha poll-inbox`
  (PostToolUse hook) that surface inbox items into a running session's next turn.

The gap: **every one of those requires the agent's Claude session to already be running
and taking turns.** `orcha watch` is bound to the parent Claude PID and dies when the tab
closes; `/orcha-listen` only advances while the session loops. A tab that finished its
turn (Claude idle, awaiting the human) will *not* pick up:
- a task newly **assigned** to it,
- a blocked task whose deps just completed (now **ready**),
- a new **info/task request** addressed to it,

…until a human switches to that tab and types "continue." That manual nudge is the pain.

Epic A closes it with two coupled pieces, both **non-AI** infra:
1. A persistent **notifier daemon** that watches Postgres and emits an **out-of-band WAKE**
   to the right agent through a **reachability registry** — wake is ON by default.
2. **Auto-start**: a woken/started agent auto-claims+begins an assigned, ready task —
   but never touches the human verification gate.

Hard invariants (never crossed): auto-start **never** self-certifies, **always** stops at
`needs_verification`, **respects `/orcha-pause`** (container `paused`), and **obeys an
explicit human wait-instruction / HOLD** (coordinated with Frame, Epic B).

---

## 1. Phasing (ship order)

- **Phase 0 — cron self-rearm STOPGAP (ship FIRST).** A scheduled `orcha notifier --once`
  that runs the scan-and-wake logic a single time and re-arms itself (host cron / launchd /
  the harness scheduler). Stops missed events *immediately* (≤ poll interval latency) while
  the daemon is built. It is literally one iteration of the daemon loop, so zero throwaway.
- **Phase 1 — reachability registry.** Schema + record-at-registration + refresh hook.
- **Phase 2 — notifier daemon.** `orcha notifier` long-running loop (the stopgap's loop).
- **Phase 3 — auto-start.** Activation rule + guardrails + `initial_task` consistency +
  the targeted `task_ready` event so an assigned blocked task's readiness reaches its owner.

Auto-start consumes the daemon's wakes, so Phases 2–3 ship together; Phase 0 is independent
and immediate.

---

## 2. Daemon architecture

**Where it runs:** the **host**, not Docker. It must shell out to `tmux send-keys` (the
human's terminal multiplexer) and `claude -p` (the human's Claude CLI) — neither exists
inside the portal container. So it ships as an `orcha notifier` CLI subcommand (sibling of
`orcha watch`), started by the human (or a launchd/systemd/cron unit). One daemon per host
serves every agent in the (1:1:1) container.

**Event source — reuse, do not duplicate.** The daemon reads the existing `agent_events`
table directly over the localhost-mapped Postgres port (creds `orcha:orcha`, port from
`.claude/orcha.json`). No new event channel. DB-direct (vs. the API) because the daemon is
host-side infra at the same trust level as the portal and needs a cheap, single, indexed
range scan per tick (`idx_agent_events_key_ts`). The API path remains available as a fallback.

**Per-agent wake cursor.** New table `agent_wake_state(agent_id PK, delivered_ts DOUBLE,
last_woken_at, last_wake_kind, last_wake_event)`. Each tick, for every `wake_enabled` agent:
1. `SELECT max(ts)` of `agent_events WHERE event_key = agent_id AND ts > delivered_ts`
   (plus the targeted `task_ready` rows, see §5) and the count of such events.
2. Separately, find **auto-startable** tasks (the §4 rule) assigned to the agent.
3. If there is actionable pending work AND the agent is **quiescent** (debounce, below),
   issue ONE coalesced wake via §3 transport; record `last_woken_at`; advance `delivered_ts`
   to the max ts handled.
4. Log a `wake` row to the `events` audit table for portal visibility.

**Debounce / no wake-storms.** (a) Coalesce all pending events for an agent into a single
wake. (b) Per-agent cooldown (default 15s) — don't re-wake inside the window. (c) Quiescence:
don't wake an agent that is plainly mid-turn. v1 heuristic: `tmux send-keys` only lands at a
prompt — keystrokes injected mid-turn queue harmlessly until Claude's next prompt, so a
duplicate wake to a busy session is a no-op in practice. We additionally skip if
`last_heartbeat_at` is within the last few seconds (active turn). Documented tradeoff; the
cron stopgap shares the exact same debounce/cursor logic.

**Tick interval:** default 2s for the daemon (cheap indexed scan); the cron stopgap runs
once per the cron cadence (≤60s).

---

## 3. Reachability registry + wake transports

**Schema — new table `agent_reachability`:**
```
agent_id        UUID PK REFERENCES agents(id)
wake_enabled    BOOLEAN NOT NULL DEFAULT true     -- ON by default; disabling is the opt-out
tmux_target     TEXT        -- "session:window.pane" for live-context wakes (send-keys)
headless_cwd    TEXT        -- project dir for out-of-band `claude -p` admin/inbox wakes
headless_flags  TEXT        -- extra flags for the headless invocation (model, etc.)
updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
```
(Reachability is volatile and 1:1 with an agent, so a side table — not columns on `agents` —
keeps the hot `agents` row small and lets SessionStart upsert it freely.)

**Recorded at registration** (`/orcha-register-agent`) and **refreshed at SessionStart**
(coordinated with Vault, Epic C — the tmux pane changes every session). The skill captures:
`tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'` (empty if not under
tmux) and the project cwd. New endpoint: `POST /api/agents/{aid}/reachability`
`{tmux_target?, headless_cwd?, headless_flags?, wake_enabled?}` (upsert). A
`GET` companion for the daemon, or it reads the table directly.

**Transport 1 — tmux send-keys (live-context wake, preferred when a tab is open):**
```
tmux send-keys -t <tmux_target> -l "<wake prompt>"
tmux send-keys -t <tmux_target> Enter
```
Pre-check the pane exists and is running `claude` (`tmux list-panes -F '#{pane_current_command}'`).
The wake prompt is a short directive, e.g.:
`[orcha wake] N new event(s)/ready task(s). Run /orcha-listen --alias <A>, then auto-start your assigned ready task per the auto-start rule.`
This injects a turn into the idle-but-open session — the agent then does the claim+work
itself (daemon stays non-AI).

**Transport 2 — headless `claude -p` (out-of-band admin/inbox wake, no live tab):**
```
( cd <headless_cwd> && claude -p "<wake prompt>" <headless_flags> )
```
One-shot, for draining inbox / accepting task requests when the agent's tab is closed.
Bounded by the agent's `turn_budget`; never verifies. Chosen only when no live tmux pane is
found.

**Selection:** live tmux pane present & running claude → Transport 1; else Transport 2 (if
`headless_cwd` set); else log "unreachable" to the audit and leave for the human (portal
shows the pending wake). `wake_enabled=false` → skip entirely (the documented opt-out).

---

## 4. Auto-start activation rule + guardrails

**An agent auto-claims and begins task T iff ALL hold:**
1. T is **assigned** to this agent (an `agent_tasks` row exists), and
2. T is **ready**: `status='ready'`, or assigned-and-all-deps-`completed` (not `pending`/
   `blocked` on unmet deps, not already `in_progress` elsewhere), and
3. **no explicit human wait-instruction / HOLD** on the agent or task (Epic B; see §6), and
4. container `status='active'` (**not** `paused` — respects `/orcha-pause`), and
5. `agent.turns_used < turn_budget` (don't auto-start an exhausted agent), and
6. `agent.status <> 'terminated'`.

**Mechanics.** The daemon does **not** run the work — it wakes the session with an auto-start
directive; the session executes the claim via the existing atomic path
(`SELECT … FOR UPDATE SKIP LOCKED`, reused — no new claim semantics), so two concurrent wakes
can't double-claim. "Begins" = the woken session runs its normal work loop.

**Guardrails — auto-start NEVER:**
- self-certifies or calls verify — completion still routes through `/orcha-done` →
  `needs_verification` → human `/orcha-verify`. The gate is untouched.
- runs while the container is `paused`.
- overrides a human HOLD / wait-instruction.
- bypasses the turn budget.

**`initial_task` consistency.** Today `register_agent` force-creates the initial task as
`in_progress` + claimed regardless of context. Change: create it consistent with the rule —
if it meets the auto-start rule, claim+start (current behavior); otherwise create it `ready`
(or `pending` if it has deps) **with a stated reason** recorded in the task thread/`detail`
(e.g. "not auto-started: container paused" / "human wait-instruction set"). So the initial
task and a mid-run readied task behave identically.

---

## 5. Event types

The daemon consumes the **existing** `agent_events` names (no new channel):
`request_created`, `request_answered`, `request_closed`, `task_assigned`, `task_verified`,
`task_request_accepted/rejected`, `agent_suggested`, `agent_suggestion_decided`,
`task_ready`, `request_escalated`.

**One additive change — targeted `task_ready`.** Currently `task_ready` is emitted
container-wide only (`target_id NULL`) when `verify_task` unblocks downstream tasks. An
assigned-but-blocked task that becomes ready therefore produces no per-agent signal — the
owner is never told. Fix: in `verify_task`'s unblock loop, when a newly-ready task has an
assignee, **also** emit `task_ready` targeted at that assignee. Same event name, added
delivery key — not a new channel. This is the precise hook auto-start needs.

**Audit:** the daemon writes a `wake` `events` row per wake (kind=tmux|headless|unreachable,
event count, reason) so the portal can show "Forge woken 12:04 (2 events)".

---

## 6. Coordination (RESOLVED — frozen contracts)

- **Frame (Epic B — human-only HOLD).** HOLD lives on the AGENT, in a side table
  `agent_holds(agent_id PK, held_at, held_by_agent_id, reason)` — "held" == a row exists
  (no `tasks.status` entanglement, no column on the hot `agents` row; mirrors our
  reachability/wake-state pattern). My wake-scan adds `LEFT JOIN agent_holds h` and the rule
  becomes `should_wake AND h.agent_id IS NULL` (a PK join — negligible). Two FROZEN events on
  the existing bus (event_key=agent_id, no new channel): `agent_held {agent_id, task_id?,
  held_by, reason}` and `hold_lifted {agent_id, task_id?}`. `hold_lifted` wakes+resumes via
  the notifier exactly like `task_ready`. **Ownership split:** Frame owns the table + endpoints
  + the two events (their P4, not built yet); **I own the agent-side stop/rollback** in the
  wake/listen handler. I wire the one-line scan join + the listen-handler stop the moment
  `agent_holds` lands. Until then the §4 rule documents HOLD as a guard.

- **Vault (Epic C — SessionStart / tmux survival).** Vault owns the SessionStart `orcha resume`
  (rehydrate) command and will call my `POST /api/agents/{aid}/reachability {tmux_target,
  headless_cwd}` from inside it, right after `_resolve_any_binding` — so identity + pane/cwd
  resolve once per session, no duplicate hook. I do **not** add a SessionStart hook and do
  **not** re-derive identity (that resolver is the single source). Boundary confirmed:
  reachability = TRANSPORT state (mine); `agent_memory_digests` = REASONING state (Vault's);
  orthogonal, no overlap — tmux/cwd are live per-session env detected at upsert, persisted only
  in my reachability table.

Reusing `/wait` and `agent_events` as the single event substrate — not duplicating channels.

---

## 7. Test + demo plan

- **Schema/API tests** (pytest, against the template copy): reachability upsert + defaults
  (`wake_enabled` true), `wake_enabled=false` opt-out, targeted `task_ready` on unblock.
- **Auto-start rule tests:** truth table for the 6 conditions — assigned+ready→start;
  paused→no; HOLD→no; budget-exhausted→no; blocked deps→no. `initial_task` consistency in
  each context. Verification gate untouched (auto-started task still lands in
  `needs_verification`, never `completed`, on `/orcha-done`).
- **Wake transport tests:** transport selection + prompt construction with `tmux`/`claude`
  shimmed (a fake binary on `PATH` capturing argv) — assert the exact send-keys / `claude -p`
  invocations and debounce/cooldown behavior, no real terminals.
- **Stopgap demo (DoD):** register an idle agent (no live loop), assign it a task / file a
  request → show the event sits unhandled; run `orcha notifier --once` → show it issued the
  wake (captured via the shim / `--dry-run` log) and advanced the cursor. This is the
  "demonstrably catching previously-missed events" proof.

All schema/portal edits land in BOTH `orcha-cli/.../templates/` (source of truth for tests)
and the live `.orcha/` copy; `conftest.APP_TABLES` updated for new tables. Awaiting human
`/orcha-verify`.
