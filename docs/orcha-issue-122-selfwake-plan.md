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
>
> **Round 2 (this PR head).** Code Reviewer's round-1 verdict on PR #146 raised two blockers,
> both now addressed by moving from three columns on `agent_wake_state` (one pending wake per
> agent) to a dedicated **per-task `agent_self_wake` table** keyed `(agent_id, task_id)`:
> **(B1) stale rows never fire** — `wake_scan` joins the row to its task and requires
> `status='in_progress'` + participation, `ON DELETE CASCADE` removes rows for deleted tasks,
> and terminal transitions eagerly delete (§6.5); **(B2) a second schedule for a different task
> no longer clobbers the first** — one row *per task*, so task A's wake survives when task B is
> scheduled (§5, §6.1). Test plan gains the required cases (§9: 4, 9–12).
>
> **Round 3 (this PR head).** Code Reviewer's round-2 verdict raised two more blockers, both now
> fixed: **(ack-clear)** the wake-ack now carries a `self_wake_task_id` field — the `WakeAck` model
> had no task field and the daemon ack sent none, so the earlier "delete by the ack's `wake_task_id`"
> was not implementable; the ack now names the exact per-task row to clear (§6.4, §7). **(schedule
> validation)** the schedule endpoint validates the **same** `in_progress` + active-assignment
> predicate the due scan uses, instead of the looser `_agent_participates_in_task`, so it can no
> longer accept a wake that will never fire (§6.1, §9 item 5).

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

A new **one-shot, per-task, agent-callable** wake, stored in a dedicated `agent_self_wake` table
keyed `(agent_id, task_id)` (one pending row per task, so several concurrently-blocked tasks each
keep their own — see §5 rationale), picked up as a new OR-term in `wake_scan`, and surfaced
through the **same** `wake_task_id` → protocol → `format_persona` path so the resume-context
injects at the #33 seam. It fires **once**, then clears — but **only when the context actually
rode the injection** (§6.4), and it can **never fire for a task that is no longer `in_progress`**
(§6.2 join filter + §6.5 eager cleanup).

```
worker (blocked on CI)                server                              notifier daemon
─────────────────────                 ──────                              ───────────────
POST /agents/{aid}/self-wake  ──▶  upsert agent_self_wake row
  {resume_at, task_id,               (agent_id, task_id, resume_at,
   context}  (run-token gated)        context)  — one row PER task
worker EXITS (yields session)
        ⋯ N minutes ⋯
                                   wake_scan: earliest DUE row whose  ──▶  candidate carries
                                     task is in_progress + agent           self_wake_* + wake_task_id
                                     participates → self_wake_due;          = self_wake_task_id
                                     folds into has_work;                   (stale/non-active rows
                                     wake_task_id := self_wake_task_id       are filtered out, §6.2)
                                     (when not overridden, §6.2)
                                                                     ──▶  _build_persona → GET
                                   get_agent_protocol returns the          /protocol(task_id=…)
                                     task body + resume_context      ◀──   renders resume-context
                                                                           at the #33 seam;
                                                                           build_wake_prompt
                                                                           self-wake branch
                                   wake-ack {clear_self_wake:true}   ◀──   ONLY if wake_task_id ==
                                     DELETEs the (agent,task) row           self_wake_task_id, i.e.
                                     — other tasks' rows untouched          the context actually
                                                                           rode (§6.4)
```

## 5. Data model / migration

**Next free migration slot = `031`.** Verified: highest applied is
`orcha-cli/orcha_cli/templates/migrations/030_conversation_lane.sql`;
`029_close_accepted_requests.sql.pending` is parked (not applied). If `031` is taken by the time
this is implemented, use the next free number — re-check the directory at implementation time.

