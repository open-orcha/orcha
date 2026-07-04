# Issue #122 — Agent self-scheduled one-shot wake with restored task context

> **Status: PLAN (design/implementation reference). No feature code in this PR.**
> GitHub issue: [#122](https://github.com/open-orcha/orcha/issues/122) (OPEN, URGENT).
> Author: CodeCleanupAgent. Reviewer chain: Code Reviewer → Kedar (merge).
> All `file:line` citations verified against `origin/main` @ `46639d2` (2026-07-04).
>
> This reconciles an earlier plan by Informer that a Code Reviewer marked
> CLEAN-for-implementation on 2026-07-03 (review ref `4d996beb`). That draft lived only in
> Informer's worktree and was never committed or PR'd — it is now lost. This is a fresh,
> re-grounded rewrite that carries forward the two blockers that review fixed (the wake-ack
> **clear-only-if-injected** conditional, and the **migration slot** number) plus its
> non-blocking notes (graceful protocol mismatch, dedicated `build_wake_prompt` branch,
> negative-path test).

## 1. Problem (from the issue)

An ephemeral task worker blocked on an external step — a CI run, a build, a test suite, a
deploy — has no good way to just *wait and check back*. Today it must either:

- burn its own session busy-polling/sleeping inline (wastes tokens, risks the stall
  watchdog killing it), or
- go idle and rely on the generic clock-driven auto-wake, which is **human-set, recurring,
  and per-agent** — not "wake me for *this task* in *N* minutes" — set via
  `PATCH /api/agents/{aid}/auto-wake` (`update_agent_auto_wake`,
  `orcha-cli/orcha_cli/templates/portal/main.py:4102-4132`), which is **human-authority
  gated** (`_require_kind(cur, body.actor_agent_id, ("human",))`, main.py:4114) and recurring
  (`auto_wake_interval_secs`, never a one-shot).

And when a wake does fire, there is no explicit *resume point*: since #33 the wake surfaces the
task's title + description + DoD (`_render_task_body`, `orcha-cli/orcha_cli/notifier.py:850`),
but that is **static task info**, not "I was mid-way, waiting on step X — run `gh pr checks 121`".

## 2. Goal & scope

Give an **ephemeral work-lane** task worker an agent-callable primitive to:

1. **Schedule its own one-shot wake** ("wake me in N minutes") tied to the task it is
   currently working on; and
2. **Attach a small resume-context payload** (what it is waiting on + how to check it) that is
   **auto-injected at the scheduled wake**, at the same seam as the #33 task-body injection, so
   it resumes straight into the wait-point instead of re-investigating.

**In scope:** the ephemeral task-worker (WORK) lane only — the lane split from #90/#91.
**Out of scope:** resident/chat (conversation) sessions; the reactive watchdog/stall path (#61);
admin cron *tasks* (#27); any change to the human-set recurring auto-wake (#266). This is the
proactive "I am yielding because I'm blocked on an external process" case only.

## 3. How the existing wake machinery works (grounding)

The self-wake threads through four existing, verified seams. Understanding them is the plan:

**(a) `wake_scan` — the wake decision** (`main.py:4811`, endpoint
`GET /api/containers/{cid}/wake-scan`). For each AI agent it computes `has_work` and
`should_wake`. The recurring auto-wake is exactly the pattern we extend — an opt-in OR-term:

```
auto_interval    = a["auto_wake_interval_secs"]                        # main.py:5026
secs_since_woken = a["secs_since_woken"]                               # main.py:5027
auto_wake_due    = bool(auto_interval is not None
                        and (secs_since_woken is None
                             or secs_since_woken >= auto_interval))     # main.py:5028-5030
has_work = pending > 0 or len(auto_tasks) > 0 or auto_wake_due \
           or has_pending_task_request                                  # main.py:5031
should_wake = bool(active and wakes_enabled and wake_enabled and has_work
                   and is_idle and not in_cooldown and not lease_active
                   and not embodiment_running)                          # main.py:5045-5047
```

The clock anchor `secs_since_woken` is `now() - w.last_woken_at` off `agent_wake_state`
(main.py:4874-4878). The candidate dict the notifier reads is built at main.py:5110-5146
(`wake_task_id` at 5113; `auto_wake_due` / `auto_wake_interval_secs` at 5120).

**(b) `wake_task_id` resolution** decides which task's body/protocol the wake loads. In
`wake_scan` it is set by `_collect_directed_messages` first (main.py:4957), then falls back to a
pending answer's `originating_task_id` (main.py:4969-4983). **This is the load-bearing
precedence for the correctness fix in §6.**

**(c) The #33 injection seam.** The notifier fetches `GET /api/agents/{aid}/protocol`
(`get_agent_protocol`, main.py:4662), passing the wake's `task_id=cand["wake_task_id"]`
(`_build_persona` call at notifier.py:3058-3059). That endpoint returns
`{task_id, title, description, definition_of_done, protocol}` for the resolved task
(main.py:4719-4721). `format_persona` (notifier.py:896) renders the body via `_render_task_body`
(notifier.py:850) and appends it ahead of the RULES (notifier.py:928-932). **This is exactly
where the resume-context must ride.**

**(d) The wake-ack cursor + clock.** `wake_ack` (`POST /api/agents/{aid}/wake-ack`,
main.py:5161) advances `delivered_ts` and stamps `last_woken_at` (the WORK-lane branch at
main.py:5206-5241). `stamp_woken=false` deliberately *preserves* the prior clock so an
idle-yield does not reset the cadence (main.py:5216-5218; `WakeAck.stamp_woken`, main.py:4743).
The final ephemeral ack is posted by the daemon at notifier.py:3208-3211.
`derive_wake_event` (notifier.py:1231) labels the wake; `build_wake_prompt` (notifier.py:540)
writes the directive, with a dedicated `auto_wake_due` heartbeat branch at notifier.py:563-564.

## 4. Design overview

A new **one-shot, per-task, agent-callable** wake, stored on `agent_wake_state` alongside the
existing WORK-lane wake state, picked up as a new OR-term in `wake_scan`, and surfaced through
the **same** `wake_task_id` → protocol → `format_persona` path so the resume-context injects at
the #33 seam. It fires **once**, then clears — but **only when the context actually rode the
injection** (§6).

```
worker (blocked on CI)                server                              notifier daemon
─────────────────────                 ──────                              ───────────────
POST /agents/{aid}/self-wake  ──▶  set agent_wake_state.self_wake_at,
  {resume_at, task_id,               self_wake_task_id, self_wake_context
   context}  (run-token gated)        (one-shot; WORK lane)
worker EXITS (yields session)
        ⋯ N minutes ⋯
                                   wake_scan: self_wake_due OR-term  ──▶  candidate carries
                                     folds into has_work;                 self_wake_* + wake_task_id
                                     wake_task_id := self_wake_task_id     = self_wake_task_id
                                     (when not overridden, §6)
                                                                     ──▶  _build_persona → GET
                                   get_agent_protocol returns the          /protocol(task_id=…)
                                     task body + resume_context      ◀──   renders resume-context
                                                                           at the #33 seam;
                                                                           build_wake_prompt
                                                                           self-wake branch
                                   wake-ack {clear_self_wake:true}   ◀──   ONLY if the context
                                     clears the one-shot row               actually rode (§6)
```

## 5. Data model / migration

**Next free migration slot = `031`.** Verified: highest applied is
`orcha-cli/orcha_cli/templates/migrations/030_conversation_lane.sql`;
`029_close_accepted_requests.sql.pending` is parked (not applied). If `031` is taken by the time
this is implemented, use the next free number — re-check the directory at implementation time.

New migration `031_agent_self_wake.sql` adds three nullable columns to `agent_wake_state`
(the table that already holds `last_woken_at`, `delivered_ts`, and the WORK-lane lease columns —
same lifecycle, so co-locating avoids a parallel table + join):

```sql
ALTER TABLE agent_wake_state
  ADD COLUMN self_wake_at      timestamptz,          -- one-shot resume_at; NULL = none scheduled
  ADD COLUMN self_wake_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN self_wake_context text;                 -- small free-text payload (bounded, see §7)
-- Partial index so wake_scan's due-check stays cheap.
CREATE INDEX IF NOT EXISTS idx_agent_wake_self_due
  ON agent_wake_state (self_wake_at) WHERE self_wake_at IS NOT NULL;
```

Rationale for columns-on-`agent_wake_state` over a new table: one-shot + at most one pending
self-wake per agent WORK lane (the same single-flight shape as the existing wake state), so a row
per agent is exact; `ON DELETE SET NULL` means a deleted task auto-cancels a stale self-wake.
Free text (not JSONB) keeps the payload a plain human/agent-readable string that renders directly
into the wake prompt; a length cap (§7) is enforced at the API layer.

## 6. Server changes (`main.py`)

**6.1 New endpoint — `POST /api/agents/{aid}/self-wake`** (agent-callable, ephemeral WORK lane
only). Mirrors the shape of `update_agent_auto_wake` (main.py:4102) but is **AI-callable, not
human-gated**, and one-shot/per-task.

- **Auth scoping (ephemeral WORK lane only).** Unlike the auto-wake endpoint's
  `_require_kind(..., ("human",))` (main.py:4114), this requires the caller to be the AI agent
  itself operating its WORK embodiment. Gate on the process-scoped embodiment token
  (`X-Orcha-Run-Token`, minted per WORK-lane spawn at notifier.py:3102 `_mint_embodiment_token`,
  lane `"work"`), and reject a `conversation`-lane token — a resident/chat session cannot
  self-schedule a task wake. Fall back to `_require_kind(..., ("ai",))` + participant check when
  no token layer is present, consistent with existing AI-gated routes (e.g. the `("ai",)` gate
  at main.py:3570). *Confirm the exact token-verification helper at implementation time* — the
  WORK-lane token plumbing lands via #90/#91; verify the helper name and that a conversation
  token is distinguishable before wiring the reject.
- **Body** (`SelfWakeSet` Pydantic model): `resume_at` (or `delay_secs`, int ≥ 60 — reuse the
  same 60s floor the auto-wake DB CHECK enforces, main.py:4107), `task_id` (must be an
  in_progress task the agent participates in — reuse `_agent_participates_in_task`, used at
  main.py:4698), `context` (str, bounded — see §7). Validate `task_id` participation so an agent
  cannot schedule a wake that would load another task's body.
- **Effect:** `UPDATE agent_wake_state SET self_wake_at=%s, self_wake_task_id=%s,
  self_wake_context=%s WHERE agent_id=%s` (upsert, mirroring the `ON CONFLICT` pattern at
  main.py:5211-5212). Writes an audit `log_event` (`self_wake_scheduled`) exactly as
  `update_agent_auto_wake` logs `auto_wake_updated` (main.py:4127-4128).
- **Idempotency:** a second call before the first fires **replaces** it (one pending self-wake
  per agent). Optionally a `DELETE`/clear form (set columns NULL) so a worker that unblocks early
  can cancel.

**6.2 `wake_scan` — pick up due self-wakes** (`main.py:4811`).

- Add to the candidate SELECT (near main.py:4874-4878, alongside `secs_since_woken`):
  `w.self_wake_at`, `w.self_wake_task_id`, `w.self_wake_context`, and a computed
  `(w.self_wake_at IS NOT NULL AND w.self_wake_at <= now()) AS self_wake_due`.
- Add `self_wake_due` as an OR-term to `has_work` (main.py:5031) — symmetric with
  `auto_wake_due`. The existing gates (`is_idle`, `not in_cooldown`, `not lease_active`,
  `not embodiment_running`, main.py:5045-5047) apply unchanged. The 60s floor sits well above the
  15s cooldown / 30s min-idle, so no gate conflict (same reasoning the auto-wake note gives at
  main.py:5023-5024).
- **`wake_task_id` binding (correctness core).** When `self_wake_due` and no directed message or
  answer already claimed a `wake_task_id` (i.e. the current `wake_task_id is None` after the
  existing resolution at main.py:4957-4983), set `wake_task_id := self_wake_task_id` **and** mark
  the candidate `self_wake_injected = True`. If a directed message for *another* task already won
  `wake_task_id` (main.py:4957), **do NOT override it** and leave `self_wake_injected = False` —
  the competing task's work takes this wake, the resume-context does not ride, and the self-wake
  row must survive to re-fire (see 6.4). This is the exact blocker the earlier review caught.
- Surface on the candidate dict (main.py:5110-5146): `self_wake_due`, `self_wake_context`,
  `self_wake_injected`, and `self_wake_task_id`, next to the existing `auto_wake_due` fields
  (main.py:5120). Add a `reason` bit ("scheduled self-wake for task …") beside the auto-wake bit
  at main.py:5086-5087.

**6.3 `get_agent_protocol` — carry the resume-context** (`main.py:4662`).

- When the resolved `task_id` matches a scheduled `self_wake_task_id` for this agent, include
  `resume_context` in the response next to the #33 body fields (main.py:4719-4721). Because the
  notifier passes `task_id=wake_task_id` (notifier.py:3058-3059) and §6.2 binds `wake_task_id`
  to `self_wake_task_id` only when the self-wake wins, the context is served only on the right
  wake.
- **Graceful mismatch (non-blocking note carried forward):** if the requested `task_id` does not
  match the pending `self_wake_task_id` (a competing task won), simply **omit** `resume_context`
  — never 4xx. The endpoint already returns `{task_id: null, protocol: null}` for an unresolved
  wake (main.py:4716-4717); the resume-context is purely additive.

**6.4 `wake_ack` — clear the one-shot ONLY when it was injected** (`main.py:5161`).

- Add `clear_self_wake: bool = False` to the `WakeAck` model (main.py:4724), documented like
  `stamp_woken` (main.py:4743).
- In the WORK-lane branch (main.py:5206-5241), when `clear_self_wake` is true, set
  `self_wake_at=NULL, self_wake_task_id=NULL, self_wake_context=NULL` in the same UPDATE (so the
  one-shot fires exactly once). When false, **leave the columns intact** so the row re-fires on
  the next scan.
- **Who sets it:** the daemon sets `clear_self_wake=true` on its ack **only when the self-wake
  actually rode this wake** — i.e. the candidate's `self_wake_injected` was true and the persona
  it built resolved that task (§7). If a directed message overrode `wake_task_id`
  (`self_wake_injected=False`), the ack leaves it unset → the row stays scheduled and re-fires
  cleanly next tick. This closes the silent-consumption hole: **the wait-point is never marked
  delivered unless the resume-context was surfaced.**

## 7. Notifier changes (`notifier.py`)

- **`derive_wake_event`** (notifier.py:1231): add a `self_wake` label in precedence order —
  after a real pending event and auto-start, alongside/above `auto_wake`
  (notifier.py:1237-1239). This is what stamps the wake-claim + worker_run.
- **`_render_task_body` / `format_persona`** (notifier.py:850 / 896): add a small
  `_render_resume_context(protocol)` that renders the `resume_context` string as a wake section
  **immediately after** the #33 task body (notifier.py:930-932), e.g.
  *"## Resuming — you scheduled this wake. You were waiting on: `<context>`. Check it first, then
  continue."* Rendered only when the protocol response carries `resume_context`.
- **`build_wake_prompt`** (notifier.py:540): add a dedicated **self-wake branch** parallel to the
  `auto_wake_due` heartbeat branch (notifier.py:563-564). When `cand["self_wake_due"]` and it
  won the wake, the directive says the worker *scheduled this check-back itself* and the context
  is in its "Your task"/Resuming section — not the generic "pending work". The generic
  don't-claim step-2 (notifier.py:640-644) is misleading here; give self-wake its own step-2
  ("resume the task you scheduled this wake for; re-check the external step; if still not ready,
  reschedule another self-wake and exit"), so a worker never re-derives.
- **`tick` — set `clear_self_wake`** (notifier.py:3040-3211): when the wake it is issuing is a
  self-wake that actually resolved the self-wake task (candidate `self_wake_injected` true and the
  persona built for `wake_task_id == self_wake_task_id`), pass `clear_self_wake=true` on the
  post-drain WORK-lane ack (the ack at notifier.py:3208-3211). Otherwise omit it. The run is
  attributed to `wake_task_id` exactly as today (notifier.py:3123).

## 8. CLI command

Add an agent-facing CLI (`orcha-cli`) wrapper — the primitive an agent actually calls — e.g.
`orcha self-wake --in 10m --task <task_id> --context "waiting on CI for PR #121, run gh pr checks 121"`
(and `orcha self-wake --cancel`). It POSTs `/api/agents/{aid}/self-wake` with the WORK-lane
run-token header (`X-Orcha-Run-Token`), resolving `aid` from `ORCHA_ALIAS`/the run context the
way existing CLI verbs do. A matching skill doc (`/orcha-self-wake`) so the primitive is
discoverable from the agent's skill list. *Confirm the CLI's token-header idiom at implementation
time* — note the known zsh `${VAR:+-H …}` leading-space pitfall (pass `-H "X-Orcha-Run-Token:
$TOK"` plainly quoted).

## 9. Test plan

Server (pytest, `.venv-test` per `docs/orcha-test-runbook.md`):

1. **Schedule + due pickup.** POST self-wake with `delay_secs=60`; before 60s `wake_scan` shows
   `self_wake_due=false` / no wake reason; after, `self_wake_due=true`, `has_work` true,
   `wake_task_id == self_wake_task_id`, `self_wake_injected=true`.
2. **Context injection.** `get_agent_protocol(task_id=self_wake_task_id)` returns
   `resume_context`; `format_persona` renders the resume section right after the #33 body.
3. **One-shot clear (happy path).** wake-ack with `clear_self_wake=true` nulls the three columns;
   the next `wake_scan` no longer reports `self_wake_due`.
4. **Negative path — competing directed task wins (the review's required teeth).** A directed
   `prompt`/`task_message` for **task B** is pending AND a self-wake for **task A** is due:
   assert `wake_task_id == B`, `self_wake_injected=false`, `resume_context` **omitted** from the
   protocol for B, and — after an ack **without** `clear_self_wake` — the self-wake row for A is
   **still scheduled** and re-fires on the next scan. (No silent consumption.)
5. **Auth scoping.** A `conversation`-lane token (or a human actor) is rejected; a WORK-lane
   token for the participating agent succeeds; a `task_id` the agent does not participate in is
   rejected.
6. **Idempotency / cancel.** A second schedule replaces the first; `--cancel` clears it.
7. **Gate interplay.** A live WORK lease / running embodiment / cooldown / non-idle each
   suppresses the self-wake exactly as it does other wakes (reuse the existing `wake_scan` gate
   tests).
8. **Graceful mismatch.** `get_agent_protocol` with a `task_id` that doesn't match the pending
   self-wake returns 200 with no `resume_context` (never 4xx).

Notifier (pure-function tests, the style of the existing `build_wake_prompt` /
`derive_wake_event` / `format_persona` tests): `derive_wake_event` returns `self_wake`;
`build_wake_prompt` self-wake branch text; `_render_resume_context` renders only when present.

## 10. Rollout

- **Additive & backward-compatible.** All new columns are nullable; every new field on the
  wake-scan candidate and `WakeAck` defaults off. An older notifier that ignores the new fields
  simply never schedules/clears a self-wake — no behaviour change. Ship the migration (`031`) and
  server first; the notifier + CLI changes light it up.
- **No new config/kill-switch needed** — the container-wide `wakes_enabled` kill-switch
  (main.py:4836-4838) and per-agent `wake_enabled` already gate *all* wakes, self-wakes included.
- **Docs:** add the `/orcha-self-wake` skill + a line in the wake section of the review protocol;
  cross-link #33 (injection seam), #61 (reactive watchdog — the complementary involuntary path),
  and #90/#91 (lane split this is scoped to).

## 11. Open questions for review

1. **Auth substrate.** Confirm the WORK-lane run-token verification helper and that a
   conversation-lane token is reliably distinguishable at the endpoint (depends on the #90/#91
   token plumbing landing). If not yet available, fall back to `_require_kind(("ai",))` +
   participant check and note the gap.
2. **Reschedule ergonomics.** Should a self-wake that fires but finds the external step *still*
   not ready require an explicit new `self-wake` call (current plan), or support an optional
   auto-reschedule/backoff? Plan keeps it explicit (one-shot) for simplicity; flag if a bounded
   auto-retry is wanted.
3. **Context size cap.** Proposed a modest cap (e.g. 2 KB) on `context`; confirm the bound and
   whether it should reuse an existing `MAX_*` constant.
