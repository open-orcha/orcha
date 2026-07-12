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
> **Round 3.** Code Reviewer's round-2 verdict raised two more blockers, both fixed at head
> `cb31e674`: **(ack-clear)** the wake-ack now carries a `self_wake_task_id` field — the `WakeAck`
> model had no task field and the daemon ack sent none, so the earlier "delete by the ack's
> `wake_task_id`" was not implementable; the ack now names the exact per-task row to clear (§6.4,
> §7). **(schedule validation)** the schedule endpoint validates the **same** `in_progress` +
> active-assignment predicate the due scan uses, instead of the looser `_agent_participates_in_task`,
> so it can no longer accept a wake that will never fire (§6.1, §9 item 5).
>
> **Round 4.** Code Reviewer's round-3 verdict raised two more blockers, both now
> fixed: **(protocol due-gate)** §6.3 now surfaces `resume_context` **only for a due row**
> (`resume_at <= now()`, the same predicate the §6.2 scan fires on) — previously a same-task directed
> message arriving *before* `resume_at` would inject the context early and, because the due-scan
> selected no row, never clear it, so it re-rendered at `resume_at`; injection and clear are now in
> exact lock-step (§6.3, §9 item 13). **(auth hard-gate)** §6.1 now gates `/self-wake` on the
> already-shipped `_require_work_lane` helper (main.py:5742) — the same gate the other AI-callable
> WORK-lane routes use — with **no `_require_kind` fallback**; a missing/conversation/revoked token
> is a hard 403, and open-question #1 (auth substrate) is resolved and removed (§6.1, §9 item 5).
>
> **Round 5 (this PR head).** Code Reviewer's round-4 verdict raised one remaining blocker: the scan
> picked the *globally earliest* due self-wake row independent of which task won `wake_task_id`, so
> when a directed message for task **B** won the wake while task **A** was the earliest due self-wake,
> the protocol injected **B**'s context (it keys on `wake_task_id`) but the clear keyed on **A**'s
> pick (`self_wake_injected = wake_task_id==self_wake_task_id → B==A → false`) — divergent rows, so
> B's context re-rendered and never cleared. **Fixed:** §6.2 now resolves `wake_task_id` **first**,
> then binds the self-wake candidate to **that resolved task's** row (two branches: a competing task
> that already won the wake, or — if none won — the earliest due row, which then *becomes*
> `wake_task_id`). By construction `self_wake_task_id == wake_task_id` whenever a self-wake rides, so
> §6.3 injects and §6.4 clears the **identical** row — divergence is structurally impossible, and
> `self_wake_injected` collapses to `self_wake_due` (§6.2). §6.3's protocol lookup now also matches
> the **full** due-scan eligibility (in_progress + active assignee, not just `resume_at <= now()`).
> New teeth: §9 item 14 (two due self-wakes + a directed message for one of them → that task's
> context injects **and** its row clears; the other survives).
>
> **Round 6 (this PR head).** Code Reviewer's round-5 verdict raised two remaining blockers, both
> now fixed by tightening the single invariant — *a self-wake rides (is injected **and** cleared)
> **only** when its resume-context actually surfaced on the wake the worker will act on* — to cover
> the two transports/precedence the round-4 fix had not: **(B1 — auto-start precedence)** the
> notifier's existing, test-locked precedence steers the worker to an **assigned-ready** task over a
> scheduled wake — `build_wake_prompt` picks the `/orcha-next` step when `auto_start_task_ids` is set
> (notifier.py:631), `derive_wake_event` ranks `auto_start` above the clock wake (notifier.py:1238),
> and run attribution is `auto[0] if auto else wake_task_id` (notifier.py:3123). So an agent with a
> due self-wake for task **A** *and* an assigned-ready task **B** would have had A's context injected
> and cleared while the prompt + run metadata pointed at **B**. **Fixed:** §6.2 now **defers** the
> self-wake entirely (`self_wake_due=false`, row untouched) whenever `auto_start_task_ids` is
> non-empty — *auto-start wins, the self-wake row survives* — so no notifier precedence change is
> needed and the row fires on a later scan once no auto-start competes (§6.2, §9 item 15).
> **(B2 — tmux delivery clears without injecting)** the resume-context rides only the headless
> `_build_persona` path (notifier.py:3058, the `kind == "ephemeral"` branch); a live **tmux** target
> gets only `build_wake_prompt` (notifier.py:3015-3016) with no persona, yet the shared wake-ack tail
> (notifier.py:3211-3214) would still clear the row when `self_wake_injected` was true. **Fixed:**
> §6.4/§7 now gate `clear_self_wake` on `kind == "ephemeral"` — the *only* transport that built the
> persona and surfaced the context — so a tmux/unreachable delivery leaves the row scheduled to fire
> on a later ephemeral wake, keeping clear-only-if-injected honest and the feature inside its scoped
> ephemeral lane (§6.4, §7, §9 item 16).
>
> **Round 7 (this PR head).** Code Reviewer's round-6 verdict confirmed the round-4/5 fixes and
> raised one remaining blocker: a **pending (owed, unaccepted) task request** is the *same*
> precedence hazard as an auto-start task, but §6.2 only deferred for auto-start. `build_wake_prompt`'s
> precedence is **task-request → auto-start → generic**: an owed task request selects the accept-task
> step (notifier.py:621-644), and `has_pending_task_request` also forces a full boot on the ephemeral
> grader (`decide_wake_tier`, notifier.py:254). So an agent with a **due self-wake for task A** and a
> **pending task request** (and *no* auto-start) would have had §6.2 bind the self-wake, inject A's
> context and clear A's row — while the prompt steered the worker to *accept and work the new task
> request*: the exact inject-and-clear-without-acting divergence, now on the task-request axis.
> **Fixed:** §6.2's deferral is generalised — the self-wake is deferred (`self_wake_due=false`, row
> untouched) whenever **either** `auto_tasks` is non-empty **or** `has_pending_task_request` is true
> (both already computed in the scan, main.py:4999/5009 and folded into `has_work` at main.py:5031).
> Auto-start / the task request wins, the self-wake row survives, and it fires on a later scan once no
> higher-precedence target competes — so, as with auto-start, **no notifier precedence change is
> needed**. New teeth: §9 item 17.
>
> **Round 8 (this PR head).** Code Reviewer's round-7 verdict raised one remaining blocker: the clear
> condition gated on the **selected transport** `kind == "ephemeral"` but not on **delivery success**.
> The ephemeral branch builds the persona *before* `spawn_headless` (notifier.py:3058), and on a spawn
> failure the local `kind` variable stays `"ephemeral"` — only the shared wake-ack tail flips its own
> payload `kind` to `"ephemeral_failed"` via `kind if sent else f"{kind}_failed"` (notifier.py:3213).
> So a clear keyed on `kind == "ephemeral"` alone would delete the self-wake row on a **failed spawn
> that never booted a worker and never surfaced the resume-context** — losing the wait-point unread.
> **Fixed:** §6.4/§7 now add a **third** clear condition — `sent` is true (successful spawn) —
> alongside `kind == "ephemeral"` and `self_wake_injected`, i.e. clear **iff `sent and kind ==
> "ephemeral" and self_wake_injected`** (equivalently: the final ack `kind` is exactly `"ephemeral"`,
> never `"ephemeral_failed"`). A failed ephemeral spawn now leaves **both** ack fields unset and the
> row scheduled to re-fire on a later successful ephemeral wake — clear-only-on-successful-delivery.
> New teeth: §9 item 18 (and the notifier pure-function `sent=false → no clear` assertion).
>
> **Round 9 (this PR head).** Code Reviewer's round-8 verdict confirmed the failed-spawn fix and
> raised one remaining blocker: even a **successful** ephemeral spawn (`sent=true`) can boot a worker
> **without** the resume-context. The notifier fetches the protocol *inside* `_build_persona` via
> `_get_json` (notifier.py:1043), which **silently returns `None`** on any fetch failure — URLError,
> HTTP error, or bad JSON (notifier.py:479-484); `format_persona` then renders a persona with **no
> resume section** (notifier.py:1045), yet `spawn_headless` still succeeds and returns `sent=true`
> (notifier.py:3104). So `sent && kind == "ephemeral" && self_wake_injected` could all hold while the
> resume-context **never reached the worker** — and the clear would still fire, deleting the
> wait-point unread. `self_wake_injected` is a *scan-side intent* flag (§6.2: the scan bound a due
> self-wake to `wake_task_id`); it does **not** attest that the notifier's separate protocol GET
> actually rendered the context. **Fixed:** §6.4/§7 add a **fourth** clear condition —
> `resume_rendered`, true iff the notifier's own protocol GET for this wake returned a non-empty
> `resume_context` (`bool(protocol and protocol.get("resume_context"))`). `_build_persona` now returns
> `(persona, resume_rendered)`; the four non-self-wake call sites unpack-and-discard the flag, only the
> ephemeral self-wake site (notifier.py:3058) threads it into the ack gate. Clear now fires **iff
> `sent and kind == "ephemeral" and self_wake_injected and resume_rendered`**. A protocol-GET blip
> therefore leaves the row scheduled (the worker still drains its inbox, then a later scan re-fires and
> — GET now working — renders the context and clears); the WORK-lane lease + cooldown already
> rate-limit the retry, so this self-heals rather than hot-loops (§6.4, §7). New teeth: §9 item 19 (and
> the notifier pure-function `resume_rendered=false → no clear` assertion).
>
> **Round 10 (this PR head).** Code Reviewer's round-9 verdict confirmed the round-8 fix and raised
> two remaining blockers. **(B1 — the render is not tied to the scan's ride/defer decision.)** The
> round-8 clear gate added `resume_rendered`, but the resume-context *render* itself was still decided
> independently by `get_agent_protocol` (§6.3): it returns `resume_context` for **any** due eligible
> self-wake row keyed on the requested `task_id`, with **no knowledge of the scan's auto-start /
> pending-task-request deferral**. `wake_task_id` is resolved first by the *existing* directed-message /
> pending-answer path (main.py:4957, 4969-4983) — independent of the self-wake. So an agent that has a
> **due self-wake for task A** *and* a higher-precedence target (an assigned-ready auto-start task, or an
> owed task request) *and* an independent reason `wake_task_id` resolves to **A** (a pending answer whose
> `originating_task_id==A`, or a directed message for A) would: (i) §6.2 **defer** the self-wake
> (`self_wake_injected=false`, row untouched — correct, nothing cleared); yet (ii) the notifier boots the
> persona with `task_id=wake_task_id=A` (notifier.py:3058), and §6.3 injects **A**'s `resume_context`
> because A's row is genuinely due — so the worker is shown the wait-point **while `build_wake_prompt`
> steers it to claim the auto-start task / accept the task request**, and A's context re-renders later
> when the self-wake finally rides. The render escaped the deferral. **Fixed:** the resume-context render
> is now **threaded from the scan candidate's intent**, not re-derived by the protocol endpoint alone.
> `_build_persona` (notifier.py:1016) takes the candidate's self-wake intent and renders `resume_context`
> **only when `cand["self_wake_injected"]` is true AND the persona's `task_id == cand["self_wake_task_id"]`**;
> `resume_rendered` is now exactly *"the resume section actually rendered into this persona"* —
> `bool(self_wake_injected and task_id == self_wake_task_id and protocol and protocol.get("resume_context"))`.
> During any deferral `self_wake_injected` is false, so the context never renders and never clears; §6.3
> remains the data seam but the ride/defer **authority is the scan**, enforced at the render (§6.3, §6.4,
> §7). New teeth: §9 items 15 & 17 now assert the persona omits `resume_context` even when `wake_task_id`
> coincides with the deferred self-wake's task.
> **(B2 — a blank/whitespace context would retry forever.)** `context` was nullable/bounded-only, but
> `resume_rendered` keys on `bool(resume_context)`; an empty or whitespace-only payload renders no resume
> section, so `resume_rendered` stays **false forever**, the clear never fires, and the row re-fires every
> eligible scan — a hot-loop no protocol recovery can end (unlike the round-8 GET-blip case, which
> self-heals). **Fixed:** `context` is now **required and non-empty** — `NOT NULL CHECK (btrim(context) <>
> '')` at the DB (§5) and a **trim-and-reject-empty (422)** validation at the endpoint (§6.1), alongside
> the existing length cap (now fixed at 2 KB, §11 item 2 resolved). A real row therefore always carries a
> non-empty context, so `resume_rendered=false` can only mean a genuine non-ride (deferral / competing
> task) or a transient protocol-GET blip that self-heals — never a permanent empty-payload loop. New
> teeth: §9 item 20 (blank/whitespace context → 422).

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
rode the injection** — a booted headless persona whose protocol GET really rendered the
resume-context (§6.4) — and it can **never fire for a task that is no longer `in_progress`**
(§6.2 join filter + §6.5 eager cleanup).

```
worker (blocked on CI)                server                              notifier daemon
─────────────────────                 ──────                              ───────────────
POST /agents/{aid}/self-wake  ──▶  upsert agent_self_wake row
  {resume_at, task_id,               (agent_id, task_id, resume_at,
   context}  (run-token gated)        context)  — one row PER task
worker EXITS (yields session)
        ⋯ N minutes ⋯
                                   wake_scan: resolve wake_task_id   ──▶  candidate carries
                                     FIRST, then bind self-wake to          self_wake_* with
                                     THAT task's due row (in_progress       self_wake_task_id
                                     + active assignee); if no task         == wake_task_id by
                                     won, earliest due row BECOMES          construction
                                     wake_task_id → self_wake_due           (stale/non-active
                                     folds into has_work (§6.2)             rows filtered out)
                                                                     ──▶  _build_persona → GET
                                   get_agent_protocol returns the          /protocol(task_id=…)
                                     task body + resume_context      ◀──   renders resume-context
                                                                           at the #33 seam;
                                                                           build_wake_prompt
                                                                           self-wake branch
                                   wake-ack {clear_self_wake:true}   ◀──   ONLY if wake_task_id ==
                                     DELETEs the (agent,task) row           self_wake_task_id AND
                                     — other tasks' rows untouched          kind=='ephemeral' AND
                                                                           sent (spawn succeeded) AND
                                                                           resume_rendered (scan bound
                                                                           the self-wake to THIS task
                                                                           AND the protocol GET returned
                                                                           resume_context — render gated
                                                                           on scan intent, §6.3/§7),
                                                                           i.e. the context actually
                                                                           rode a booted headless
                                                                           persona (§6.4, §7). tmux /
                                                                           auto-start / pending
                                                                           task-request (deferred:
                                                                           render suppressed) / failed
                                                                           spawn (ephemeral_failed) /
                                                                           protocol GET blip ⇒ row survives
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
  context     text NOT NULL,                         -- required, non-empty (round-9 B2), bounded (§7)
  CONSTRAINT agent_self_wake_context_nonempty CHECK (btrim(context) <> ''),  -- round-9 B2: no empty payload
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
  directly into the wake prompt. It is **required and non-empty** (`NOT NULL` + the
  `btrim(context) <> ''` CHECK above — round-9 blocker B2): a blank/whitespace payload would render
  no resume section, so `resume_rendered` (§6.4/§7) would stay false forever and the one-shot would
  re-fire on every eligible scan without ever clearing — a hot-loop no protocol recovery can break
  (unlike the round-8 transient-GET-blip case, which self-heals). A length cap (2 KB, §7) is enforced
  at the API layer, and empty-after-trim is rejected there too (§6.1).
- `ON DELETE CASCADE` on `agent_id` keeps the table clean if an agent row is ever removed.

## 6. Server changes (`main.py`)

**6.1 New endpoint — `POST /api/agents/{aid}/self-wake`** (agent-callable, ephemeral WORK lane
only). Mirrors the shape of `update_agent_auto_wake` (main.py:4102) but is **AI-callable, not
human-gated**, and one-shot/per-task. Takes an `x_orcha_run_token: Optional[str] =
Header(default=None, alias="X-Orcha-Run-Token")` param (same declaration as main.py:3560) and
gates on `_require_work_lane` (below).

- **Auth scoping (ephemeral WORK lane only) — hard-gated, no fallback (round-3 blocker fix).**
  Unlike the auto-wake endpoint's `_require_kind(..., ("human",))` (main.py:4114), `/self-wake`
  gates on the already-shipped WORK-lane helper `_require_work_lane(cur, aid, x_orcha_run_token)`
  (main.py:5742-5754) — the **same** gate the other AI-callable WORK-lane task routes already use
  (`wake_claim` main.py:3568, `task_done` main.py:6766, `respond_request` main.py:8181). It reads
  the `X-Orcha-Run-Token` header (declared exactly as those routes do, e.g. main.py:3560) and
  **raises 403 on a missing / unknown / revoked / conversation-lane token**, passing **only** a
  valid non-revoked `lane='work'` token for this agent (main.py:5747-5754). A resident/chat
  session (conversation token) therefore cannot self-schedule a task wake; a human live terminal
  passes because the terminal bridge mints it a WORK token (helper docstring, main.py:5745-5746).
  **There is no `_require_kind`/participant fallback** — the token is a hard requirement, so an
  unauthenticated or conversation caller is rejected before any DB write. The WORK-lane token
  plumbing already lives on `origin/main` (GH #90/#91), so nothing here is deferred to
  implementation time.
- **Body** (`SelfWakeSet` Pydantic model): `resume_at` (or `delay_secs`, int ≥ 60 — reuse the
  same 60s floor the auto-wake DB CHECK enforces, main.py:4107), `task_id`, `context` (str,
  **required, non-empty after trim, ≤ 2 KB**).
- **`context` validation (round-9 blocker B2 fix).** The endpoint **trims** `context` and **rejects
  an empty/whitespace-only value with 422** (a Pydantic `min_length=1` after `.strip()`, or an
  explicit `if not context.strip(): raise HTTPException(422, ...)`), and caps it at **2 KB** (§7,
  §11 item 2 resolved). This is the API-layer twin of the DB `NOT NULL CHECK (btrim(context) <> '')`
  (§5): a blank payload would make `resume_rendered` (§6.4) permanently false — no resume section ever
  renders — so the one-shot could never clear and would re-fire on every eligible scan, a hot-loop no
  protocol recovery can end. Storing the trimmed value guarantees any persisted row carries a
  non-empty context, so `bool(resume_context)` is always true for a real row and `resume_rendered`
  can only be false for a genuine non-ride or a transient GET blip. (Negative test: blank/whitespace
  `context` → 422, §9 item 20.)
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

- **Resolve `wake_task_id` FIRST, then bind the self-wake to *that* task (round-4 blocker fix —
  scan / protocol / ack share one row).** The earlier draft picked the *globally earliest* due
  self-wake row **independent** of which task won `wake_task_id`; when a directed message for task
  **B** won the wake while task **A** was the earliest due self-wake, the protocol injected **B**'s
  context (§6.3 keys on `wake_task_id`) but the clear keyed on **A**'s pick — divergent rows, so B
  re-rendered and never cleared. The fix: the self-wake candidate is **always the row for the
  resolved `wake_task_id`**, so injection (§6.3) and clear (§6.4) target the identical row.

- **Higher-precedence-target deferral — defer the self-wake when the wake prompt will steer the
  worker elsewhere (round-5 blocker B1 + round-6 blocker).** The notifier has an existing,
  **test-locked** precedence that steers the worker to a *higher-priority* target ahead of a
  scheduled clock wake, on **two** axes:
  - **Auto-start (assigned-ready task).** `build_wake_prompt` selects the `/orcha-next` claim step
    whenever `auto_start_task_ids` is non-empty (notifier.py:631), `derive_wake_event` ranks
    `auto_start` above the clock wake (notifier.py:1238), and the run is attributed to
    `auto[0] if auto else wake_task_id` (notifier.py:3123, :3157) — precedence locked by
    `tests/test_wake_single_flight.py`.
  - **Pending (owed, unaccepted) task request.** `build_wake_prompt`'s precedence is actually
    **task-request → auto-start → generic**: an owed task request selects the *accept-and-do* step
    ahead of even the auto-start step (`has_task_request` branch, notifier.py:621-630), and the
    ephemeral grader forces a full boot for it (`decide_wake_tier`, notifier.py:254 — "owed task
    request ALWAYS earns a full boot"). The scan already computes this as `has_pending_task_request`
    (main.py:5009) and surfaces it on the candidate (main.py:5132).

  If a self-wake were allowed to bind/inject while **either** competes, the worker's prompt and
  `worker_run` would point at the auto-start task / the new task request **B** while the self-wake for
  **A** was injected and cleared — the exact divergence round 4 closed for directed messages, now on
  the auto-start / task-request axes. **Rule (higher-precedence target wins; row survives):** when the
  scan's `auto_tasks` is non-empty (equivalently the candidate's `auto_start_task_ids`, surfaced at
  main.py:5110-5146) **OR** `has_pending_task_request` is true (main.py:5009, :5132), the self-wake is
  **deferred this scan** — it does **not** bind `wake_task_id`, `self_wake_due` stays **false**, and
  the row is **left untouched** to fire on a later scan once no higher-precedence target competes.
  `has_work` is already true from that target (`len(auto_tasks) > 0 or has_pending_task_request`,
  main.py:5031), so nothing is lost, and — because the notifier already gives both targets precedence
  everywhere — **no notifier precedence change and no `test_wake_single_flight` change is needed**; the
  scan simply declines to ride. (Both drain: an auto-start task is claimed → `in_progress`; a task
  request is accepted → it spawns/becomes the worker's task. So this is not starvation — the self-wake
  fires on the next scan once neither competes. §9 items 15, 17.) The two branches below apply **only
  when `auto_tasks` is empty AND `has_pending_task_request` is false.**

  The existing `wake_task_id` resolution runs **first and unchanged** — directed messages
  (`_collect_directed_messages`, main.py:4957) then a pending answer's `originating_task_id`
  (main.py:4969-4983). Define the shared **self-wake eligibility predicate** (identical to the
  endpoint's §6.1 validation grain and the protocol's §6.3 lookup — the exact grain the wake-load
  path already uses at main.py:4709):

  ```sql
  sw.resume_at <= now()
  AND t.status = 'in_progress'                                       -- B1: never for a done/cancelled task
  AND at.assignment_status IN ('assigned','accepted','working')      -- B1: agent still actively participates
  ```

  Then resolve the self-wake in two branches off the already-resolved `wake_task_id` (a correlated
  subquery beside the candidate SELECT, near the `secs_since_woken` computation at
  main.py:4874-4878):

  - **A competing task already won `wake_task_id`** (a directed message / pending answer set it):
    look up the eligible self-wake row **for that exact task**:

    ```sql
    SELECT sw.context FROM agent_self_wake sw
      JOIN tasks t        ON t.id = sw.task_id
      JOIN agent_tasks at ON at.task_id = sw.task_id AND at.agent_id = sw.agent_id
     WHERE sw.agent_id = a.id AND sw.task_id = <wake_task_id>
       AND <eligibility predicate>
     LIMIT 1
    ```
    A row ⇒ the winning task **also** had a due self-wake, so its context injects and its row
    clears. No row ⇒ the winning task has no due self-wake (the classic "a *different* task's
    message consumed this wake"): `self_wake_due=false`, nothing injects, and any **other** task's
    due self-wake row is **left untouched to fire on a later scan**.

  - **No task won `wake_task_id` yet** (`wake_task_id is None`): select the **earliest** eligible
    self-wake row and **bind** `wake_task_id` to it:

    ```sql
    SELECT sw.task_id, sw.context FROM agent_self_wake sw
      JOIN tasks t        ON t.id = sw.task_id
      JOIN agent_tasks at ON at.task_id = sw.task_id AND at.agent_id = sw.agent_id
     WHERE sw.agent_id = a.id AND <eligibility predicate>
     ORDER BY sw.resume_at
     LIMIT 1
    ```
    A row ⇒ set `wake_task_id := sw.task_id` (this self-wake drives the wake). Several due rows for
    different tasks ⇒ the earliest is taken this scan and the rest survive to fire on subsequent
    scans, one per scan (§9 item 9).

  In **both** branches, when a row is found: `self_wake_task_id := wake_task_id`,
  `self_wake_context := sw.context`, `self_wake_due := true`. When neither yields a row:
  `self_wake_due := false` and `wake_task_id` is left as the existing resolution set it. The
  `in_progress` + active-assignment join is the **guarantee** that a stale row for a no-longer-active
  task can never wake the agent, independent of whether §6.5's eager cleanup ran.
- **Invariant — one row, no divergence.** By construction `self_wake_due` ⇒
  `self_wake_task_id == wake_task_id`. The protocol (§6.3) injects the context for `wake_task_id`
  and the ack (§6.4) clears the row for `self_wake_task_id`; because they are the **same** task, the
  row injected is exactly the row cleared. **`self_wake_injected` therefore collapses to
  `self_wake_due` itself** (a due eligible self-wake exists **for the resolved task**) and can no
  longer disagree with what the protocol actually injected — the round-4 fix. It is `true` both when
  the self-wake *bound* `wake_task_id` (no competing task) and when a competing message won a task
  that *also* had a due self-wake; it is `false` when the winning task had no due self-wake (a
  different task's message consumed this wake — the row for that different task simply survives) **and
  whenever a higher-precedence target is queued** (the deferral at the top of §6.2 — an auto-start
  assigned-ready task *or* an owed pending task request — the self-wake never rides a scan the worker
  will spend claiming that task / accepting that request).
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
- Surface on the candidate dict (main.py:5110-5146): `self_wake_due`, `self_wake_context`,
  `self_wake_injected`, and `self_wake_task_id`, next to the existing `auto_wake_due` fields
  (main.py:5120). Add a `reason` bit ("scheduled self-wake for task …") beside the auto-wake bit
  at main.py:5086-5087.

**6.3 `get_agent_protocol` — carry the resume-context** (`main.py:4662`).

- When a **due** pending `agent_self_wake` row exists for `(this agent, resolved task_id)`,
  include its `context` as `resume_context` in the response next to the #33 body fields
  (main.py:4719-4721) — a single lookup keyed on `(agent_id, task_id)`. Because the notifier
  passes `task_id=wake_task_id` (notifier.py:3058-3059), the context is served only for the task
  this wake actually resolved to.
- **This endpoint is the DATA seam, not the ride/defer authority (round-9 blocker B1).** It knows
  only "is a self-wake row due for this `task_id`" — it has **no** visibility into the scan's
  auto-start / pending-task-request **deferral** (§6.2), which lives entirely in `wake_scan`. So a
  due row here does **not** by itself mean the self-wake should surface: if the scan **deferred** the
  self-wake yet `wake_task_id` independently resolved to that same task (a pending answer whose
  `originating_task_id` is it, or a directed message for it — main.py:4957, 4969-4983), this endpoint
  would still return `resume_context` for a wake the worker is being steered *away* from. The
  **render decision is therefore made where the scan's intent is available — the notifier**, gated on
  the candidate's `self_wake_injected` **and** `wake_task_id == self_wake_task_id` (§7). The endpoint
  supplies the data; the notifier renders it **iff** the scan actually bound the self-wake to this
  wake. (`resume_context` returned but not rendered is harmless — the notifier is its only consumer.)
- **Eligibility-gate the lookup (round-3/4 blocker fix — no early/re-render, no stale inject).**
  The lookup MUST apply the **full eligibility predicate the §6.2 due-scan uses** — not just
  `resume_at <= now()`, but also the task is `in_progress` and the agent is an active assignee — so
  the protocol can never inject a context the scan would not have fired:

  ```sql
  SELECT sw.context FROM agent_self_wake sw
    JOIN tasks t        ON t.id = sw.task_id
    JOIN agent_tasks at ON at.task_id = sw.task_id AND at.agent_id = sw.agent_id
   WHERE sw.agent_id=%s AND sw.task_id=%s
     AND sw.resume_at <= now()
     AND t.status = 'in_progress'
     AND at.assignment_status IN ('assigned','accepted','working')
   LIMIT 1
  ```

  Because §6.2 now binds `self_wake_task_id` to the resolved `wake_task_id`, this lookup — keyed on
  the same `task_id=wake_task_id` the notifier passes (notifier.py:3058-3059) — reads the **identical
  row** the §6.4 ack will clear, so inject and clear can never target different rows.
  Without the `resume_at <= now()` clause, a directed message for the **same** task arriving
  **before** `resume_at` would resolve `wake_task_id` to that task, cause this endpoint to inject
  the resume-context **early**, and — because the §6.2 due-scan selected no row (not yet due) so
  `self_wake_injected` is false — the ack would **not** clear it (§6.4). The still-scheduled row
  would then fire **again** at `resume_at`, double-rendering the context. Gating the injection on
  the identical due predicate keeps §6.3 (inject) and §6.2/§6.4 (mark-injected + clear) in exact
  lock-step: the context is surfaced **iff** the row is due, and it is cleared **iff** it was
  surfaced. (Now-monotonicity makes this race-free: if the row is due at the §6.2 scan it is still
  due at the slightly-later §6.3 protocol call.)
- **Graceful mismatch (non-blocking note carried forward):** if there is no *due* pending
  self-wake row for the requested `(agent, task_id)` (not yet due, a competing task won, or none
  scheduled), simply **omit** `resume_context` — never 4xx. The endpoint already returns
  `{task_id: null, protocol: null}` for an unresolved wake (main.py:4716-4717); the resume-context
  is purely additive.

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
- **Who sets it — only on a *successfully delivered* ephemeral (persona) transport that actually
  rendered the context (round-5 blocker B2 + round-7 + round-8 blockers).** The daemon sets
  `clear_self_wake=true` **and** `self_wake_task_id = cand["self_wake_task_id"]` on its ack **only when
  the self-wake actually rode this wake and a headless worker actually received the resume-context** —
  which requires **all four** of: (i) the candidate's `self_wake_injected` was true (`wake_task_id ==
  self_wake_task_id`, §6.2); (ii) the wake was delivered on the **ephemeral** transport (`kind ==
  "ephemeral"`, notifier.py:3017) — the *only* path that calls `_build_persona` (notifier.py:3058) and
  can render `resume_context`; **(iii) the spawn actually succeeded — `sent` is true (round-7
  blocker)**; **and (iv) the resume-context was actually rendered into that persona — `resume_rendered`
  is true (round-8 blocker).**
  - **(iii)** is load-bearing and easy to miss: the local `kind` variable stays `"ephemeral"` even when
    `spawn_headless` returns `sent=false` (no `claude` binary, bad cwd, Popen error, single-flight
    loss) — the failure is reflected **only** in the ack payload's own `kind` field, which the shared
    tail sets to `f"{kind}_failed"` = `"ephemeral_failed"` precisely when `not sent`
    (notifier.py:3213). So a clear keyed on the *selected transport* `kind == "ephemeral"` alone would
    fire even though **no worker booted and the resume-context was never surfaced** — deleting the
    wait-point while the worker that was supposed to see it never ran. The ephemeral branch builds the
    persona (notifier.py:3058) **before** `spawn_headless`, then — on failure — falls through to the
    shared wake-ack tail (notifier.py:3211-3214) with `sent=false`, posting `kind="ephemeral_failed"`.
  - **(iv)** is the round-8 hole: even a *successful* spawn (`sent=true`, `kind=="ephemeral"`,
    `self_wake_injected=true`) can boot a worker with **no resume section**. `_build_persona` fetches the
    protocol via `_get_json` (notifier.py:1043), which **silently returns `None`** on any URLError /
    HTTPError / bad JSON (notifier.py:479-484); `format_persona` then renders a persona **without**
    `resume_context` (notifier.py:1045), yet `spawn_headless` still returns `sent=true`
    (notifier.py:3104). `self_wake_injected` is a *scan-side intent* flag (§6.2) — it attests the scan
    bound a due row to `wake_task_id`, **not** that the notifier's own protocol GET succeeded. So the
    clear must additionally confirm the render actually happened. **Implementation:** `_build_persona`
    (notifier.py:1016-1045) now returns `(persona, resume_rendered)` where `resume_rendered =
    bool(task_id and protocol and protocol.get("resume_context"))` — true iff the protocol GET returned
    a non-empty `resume_context` (which is exactly what `_render_resume_context`/`format_persona`
    renders, §7). The four **non-self-wake** call sites (notifier.py:2490, 3686, 4162, 4280) unpack and
    discard the flag (`persona, _ = _build_persona(...)`); only the **ephemeral self-wake** site
    (notifier.py:3058) keeps it and threads it into the ack gate.

  Expressed together, the clear condition is `sent and kind == "ephemeral" and
  cand["self_wake_injected"] and resume_rendered`. A **tmux** delivery (notifier.py:3015-3016) sends
  only `build_wake_prompt` output with **no persona**, so the context never surfaced; the shared
  wake-ack tail runs for tmux too, so without the transport gate a tmux wake would clear a row it never
  injected. If **any** of the four conditions fails — a directed message for a *different* task
  overrode `wake_task_id` (`self_wake_injected=False`), the wake went to tmux/unreachable, the ephemeral
  spawn failed (`sent=false`, `ephemeral_failed`), **or the protocol GET blipped so no resume-context
  rendered (`resume_rendered=false`)** — the ack leaves **both** fields unset → the row stays scheduled
  and re-fires on a later **ephemeral** scan. On the round-8 axis the worker still boots and drains its
  inbox; because its self-wake row survives (and `resume_at` is already past), the very next eligible
  scan re-fires it and — the protocol GET now succeeding — renders the context and clears. The
  WORK-lane single-flight lease + cooldown that gate every wake already rate-limit that retry to the
  scan cadence, so an extended `/protocol` outage retries at that cadence rather than hot-looping, and
  it clears the moment the API recovers — self-healing, the same failure posture as any wake during an
  API blip. This closes the silent-consumption hole on **all four** axes: **the wait-point is never
  marked delivered unless the resume-context was actually rendered into a headless worker that actually
  booted** (the scoped ephemeral lane, §2).

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
- **`_build_persona`** (notifier.py:1016-1045): two changes. **(a)** change the return type from
  `Optional[str]` to `(Optional[str], bool)` — the persona **and** `resume_rendered`. **(b)** take the
  scan's self-wake intent from the candidate — a new keyword arg, e.g. `self_wake:
  Optional[dict]=None` carrying `{"injected": cand["self_wake_injected"], "task_id":
  cand["self_wake_task_id"]}` — and thread it into `format_persona` so the resume section renders
  **only when the scan actually bound the self-wake to this wake** (round-9 blocker B1). Concretely:

  ```python
  render_resume = bool(self_wake and self_wake["injected"]
                       and task_id and task_id == self_wake["task_id"])
  # format_persona renders the resume section iff render_resume; #33 body/RULES render unchanged
  resume_rendered = bool(render_resume and protocol and protocol.get("resume_context"))
  return format_persona(persona, digest, protocol, lane=lane,
                        render_resume=render_resume), resume_rendered
  ```

  So `resume_rendered` is exactly *"the resume section actually rendered into this persona"*: the scan
  bound the self-wake to **this** `task_id` **and** the protocol GET (notifier.py:1043) returned a
  non-empty `resume_context`. `_get_json` swallows a failed GET as `None` (notifier.py:479-484), after
  which `format_persona` renders no resume section but the spawn still succeeds — the round-8 hole,
  still caught by the `protocol.get("resume_context")` term. And during an auto-start / task-request
  **deferral** (`self_wake_injected=false`), `render_resume` is false so the context never renders even
  if `get_agent_protocol` returned one for a coincidentally-resolved `wake_task_id` — the round-9 B1
  hole. `format_persona` (notifier.py:896) gains a `render_resume: bool=False` param that gates the
  `_render_resume_context` call **only** (the #33 body and RULES are unaffected). The four
  **non-self-wake** call sites (notifier.py:2490, 3686, 4162, 4280) pass **no** `self_wake` (→
  `render_resume=false`, resume never renders — they never carry one) and unpack-and-discard the flag
  (`persona, _ = _build_persona(...)`); only the **ephemeral self-wake** site (notifier.py:3058) passes
  `self_wake={...}` and keeps the flag.
- **`build_wake_prompt`** (notifier.py:540): add a dedicated **self-wake branch** parallel to the
  `auto_wake_due` heartbeat branch (notifier.py:563-564). When `cand["self_wake_due"]` and it
  won the wake, the directive says the worker *scheduled this check-back itself* and the context
  is in its "Your task"/Resuming section — not the generic "pending work". The generic
  don't-claim step-2 (notifier.py:640-644) is misleading here; give self-wake its own step-2
  ("resume the task you scheduled this wake for; re-check the external step; if still not ready,
  reschedule another self-wake and exit"), so a worker never re-derives.
- **`tick` — set `clear_self_wake` + `self_wake_task_id`, successful-and-rendered ephemeral delivery
  only** (notifier.py:3040-3214): the post-drain WORK-lane ack payload (notifier.py:3211-3214) today
  sends only `{delivered_ts, kind, event, release_lease, lane}` and is the **shared tail** for the
  tmux, ephemeral, and unreachable branches. Unpack the new render flag at the persona build, passing
  the scan's self-wake intent so the render is gated on it (round-9 blocker B1):
  `persona, resume_rendered = _build_persona(..., task_id=cand.get("wake_task_id"),
  self_wake={"injected": cand["self_wake_injected"], "task_id": cand["self_wake_task_id"]})`
  (notifier.py:3058), then add **both** `clear_self_wake=true` and
  `self_wake_task_id=cand["self_wake_task_id"]` to that ack dict **iff** `sent` is true **and** `kind ==
  "ephemeral"` **and** the candidate's `self_wake_injected` is true (i.e. `wake_task_id ==
  self_wake_task_id`, §6.2) **and** `resume_rendered` is true. All four are load-bearing:
  - the `kind == "ephemeral"` guard — only that branch built the persona (`_build_persona`,
    notifier.py:3058) that can render `resume_context`, so it is the only transport on which the
    context could surface;
  - the **`sent` guard (round-7 blocker)** — the ephemeral branch builds the persona *before*
    `spawn_headless`, and on a spawn failure (`sent=false`: no `claude`, bad cwd, Popen error) the
    local `kind` variable is **still `"ephemeral"`**; only the shared tail's own payload `kind` flips
    to `"ephemeral_failed"` via `kind if sent else f"{kind}_failed"` (notifier.py:3213). So without
    an explicit `sent` check the clear would fire on a failed spawn that **never booted a worker and
    never surfaced the context**, deleting the wait-point unread. Gate the new fields on `sent`
    (equivalently: emit them only when the payload `kind` is exactly `"ephemeral"`, never
    `"ephemeral_failed"`);
  - the **`resume_rendered` guard (round-8 + round-9-B1 blockers)** — `resume_rendered` is true **iff
    the resume section actually rendered into this persona**, which now requires **both** that the
    scan bound the self-wake to this wake (`self_wake_injected` **and** `task_id ==
    self_wake_task_id`, the round-9-B1 render gate) **and** that the protocol GET returned a non-empty
    context. Two ways it goes false: **(round-8)** a *successful* spawn still boots a persona with
    **no resume section** when the protocol GET inside `_build_persona` failed — `_get_json` swallows
    the error as `None` (notifier.py:479-484), `format_persona` renders nothing (notifier.py:1045),
    yet `spawn_headless` returns `sent=true` (notifier.py:3104); **(round-9 B1)** the scan **deferred**
    the self-wake (auto-start / task request) so `self_wake_injected` is false, and even if
    `get_agent_protocol` returned a `resume_context` for a coincidentally-resolved `wake_task_id`, the
    `render_resume` gate suppresses it. In **either** case leave both ack fields unset: the row
    survives and — once the deferral clears / the GET recovers — a later eligible scan re-fires,
    renders, and clears;
  - the `self_wake_injected` guard — the resolved `wake_task_id` is the self-wake's task (§6.2).
  - **`resume_rendered` now *is* "the resume section actually rendered into this persona" (round-9
    blocker B1).** The round-8 draft defined it as `bool(task_id and protocol and
    protocol.get("resume_context"))` — a pure protocol-GET check that did **not** consult the scan's
    ride/defer intent, so during an auto-start / task-request **deferral** where `wake_task_id`
    coincidentally resolved to the deferred self-wake's task, `get_agent_protocol` still returned a due
    `resume_context`, `_build_persona` still rendered it, and `resume_rendered` went true — the render
    escaped the deferral (the worker saw the wait-point while being steered elsewhere). The render is
    now **gated on scan intent**: `_build_persona` renders the resume section **only when**
    `cand["self_wake_injected"]` is true **and** `task_id == cand["self_wake_task_id"]`, and
    `resume_rendered = bool(self_wake_injected and task_id == self_wake_task_id and protocol and
    protocol.get("resume_context"))` — i.e. it is true **iff** the scan bound the self-wake to *this*
    task **and** the protocol GET actually returned a non-empty context. During any deferral
    `self_wake_injected` is false, so nothing renders and nothing clears (§6.3, §7). This makes the
    `self_wake_injected` guard above **subsumed by** `resume_rendered` (kept spelled out for
    defense-in-depth), and it closes the deferral-coincidence render hole.

  A **tmux** delivery (notifier.py:3015-3016, `send_tmux`), an **unreachable** candidate, a **failed
  ephemeral spawn (`ephemeral_failed`)**, **or a successful spawn whose protocol GET failed
  (`resume_rendered=false`)** sends neither field → the row survives to re-fire on a later ephemeral
  scan (round-5 blocker B2 + round-7 + round-8 blockers). Otherwise (competing task won, non-ephemeral
  transport, spawn failure, or unrendered context) send neither field and the row re-fires cleanly.
  The run
  is attributed to `wake_task_id` exactly as today (notifier.py:3123) — and note the
  higher-precedence-target deferral (§6.2) means a self-wake never rides a scan where
  `auto_start_task_ids` is set **or** a task request is pending, so the ack's `self_wake_task_id` can
  never disagree with the `auto[0] if auto else wake_task_id` run attribution nor be cleared on a
  scan the worker spends accepting a task request.

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
4. **Negative path — competing directed task wins, no self-wake on it (the review's required
   teeth).** A directed `prompt`/`task_message` for **task B** is pending, **task B has no self-wake
   row**, AND a self-wake for **task A** is due: assert `wake_task_id == B`, the branch-A lookup for
   B finds no eligible row so `self_wake_due=false` / `self_wake_injected=false`, `resume_context`
   **omitted** from the protocol for B, and — after an ack **without** `clear_self_wake` — the
   self-wake row for A is **still scheduled** and re-fires on the next scan. (No silent consumption.)
5. **Auth scoping + validation grain (round-2/3 blocker teeth).** `_require_work_lane` is enforced:
   a request with **no `X-Orcha-Run-Token` header at all → 403** (the hard round-3 requirement — no
   token, no fallback), a **`conversation`-lane token → 403**, and a **revoked/unknown token → 403**;
   only a valid non-revoked WORK token for the **active in-progress assignee** succeeds (mirrors the
   existing `_require_work_lane` route tests). And the scheduling endpoint rejects a `task_id` the
   agent (a) does not participate in at all,
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
13. **Early same-task directed wake — no early/re-render (round-3 blocker teeth).** Schedule a
    self-wake for **task A** with `resume_at` in the future (not yet due), then make a directed
    `prompt`/`task_message` for **the same task A** pending so the wake fires **before** `resume_at`.
    Assert `get_agent_protocol(task_id=A)` **omits** `resume_context` (the §6.3 `resume_at <= now()`
    due-gate), that `self_wake_injected` is **false** (§6.2 due-scan selected no row), and that after
    the ack — sent **without** `clear_self_wake` — the self-wake row for A is **still scheduled** and
    then fires **once** with the context when `resume_at` finally arrives. (Context renders exactly
    once, at due time — never early, never twice.)
14. **Two due self-wakes + a directed message for one of them — resolved-task binding (round-4
    blocker teeth).** Task **A** and task **B** *both* have due self-wake rows, and a directed
    `prompt`/`task_message` for **task B** is pending. Assert `wake_task_id == B` (directed wins),
    that the self-wake candidate binds to **B** via §6.2's branch-A lookup (`self_wake_task_id == B`,
    `self_wake_injected=true`), that `get_agent_protocol(task_id=B)` injects **B**'s `resume_context`,
    and that after the ack (`clear_self_wake=true`, `self_wake_task_id=B`) **B**'s row is deleted
    while **A**'s row **survives** and fires on the next scan. (The injected row is exactly the
    cleared row; no divergence, no double-render — the specific hole round 4 caught, where the old
    "globally earliest" pick chose A while the protocol injected B.)
15. **Auto-start precedence — self-wake defers, row survives, context not rendered (round-5 B1 +
    round-9 B1 teeth).** An agent has a **due** self-wake for task **A** *and* an **assigned-ready**
    task **B** (so the scan's `auto_tasks`/candidate `auto_start_task_ids` is non-empty). Assert the
    self-wake **does not ride this scan**: `self_wake_due=false`, `self_wake_injected=false`,
    `wake_task_id` is **not** bound to A by the self-wake, and the run/prompt follow the existing
    auto-start precedence (`derive_wake_event → auto_start`, attribution `auto[0]`). **Round-9 B1
    sub-case:** additionally arrange an *independent* reason `wake_task_id` resolves to **A** (a
    pending answer whose `originating_task_id==A`, or a directed message for A) while B is still
    auto-start-ready. Assert `get_agent_protocol(task_id=A)` still returns `resume_context` (it is the
    data seam, A's row is due) but the **built persona omits the resume section** — `_build_persona`
    with `self_wake={"injected": false, ...}` sets `render_resume=false` and `resume_rendered=false` —
    so the worker never sees A's wait-point while being steered to claim B. After an ack **without**
    `clear_self_wake`, A's row is **still scheduled**; then with B claimed (no longer auto-start-ready)
    a later scan fires A's self-wake normally and *renders* its context. (No divergence, and the render
    never escapes the deferral.)
16. **tmux delivery never clears (round-5 blocker B2 teeth).** A due self-wake is delivered to a live
    **tmux** target (`choose_transport → "tmux"`, notifier.py:1224). Assert the notifier's ack
    **omits** `clear_self_wake`/`self_wake_task_id` (the `kind == "ephemeral"` gate, §7), so the row
    is **not** deleted; then assert the *same* self-wake, delivered on a subsequent **ephemeral** wake
    (persona built via `_build_persona`), injects `resume_context` and *its* ack (`kind ==
    "ephemeral"`, `self_wake_injected=true`) clears the row. (Clear-only-if-injected holds across
    transports — a wake that never rendered the context never consumes the wait-point.)
17. **Pending task request — self-wake defers, row survives, context not rendered (round-6 + round-9
    B1 teeth).** An agent has a **due** self-wake for task **A** *and* an **owed, unaccepted task
    request** pending (so the scan's `has_pending_task_request` is true), with **no** auto-start task.
    Assert the self-wake **does not ride this scan**: `self_wake_due=false`,
    `self_wake_injected=false`, `wake_task_id` is **not** bound to A by the self-wake, and the wake
    prompt follows the existing task-request precedence (`build_wake_prompt` accept-task step,
    notifier.py:621-630). **Round-9 B1 sub-case:** as in item 15, arrange an independent reason
    `wake_task_id` resolves to **A** and assert the built persona **omits the resume section**
    (`render_resume=false`, `resume_rendered=false`) even though `get_agent_protocol(task_id=A)`
    returns `resume_context`. After an ack **without** `clear_self_wake`, A's row is **still
    scheduled**; then once the task request is accepted (no longer owed) a later scan fires A's
    self-wake normally and renders its context. (Same inject-and-clear-without-acting divergence as
    auto-start, item 15, now on the task-request axis.)
18. **Failed ephemeral spawn never clears — row survives (round-7 blocker teeth).** A due self-wake
    for task **A** is picked up on the **ephemeral** transport and injected (`self_wake_injected=true`,
    persona built), but `spawn_headless` returns **`sent=false`** (simulate the no-`claude` / bad-cwd /
    Popen-error path). Assert the notifier's ack payload carries **`kind="ephemeral_failed"`** (the
    `kind if sent else f"{kind}_failed"` branch, notifier.py:3213) and **omits both**
    `clear_self_wake` and `self_wake_task_id` (the new `sent` gate, §6.4/§7), so the server's
    `wake_ack` deletes **nothing** and A's self-wake row is **still scheduled**; then assert a
    subsequent scan with a **successful** ephemeral spawn (`sent=true`) injects `resume_context` and
    *its* ack (`kind == "ephemeral"`, `self_wake_injected=true`) clears the row exactly once.
    (Clear-only-on-successful-delivery: a persona that was built but never booted a worker never
    consumes the wait-point — the exact hole where a failed spawn would delete an unread wake.)
19. **Successful spawn but unrendered context never clears — row survives (round-8 blocker teeth).** A
    due self-wake for task **A** is picked up on the **ephemeral** transport (`self_wake_injected=true`)
    and `spawn_headless` returns **`sent=true`**, but the protocol GET inside `_build_persona` **fails**
    — simulate `_get_json` returning `None` for the `/protocol` URL (URLError/HTTP error/bad JSON,
    notifier.py:479-484) so `format_persona` renders **no** resume section. Assert `_build_persona`
    reports **`resume_rendered=false`**, that the notifier's ack payload (`kind="ephemeral"`,
    `sent=true`) nonetheless **omits both** `clear_self_wake` and `self_wake_task_id` (the new
    `resume_rendered` gate, §6.4/§7), so the server's `wake_ack` deletes **nothing** and A's self-wake
    row is **still scheduled**; then assert a subsequent scan whose protocol GET **succeeds**
    (`resume_rendered=true`) injects `resume_context` and *its* ack clears the row exactly once.
    (Clear-only-on-rendered-delivery: a worker that booted but never received the resume-section — an
    API blip on the protocol fetch — never consumes the wait-point; it re-fires and self-heals.)
20. **Blank/whitespace context rejected — no empty-payload hot-loop (round-9 B2 teeth).** POST
    `/self-wake` with `context=""` and with `context="   "` (whitespace only) → **422** at the
    endpoint (the trim-and-reject validation, §6.1); assert **no** `agent_self_wake` row is written.
    Also assert the DB CHECK (`btrim(context) <> ''`, §5) rejects a direct empty insert. Then a valid
    non-empty context schedules and (item 3) clears normally. (Guarantees `resume_rendered=false` can
    only mean a genuine non-ride or a transient GET blip — never a permanent empty-payload loop where
    the one-shot re-fires on every scan and never clears.) Also assert `context` over 2 KB is rejected
    (the length cap, §6.1/§11 item 2).

Notifier (pure-function tests, the style of the existing `build_wake_prompt` /
`derive_wake_event` / `format_persona` tests): `derive_wake_event` returns `self_wake`;
`build_wake_prompt` self-wake branch text; `_render_resume_context` renders only when present **and**
`render_resume=true`; `_build_persona` returns `resume_rendered=true` **only** when the scan bound the
self-wake (`self_wake={"injected": true, "task_id": T}`) **and** `task_id==T` **and** the protocol
carries a non-empty `resume_context`, and `false` when any of those fails — the (stubbed) protocol GET
returns `None` (round-8), **or** `self_wake["injected"]` is false / `task_id != self_wake["task_id"]`
(round-9 B1 deferral: the persona omits the resume section even though the protocol carried one); and
the ack-field helper sets
`clear_self_wake` **only** for a **successful, rendered** ephemeral delivery — `sent=true` **and**
`kind == "ephemeral"` **and** `self_wake_injected=true` **and** `resume_rendered=true` — asserting that
tmux/unreachable, `self_wake_injected=false`, a failed spawn (`sent=false` → `ephemeral_failed`),
**and a successful spawn with `resume_rendered=false`** all leave both `clear_self_wake` and
`self_wake_task_id` unset.

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

1. **Reschedule ergonomics.** Should a self-wake that fires but finds the external step *still*
   not ready require an explicit new `self-wake` call (current plan), or support an optional
   auto-reschedule/backoff? Plan keeps it explicit (one-shot) for simplicity; flag if a bounded
   auto-retry is wanted.
2. ~~**Context size cap.**~~ **Resolved (round-9 B2):** `context` is **required, non-empty after
   trim, and capped at 2 KB** — enforced at the API layer (§6.1) and backed by the DB `NOT NULL
   CHECK (btrim(context) <> '')` (§5). At implementation time, prefer an existing `MAX_*` byte
   constant if one fits the 2 KB intent rather than introducing a new literal.