New migration `031_agent_self_wake.sql` creates a **dedicated table keyed per `(agent, task)`**,
*not* columns on `agent_wake_state`. (Round-1 review, blocker B2: an agent can have **several
in_progress tasks at once** — the protocol loader is explicit about not guessing the wrong one,
`orcha-cli/orcha_cli/notifier.py:1021-1025`, `main.py:4695-4715` — so a single per-agent slot
would silently drop task A's pending wake the moment task B scheduled one.)

```sql
CREATE TABLE agent_self_wake (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_id     uuid NOT NULL REFERENCES tasks(id)  ON DELETE CASCADE,   -- B1: deleted task ⇒ row gone
  resume_at   timestamptz NOT NULL,                 -- one-shot fire time (delay floor 60s, §6.1)
  context     text,                                 -- small free-text payload (bounded, §7)
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, task_id)                         -- one pending self-wake PER task; re-sched = upsert
);
-- wake_scan's due-scan reads this ordered by fire time; keep it cheap.
CREATE INDEX IF NOT EXISTS idx_agent_self_wake_due ON agent_self_wake (resume_at);
```

Why a table (and how it closes both round-1 blockers):

- **B2 — no silent loss across tasks.** `UNIQUE (agent_id, task_id)` means re-scheduling the
  *same* task upserts (one pending per task), while scheduling a *different* task inserts a
  **separate** row. Task A's wake is never clobbered by task B's. (`(agent, task)` is the exact
  grain the wake-load path already keys on, `main.py:4695-4715`.)
- **B1 — a stale/dead task can never fire.** `ON DELETE CASCADE` on `task_id` deletes the row
  outright when the task is deleted (no orphaned "wake with no valid task" the old
  `ON DELETE SET NULL` left behind). For the *non-delete* terminal transitions (done →
  `needs_verification`/`completed`, cancel → `cancelled`), the row lingers until cleaned, so the
  correctness guarantee is the `wake_scan` **join filter** (§6.2: task must be `in_progress` **and**
  the agent must still participate), backed by eager delete on those transitions (§6.5) and a lazy
  delete in scan (§6.2). Belt (filter) + suspenders (eager + lazy delete).
- **Context stays free text** (not JSONB): a plain human/agent-readable string that renders
  directly into the wake prompt; a length cap (§7) is enforced at the API layer.
- `ON DELETE CASCADE` on `agent_id` keeps the table clean if an agent row is ever removed.

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
  same 60s floor the auto-wake DB CHECK enforces, main.py:4107), `task_id`, `context` (str,
  bounded — see §7).
- **`task_id` validation MUST match the due-scan grain (round-2 blocker fix).** Do **not** reuse
  `_agent_participates_in_task` (main.py:1381-1396): its own docstring calls it "the LOOSER
  participant check" — it accepts the task **creator** and **any historical `agent_tasks` row**
  (`t.created_by_agent_id` OR any `agent_tasks` row, main.py:1389-1394), regardless of the task's
  status or whether the agent is still an active assignee. But the §6.2 due scan only ever fires a
  row whose task is `status='in_progress'` **and** whose agent has an active assignment
  (`assignment_status IN ('assigned','accepted','working')`). Validating with the looser helper
  would let the endpoint **accept a wake that can never fire** (e.g. a creator who never worked the
  task, or a task already in `needs_verification`). So the endpoint validates with the **same
  predicate the scan uses**:

  ```sql
  SELECT 1 FROM tasks t
    JOIN agent_tasks at ON at.task_id = t.id AND at.agent_id = %s
   WHERE t.id = %s AND t.container_id = %s
     AND t.status = 'in_progress'
     AND at.assignment_status IN ('assigned','accepted','working')
   LIMIT 1
  ```

  Reject (`409`/`422`) when it returns no row, so an agent can only schedule a self-wake for a task
  it is *actively working right now* — exactly the set the scan can fire. (Negative test: a
  creator / non-active participant / non-`in_progress` task is rejected, §9 item 5.)
- **Effect:** upsert one row **per `(agent, task)`** —
  `INSERT INTO agent_self_wake (agent_id, task_id, resume_at, context) VALUES (…)
  ON CONFLICT (agent_id, task_id) DO UPDATE SET resume_at=EXCLUDED.resume_at,
  context=EXCLUDED.context` (same `ON CONFLICT` idiom as the wake-state upsert at
  main.py:5211-5212). Writes an audit `log_event` (`self_wake_scheduled`) exactly as
  `update_agent_auto_wake` logs `auto_wake_updated` (main.py:4127-4128).
- **Idempotency (B2 semantics).** Re-scheduling **the same task** before it fires **replaces**
  that task's pending wake (upsert on the unique key). Scheduling a **different** task inserts a
  **separate** row — the first task's pending wake is preserved, not clobbered. Result: at most
  one pending self-wake *per task*, any number *per agent*.
