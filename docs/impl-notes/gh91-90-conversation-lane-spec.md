# Implementation contract — GH #91+#90 conversation/work lane split (CLEAN plan)

This is the single source of truth for the PR. Every file's changes MUST match the names/shapes
here. Derived from the 11-round CLEAN plan on GH issue #91. Lane values are standardized to
`'work'` | `'conversation'` EVERYWHERE (worker_runs.lane, embodiment_tokens.lane, wake claim lane).

## Canonical names (do not vary spelling)
- Lane values: `work`, `conversation`.
- Env var injected into every spawned worker's process env: `ORCHA_RUN_TOKEN`.
- Env marker for conversation embodiments: `ORCHA_CONVERSATION_WORKER=1`.
- HTTP header carrying the token on gated calls: `X-Orcha-Run-Token`.

## Migration 030 (DONE — `030_conversation_lane.sql`)
- `agent_wake_state`: `conv_lease_until`, `conv_lease_kind`, `conv_preempt_requested_at`,
  `conv_preempt_for`, `conv_delivered_ts` (double precision), `conv_last_woken_at`,
  `work_last_heartbeat_at`, `conv_last_heartbeat_at`.
- `worker_runs.lane` TEXT NOT NULL DEFAULT 'work' CHECK IN ('work','conversation'), backfilled
  (`wake_event='conversation_turn'` -> conversation, else work).
- `embodiment_tokens(run_token PK, agent_id, lane CHECK, kind, run_id FK worker_runs ON DELETE
  CASCADE, pid, created_at, revoked_at)` + partial indexes on agent_id / run_id WHERE revoked_at
  IS NULL.

## Server (main.py) contract

### Lane resolution
- `WakeClaim` gains `lane: Optional[str] = Field(default=None, pattern="^(work|conversation)$")`.
  When None, derive: `conversation` if `lease_kind=='resident'` OR `kind=='conversation'`, else `work`.
- `WakeAck` gains `lane: Optional[str] = None` (default None -> treat as `work` for backward compat).
- `WorkerRunStart` gains `lane: str = Field(default="work", pattern="^(work|conversation)$")` (validated;
  the single insert choke point) and `token_id: Optional[str]` (the run_token to bind, if any).

### Two lease slots on the one agent_wake_state row
- WORK lane uses existing columns: `wake_lease_until`, `lease_kind`, `preempt_*`, `delivered_ts`,
  `last_woken_at`, and NEW `work_last_heartbeat_at`.
- CONVERSATION lane uses: `conv_lease_until`, `conv_lease_kind`, `conv_preempt_*`,
  `conv_delivered_ts`, `conv_last_woken_at`, `conv_last_heartbeat_at`.
- `wake_claim(lane)`: branch — the conditional single-flight insert/update targets that lane's
  `*_lease_until` / `*_lease_kind`. The `NOT EXISTS(running worker_run)` belt is scoped
  `AND wr.lane = <claim lane>`. Preempt/yield stays on the WORK path only (live-vs-resident is a
  work-terminal-vs-conversation concept; after the split a live terminal no longer needs to preempt
  a conversation resident, so preempt applies within the work lane only — a claim in the
  conversation lane never sets preempt).
  NOTE: resident is a CONVERSATION-lane embodiment; a live terminal is WORK-lane. So the
  historical preempt (`live` preempts idle `resident`) is now cross-lane and no longer needed —
  they coexist. Keep the preempt columns but the preempt PATH becomes a no-op that never triggers
  (documented); do NOT delete it (out of scope, Open Q3).
- `wake_renew(lane)`: extend the matching slot's `*_lease_until`; bump ONLY that lane's heartbeat
  (`work_last_heartbeat_at` or `conv_last_heartbeat_at`). Keep bumping `agents.last_heartbeat_at`
  too (portal liveness) but the work-idle gate no longer reads it.
- `wake_ack(lane)`: `release_lease` NULLs ONLY the matching lane's lease columns; advance ONLY that
  lane's `delivered_ts`/`last_woken_at` (`conv_*` for conversation). The running->orphaned
  reconcile filters `AND lane = <released lane>`.

### wake_scan (WORK lane is what should_wake governs)
- Compute per-lane: `work_lease_active` (wake_lease_until live), `conv_lease_active`
  (conv_lease_until live). `embodiment_running` splits into `work_embodiment_running`
  (EXISTS running worker_run WHERE lane='work') and `conv_embodiment_running`.
- WORK idle: `idle_seconds` from `work_last_heartbeat_at` (NULL -> idle=true). Cursor/cooldown from
  work `delivered_ts`/`last_woken_at`.