- **Cancel form.** A `DELETE`/clear path so a worker that unblocks early can cancel: default
  `DELETE FROM agent_self_wake WHERE agent_id=%s AND task_id=%s` (this task only); an optional
  `--all` clears every pending self-wake for the agent.

**6.2 `wake_scan` — pick up due self-wakes, filtered to active tasks** (`main.py:4811`).

- **Due-row lookup with the active-task join (B1 correctness core).** Per agent, select the
  **earliest due** self-wake row *that is still valid* — a correlated subquery beside the
  candidate SELECT (near the `secs_since_woken` computation at main.py:4874-4878):

  ```sql
  SELECT sw.task_id, sw.context
    FROM agent_self_wake sw
    JOIN tasks t         ON t.id = sw.task_id
    JOIN agent_tasks at  ON at.task_id = sw.task_id AND at.agent_id = sw.agent_id
   WHERE sw.agent_id = a.id
     AND sw.resume_at <= now()
     AND t.status = 'in_progress'                         -- B1: never fire for a done/cancelled task
     AND at.assignment_status IN ('assigned','accepted','working')   -- B1: agent still participates
   ORDER BY sw.resume_at
   LIMIT 1
  ```

  The `t.status='in_progress'` + active-assignment join (`assignment_status IN
  ('assigned','accepted','working')` — the exact grain the wake-load path already uses at
  main.py:4709) is the **guarantee** that a stale row for a no-longer-active task can never wake
  the agent, independent of whether §6.5's eager cleanup ran.
  Expose `self_wake_task_id`, `self_wake_context`, and a computed `self_wake_due` (row present)
  from this subquery.
- **Lazy cleanup (backstop).** When the scan encounters a self-wake row whose task is *not*
  `in_progress` / not participated (it fails the join above but the row still exists), delete it
  opportunistically (`DELETE FROM agent_self_wake WHERE agent_id=%s AND task_id=%s`), so orphaned
  rows don't accumulate between terminal-transition cleanups (§6.5). Correctness never depends on
  this firing — the join already excludes it.
- Add `self_wake_due` as an OR-term to `has_work` (main.py:5031) — symmetric with
  `auto_wake_due`. The existing gates (`is_idle`, `not in_cooldown`, `not lease_active`,
  `not embodiment_running`, main.py:5045-5047) apply unchanged. The 60s floor sits well above the
  15s cooldown / 30s min-idle, so no gate conflict (same reasoning the auto-wake note gives at
  main.py:5023-5024).
- **`wake_task_id` binding.** When `self_wake_due` and no directed message or answer already
  claimed a `wake_task_id` (i.e. `wake_task_id is None` after the existing resolution at
  main.py:4957-4983), set `wake_task_id := self_wake_task_id`. If a directed message for *another*
  task already won `wake_task_id` (main.py:4957), **do NOT override it** — the competing task's
  work takes this wake and the self-wake row must survive to re-fire (§6.4).
- **`self_wake_injected` = task-id match (not "who set it").** Define
  `self_wake_injected = (wake_task_id == self_wake_task_id)`. This is true both when the self-wake
  bound `wake_task_id` *and* when a directed message for the **same** task independently won it
  (in which case the resume-context still injects for that task and should still clear). It is
  false only when a *different* task won — the exact silent-consumption blocker the earlier review
  caught. Drives the clear decision in §6.4/§7.
- Surface on the candidate dict (main.py:5110-5146): `self_wake_due`, `self_wake_context`,
  `self_wake_injected`, and `self_wake_task_id`, next to the existing `auto_wake_due` fields
  (main.py:5120). Add a `reason` bit ("scheduled self-wake for task …") beside the auto-wake bit
  at main.py:5086-5087.

**6.3 `get_agent_protocol` — carry the resume-context** (`main.py:4662`).

- When a pending `agent_self_wake` row exists for `(this agent, resolved task_id)`, include its
  `context` as `resume_context` in the response next to the #33 body fields (main.py:4719-4721) —
  a single lookup keyed on `(agent_id, task_id)`. Because the notifier passes
  `task_id=wake_task_id` (notifier.py:3058-3059), the context is served only for the task this
  wake actually resolved to.
- **Graceful mismatch (non-blocking note carried forward):** if there is no pending self-wake row
  for the requested `(agent, task_id)` (a competing task won, or none scheduled), simply **omit**
  `resume_context` — never 4xx. The endpoint already returns `{task_id: null, protocol: null}`
  for an unresolved wake (main.py:4716-4717); the resume-context is purely additive.

**6.4 `wake_ack` — clear the one-shot ONLY when it was injected** (`main.py:5161`).

- **The ack must carry the task id (round-2 blocker fix).** The current `WakeAck` model has **no
  task field** (main.py:4724-4749) and the daemon's ack payload sends none — only
  `{delivered_ts, kind, event, release_lease, lane}` (notifier.py:3212-3214). A **per-task**
  `agent_self_wake` table therefore cannot be cleared by "the ack's `wake_task_id`": that value is
  not on the ack. So add **two** fields to `WakeAck` (main.py:4724): `clear_self_wake: bool =
  False` (documented like `stamp_woken`, main.py:4743) **and** `self_wake_task_id: Optional[str] =
  None` — the exact task whose `(agent, task)` self-wake row just fired. Both default off, so an
  older notifier that sends neither changes no behaviour (§10).
- In the WORK-lane branch (main.py:5206-5241), when `clear_self_wake` is true **and**
  `self_wake_task_id` is a valid uuid, delete exactly that row:
  `DELETE FROM agent_self_wake WHERE agent_id=%s AND task_id=%s` bound to `(aid, self_wake_task_id)`
  — so exactly the `(agent, task)` that just fired is cleared and **every other task's pending
  self-wake is left intact** (the per-task grain). When `clear_self_wake` is false, or
  `self_wake_task_id` is missing/blank, leave all rows untouched so a not-yet-consumed self-wake
  re-fires on the next scan.
- **Who sets it:** the daemon sets `clear_self_wake=true` **and** `self_wake_task_id =
  cand["self_wake_task_id"]` on its ack **only when the self-wake actually rode this wake** — i.e.
  the candidate's `self_wake_injected` was true (`wake_task_id == self_wake_task_id`, §6.2) and the
  persona it built resolved that task (§7). If a directed message for a *different* task overrode
  `wake_task_id` (`self_wake_injected=False`), the ack leaves **both** unset → the row stays
  scheduled and re-fires cleanly next tick. This closes the silent-consumption hole: **the
  wait-point is never marked delivered unless the resume-context was surfaced.**