- `has_work` excludes bare `conversation_turn` for the work lane: add
  `_WORK_NON_WAKING_EVENTS = _NON_WAKING_EVENTS + ("conversation_turn",)` and use it for the work
  pending count.
- NEW uncapped signal on the candidate: `has_pending_task_request` =
  `EXISTS(SELECT 1 FROM requests WHERE target_id=<aid> AND type='task' AND status='open')`.
  Fold into `has_work` (`... or has_pending_task_request`). Add a reason branch.
- `should_wake = active and wakes_enabled and wake_enabled and has_work and work_is_idle and
  not work_in_cooldown and not work_lease_active and not work_embodiment_running`. It NO LONGER
  references the conversation lane.
- Suppression gate: attach `triage_hint` only when `not has_pending_task_request` (owed task -> no
  hint, always full-boot).
- Candidate dict gains: `has_pending_task_request`, and lane-split fields for debug.

### reap_orphan_leases (two independent lane branches)
- WORK branch: idle keyed on `work_last_heartbeat_at`; release only `wake_lease_until`+`lease_kind`;
  reconcile only `worker_runs.lane='work'`; NULL-heartbeat never reaped; `> now()` live guard.
- CONVERSATION branch: idle keyed on `conv_last_heartbeat_at`; release only `conv_lease_until`+
  `conv_lease_kind`; reconcile only `worker_runs.lane='conversation'`.
- Legacy single-lane rows (work heartbeat NULL because never split) reap as before via the work
  branch only if they have a work lease.