**6.5 Eager cleanup on terminal / owner-removal transitions (B1 hygiene).** The §6.2 join filter
already guarantees a stale row *cannot fire*; this deletes the now-dead row promptly so it never
lingers. Add `DELETE FROM agent_self_wake WHERE task_id=%s` (all agents' rows for the task) at
each point a task leaves `in_progress`:

- **`/done`, full-autonomy branch** → funnels through `_complete_and_unblock`
  (main.py:6807, which sets `status='completed'` at main.py:6705-6706). Deleting inside
  `_complete_and_unblock` covers **both** completion routes (full-autonomy `/done` *and* the human
  `/verify`-approve branch, which the same helper serves — see its docstring at main.py:6698-6703).
- **`/done`, non-full-autonomy branch** → task goes to `needs_verification`
  (main.py:6817-6819); the worker is done waiting, so clear here too.
- **Task cancel** → `status='cancelled'` (main.py:7245). Clear alongside the existing
  assignment-clearing cleanup already at that site (main.py:7247-7250).
- **Task delete** → handled structurally by `ON DELETE CASCADE` (§5); no code needed.
- **Verify-*reject*** returns the task to `in_progress` — intentionally **not** cleared, so a
  legitimately still-running task keeps its pending self-wake.

Each deletion is a no-op when the task had no pending self-wake, so it is safe to add
unconditionally at these sites.

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
- **`tick` — set `clear_self_wake` + `self_wake_task_id`** (notifier.py:3040-3214): the post-drain
  WORK-lane ack payload (notifier.py:3212-3214) today sends only
  `{delivered_ts, kind, event, release_lease, lane}`. Add **both** `clear_self_wake=true` and
  `self_wake_task_id=cand["self_wake_task_id"]` to that dict **iff** the candidate's
  `self_wake_injected` is true (i.e. `wake_task_id == self_wake_task_id`, §6.2) — the resume-context
  rode this wake, so the fired `(agent, task)` row should be deleted, and the ack now carries the
  exact task id the server needs to target it (§6.4). Otherwise send neither field (a competing
  task won; the row survives to re-fire). The run is attributed to `wake_task_id` exactly as today
  (notifier.py:3123).

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
3. **One-shot clear (happy path).** wake-ack with `clear_self_wake=true` **and
   `self_wake_task_id=<task>`** deletes exactly that `(agent, task)` row; the next `wake_scan` no
   longer reports `self_wake_due`. Also assert an ack with `clear_self_wake=true` but a
   **missing/blank `self_wake_task_id` deletes nothing** — the server needs the id to target the
   per-task row (§6.4).
4. **Negative path — competing directed task wins (the review's required teeth).** A directed
   `prompt`/`task_message` for **task B** is pending AND a self-wake for **task A** is due:
   assert `wake_task_id == B`, `self_wake_injected=false`, `resume_context` **omitted** from the
   protocol for B, and — after an ack **without** `clear_self_wake` — the self-wake row for A is
   **still scheduled** and re-fires on the next scan. (No silent consumption.)
5. **Auth scoping + validation grain (round-2 blocker teeth).** A `conversation`-lane token (or a
   human actor) is rejected; a WORK-lane token for the **active in-progress assignee** succeeds.
   And the scheduling endpoint rejects a `task_id` the agent (a) does not participate in at all,
   (b) only **created** but never worked, or (c) participates in but whose task is **not
   `in_progress`** (e.g. `needs_verification`) — every case the looser `_agent_participates_in_task`
   would have wrongly accepted but the §6.2 scan can never fire (§6.1).
6. **Idempotency / cancel (per-task, B2).** Re-scheduling **the same task** replaces its row
   (still exactly one pending row for it, new `resume_at`); `--cancel` deletes that task's row
   only; `--cancel --all` clears every row for the agent.
7. **Gate interplay.** A live WORK lease / running embodiment / cooldown / non-idle each
   suppresses the self-wake exactly as it does other wakes (reuse the existing `wake_scan` gate
   tests).
8. **Graceful mismatch.** `get_agent_protocol` with a `task_id` that has no pending self-wake row
   returns 200 with no `resume_context` (never 4xx).
9. **B2 — two tasks don't clobber (required teeth).** Schedule a self-wake for **task A**, then a
   self-wake for **task B**, both before either fires. Assert **both** rows exist; make both due;
   assert the earliest-`resume_at` one is picked this scan, then after its ack+clear the **other**
   is still scheduled and fires on the next scan. (Neither wake is silently lost.)
10. **B1 — stale row never fires after `/done` (required teeth).** Schedule a due self-wake for a
    task, then `/done` it: under **full autonomy** the task completes and under **non-full** it
    goes to `needs_verification`. In *both* cases assert `wake_scan` reports **no** `self_wake_due`
    for that task (the §6.2 `status='in_progress'` join filter), and assert §6.5 eager-deleted the
    row (or, if left to the lazy path, that the scan removed it).
11. **B1 — cancel clears.** Schedule a due self-wake, cancel the task (`status='cancelled'`):
    `wake_scan` reports no `self_wake_due` and the row is gone (§6.5).
12. **B1 — task delete cascades.** Schedule a self-wake, delete the task: the `agent_self_wake`
    row is removed by `ON DELETE CASCADE` (§5) — no orphaned "wake with no valid task".

Notifier (pure-function tests, the style of the existing `build_wake_prompt` /
`derive_wake_event` / `format_persona` tests): `derive_wake_event` returns `self_wake`;
`build_wake_prompt` self-wake branch text; `_render_resume_context` renders only when present.

## 10. Rollout

- **Additive & backward-compatible.** The `agent_self_wake` table is brand-new (nothing reads it
  until the new code does); every new field on the wake-scan candidate and `WakeAck` defaults off.
  An older notifier that ignores the new fields simply never schedules/clears a self-wake — no
  behaviour change. Ship the migration (`031`) and server first; the notifier + CLI changes light
  it up.
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