### embodiment_tokens endpoints + guard
- `POST /api/agents/{aid}/embodiment-tokens` body `{lane, kind}` -> mint
  `run_token = secrets.token_urlsafe(32)`, INSERT (run_id NULL, pid NULL), return
  `{run_token, token_id}` (token_id = run_token itself; there is no separate id column — use
  run_token as the handle, call the return field `token_id` = run_token for the daemon's bind call).
- `POST /api/embodiment-tokens/{token}/revoke` -> set revoked_at=now() WHERE run_token=token AND
  revoked_at IS NULL (idempotent) -> `{revoked: bool}`.
- Helper `_require_work_lane(cur, aid, token)`: SELECT lane FROM embodiment_tokens WHERE
  run_token=token AND agent_id=aid AND revoked_at IS NULL; raise HTTPException(403, ...) if no row
  OR lane != 'work'. Token read from header `X-Orcha-Run-Token` (FastAPI `Header(default=None,
  alias="X-Orcha-Run-Token")` — but FastAPI header param name is `x_orcha_run_token`).
- Helper `_revoke_tokens_for_runs(cur, run_ids)`:
  `UPDATE embodiment_tokens SET revoked_at=now() WHERE run_id = ANY(%s) AND revoked_at IS NULL`.

### Bind token at run-create
- `start_worker_run`: insert `lane` into worker_runs; if `body.token_id` present, after insert do
  `UPDATE embodiment_tokens SET run_id=<new run_id>, pid=<body.pid> WHERE run_token=<token_id>`.

### Server revoke on EVERY run-terminal transition (call `_revoke_tokens_for_runs`)
- `finish_worker_run` (exited/killed): revoke WHERE run_id=[run_id].
- `wake_ack` reconcile (running->orphaned): revoke the reconciled run_ids.
- `reap_orphan_leases` (both branches, running->orphaned): revoke reconciled run_ids.
- Container dead-pid sweep endpoint that sets rows orphaned/killed (find it): revoke those run_ids.
- Unbound-token backstop (piggy-back on reap_orphan_leases): revoke embodiment_tokens WHERE
  run_id IS NULL AND revoked_at IS NULL AND created_at < now() - interval '2 minutes'.

### Gate the WORK-lane-only endpoints with `_require_work_lane`
The four task-lifecycle-advancing endpoints (find exact routes):
1. `POST /api/agents/{aid}/next` (claim ready task).
2. The accept-to-`working` transition behind `/orcha-accept-task` (agent_tasks status -> 'working').
3. `POST /api/tasks/{tid}/done`.
4. Task `release`.
Dispatch endpoints (create task, create/answer/close request, post task-thread message) stay
UNGATED. A missing/invalid/conversation token on a gated endpoint -> 403. A human never reaches
these (already kind gated). Because a human live terminal legitimately works tasks, the live
terminal is minted a WORK token (terminal_bridge), so it passes.

## Notifier (notifier.py) contract
- `CONVERSATION_LANE_DIRECTIVE` constant near `HUMAN_COMMS_GUARDRAIL`. Text: the agent is the
  conversation responder; answer quick asks inline; for anything that will take >~3-4 min or touch
  code/tests/PRs/long investigation, CREATE an assigned task (clear title/description/DoD +
  protocol that says to POST findings back to the task thread), reply with a one-line ack + the
  task link, and STOP — do not do the work inline. Judge up front OR mid-flight.
- `format_persona(..., lane="work")`: when lane=='conversation', append CONVERSATION_LANE_DIRECTIVE.
- `_build_persona(..., lane="work")`: thread through.
- `_wrap_conversation_turn(content) -> str`: prepend one short STABLE reminder sentence.
- Resident cold boot -> `_build_persona(lane="conversation")`; warm feed wraps content with
  `_wrap_conversation_turn`; Codex conversation -> lane="conversation" + prompt-builder edits.
- `_conversation_worker_prompt` / `_codex_resume_prompt`: replace "do not post through task/request
  endpoints unless the human explicitly asked" with the dispatch directive.
- Token mint-before-Popen at every run-creating spawn site; inject `env["ORCHA_RUN_TOKEN"]`.
  Lane per site: checkpoint_respawn -> work; tick ephemeral -> WORK if
  `has_pending_task_request` OR `has_task_request` OR auto-start/ready-task OR wake_task_id else
  conversation; Codex resident -> conversation; Claude resident -> conversation; drain sidecar ->
  NO token.
- `_retire_headless` / `_retire_resident` helpers: revoke stored token then pop. Route EVERY
  live_workers.pop / live_residents.pop through them. Store token at registration.
- Pass `lane` on every wake-claim / wake-renew / wake-ack body (audit all sites).
- `build_wake_prompt`: `has_task_request = any(...) or bool(cand.get("has_pending_task_request"))`.
- `decide_wake_tier`: short-circuit at the very top —
  `if (cand or {}).get("has_pending_task_request"): return {"tier":"full","reason":"owed task request — full boot"}`.
- `decide_wake_suppression`: return None (wake) immediately when `cand.get("has_pending_task_request")`.
- Retire the drain sidecar spawn + `inbox_drain_yield` + `auto_wake_yield` work-teardown (the work
  lane now drains via wake_scan). Keep the functions if referenced elsewhere but stop the resident
  from tearing down its lease for work.
- `start_worker_run` POST body now carries `lane` + `token_id`.
- `pending_revokes` best-effort retry list for failed revoke POSTs.

## terminal_bridge.py contract
- Mint a WORK token (kind='live') at session start before building PTY env; inject
  `env["ORCHA_RUN_TOKEN"]`.
- `start_live_run` posts real PTY `pid` + `token_id` so the run binds the token and the dead-pid
  sweep does not false-orphan an active terminal.
- Bind-failure (/runs returns None) -> revoke the minted token, continue token-less/degraded.
- Revoke the token in `_retire_warm` (both close paths funnel here).

## Skills / client
- `orcha-next.md`, `orcha-accept-task.md`, `orcha-done.md`, and the task-release skill: read
  `$ORCHA_RUN_TOKEN` and add `-H "X-Orcha-Run-Token: $ORCHA_RUN_TOKEN"` (omit header if unset).
- PreToolUse backstop in the worker settings template: when `ORCHA_CONVERSATION_WORKER=1`, block
  the task-claim/mutation path, allow dispatch (task create/assign, conversation reply/post).

## Tests
`tests/test_conversation_lane.py` (lane coexist, conv-lease-does-not-suppress-work, work-lease-does,
lane-scoped release, per-lane renew, backward-compat, work-wakes-despite-conv-heartbeat R3-1,
conversation_turn-not-waking-work R2-2, lane-scoped single-flight belt R2-3, cursor-not-swallowed
+ cooldown-not-crossed R2-4, lane-isolated reaping R4-2).
`tests/test_conversation_dispatch.py` (persona directive present/absent, warm-turn wrapper, Codex
prompt directive, dispatch shape create+assign publishes task_assigned).
`tests/test_embodiment_tokens.py` (mint/revoke, _require_work_lane 403 matrix {missing, unknown,
revoked, conversation} x each gated endpoint, work token 200, dispatch endpoints open under a
conversation token, bind-at-run-create, server-revoke-on-finish/orphan, has_pending_task_request ->
WORK across eligibility/suppression/prompt/tier, decide_wake_tier short-circuit).
Run with the `.venv-test` pytest per docs/orcha-test-runbook.md.
