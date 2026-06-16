# Orcha Portal-Only Pivot — Detailed Task Breakdown (subtasks · why · verify)

> Companion to `orcha-portal-pivot-plan.md` (the mental model). This is the granular, assignable
> version: every task → subtasks, **why** it exists, and a concrete **verification** method.
> Base = `origin/main` (PR #41 A+B+C merged). Order: Phase 0 (verify shipped) → 0.5 (refactors) →
> 1 Engine → 2 Continuity → 3 Surface → E2E.

## Global requirements (apply to EVERY task)
- **G1 — Standard approval control (NEW).** Every human-decision surface in the portal — task
  verify/reject, decision-checkpoint approve/STOP, plan approvals, prompt approvals, authoritative-close
  — renders a **consistent `[Approve]` `[Reject]` pair plus a free-text "reason/decision" field**
  (required on Reject, optional on Approve). The decision + reason are **persisted** (auditable) and
  **routed back to the agent** so it sees *why*, not just yes/no. Build it once as a shared UI + API
  primitive and reuse everywhere.
  *Verify:* every approval surface shows the same control; Reject without a reason is blocked; the agent
  receives `{decision, reason}` on its next wake; decision+reason is queryable in the DB/thread.
- **G6 — _RETIRED 2026-06-12._** The former "Postman collection stays in lockstep (MANDATORY)" gate
  is no longer in force. The API contract's source of truth is now the generated **Swagger / OpenAPI**
  spec (`/docs`, `/openapi.json`); reviewers verify routes/schemas against it. (Replaces the
  hand-maintained `docs/orcha.postman_collection.json` + its `FT-DEPLOY-4` parity guard. See
  `docs/orcha-review-protocol.md` §4.)
- **G2 — Plan-first gate.** Each task posts an implementation plan to its thread and awaits human
  approval before code. *Verify:* a plan message exists + an Approve before the first code commit.
- **G3 — Behavior-preserving + tests green.** Full suite green BEFORE and AFTER; no unrelated behavior
  change. *Verify:* CI green on the PR; no route/contract drift unless the task says so.
- **G4 — Isolated worktree off origin/main → PR.** Each task in its own git worktree branched off the
  current `origin/main`; opens a PR. *Verify:* PR base = origin/main, branch is single-purpose.
- **G5 — Never self-certify.** Work stops at `needs_verification`; a human `/orcha-verify`s. *Verify:*
  task never auto-completes.

---

## PHASE 0.5 — ENABLING REFACTORS

### R1 — Incremental migration runner  (Forge)
*Why:* `001_init.sql` runs only via Postgres initdb on a FRESH volume → no way to add a table to a live
DB (cause of manual psql + wipe-on-reinit). The pivot adds tables, so this unblocks everything.
- **R1.1** ledger `schema_migrations(version PK, applied_at)`, created in code (not in 001). *Verify:* table exists; `001` untouched.
- **R1.2** baseline backfill: if `001` not recorded but schema present → record `001` applied without re-running. *Verify:* existing volume → `001` recorded, rows intact.
- **R1.3** runner applies `migrations/*.sql` lexically, each in own txn, skip-if-applied, halt-loud on failure, `pg_advisory_lock`. *Verify:* `999_probe.sql` → run=applied, run again=no-op; bad migration halts + isn't recorded.
- **R1.4** boot wiring: portal startup runs it after DB-healthy; mount `./migrations` into portal; `orcha up` auto-applies; add `orcha migrate`. *Verify:* `orcha up` on existing volume applies a pending migration, **rows survive (no wipe)**.
- **R1.5** keep initdb for fresh installs. *Verify:* fresh `orcha init` → full schema AND existing DB → `002+`.
*Verify (task):* `tests/test_migrations.py` green; live demo on the running stack (probe migration, rows survive).

### R2 — Event-consumer model: decide + harden  (Forge + Tim)
*Why:* `/wait` is cursor-based at-least-once; mutations 409 on repeat (safe, not idempotent) — findings
`d94727e7` + `97b1fdf5`. The pivot adds prompt/resume events + routes output through the bus.
- **R2.1** DECISION DOC: server-side per-consumer offset/ack vs robust client cursor. *Verify:* written decision + chosen contract reviewed.
- **R2.2** wake/inbox routine **drains the full open set** on a wake (not one event). *Verify:* 3 pending requests + one wake → all 3 handled.
- **R2.3** mutation endpoints **idempotent** (respond/close/accept return current state 200 on repeat). *Verify:* repeat a close → 200 no-op, not 409.
- **R2.4 (NEW, concurrency)** single-flight wake guard: the daemon must not spawn multiple concurrent workers for the same agent/task. *Verify:* assign one task → exactly ONE worker spawned (we observed 2 — regression-test this).

### R2.5 — Consumer checks status before mutating  (NEW — ISS-24)
*Why:* an agent answering without re-checking causes duplicate/stale responses + `409 already-answered`
(double-listener: daemon + live `/orcha-listen` both answer). Server-side R2.3 made mutations idempotent;
this is the **consumer-side** half.
- **R2.5.1** `/orcha-respond` (and `/orcha-listen` auto-accept/auto-close handlers) **re-read the request
  and skip if already `answered`/`closed`** before posting. **R2.5.2** same discipline for task actions
  (check task still actionable before acting). *Verify:* fire two responders at one open request → exactly
  one answers, the other no-ops cleanly (no 409, no duplicate); auto-close on an already-closed req = noop.

### R3 — Split `main.py` into routers  (Frame/Forge) — ⏸ DEFERRED (unassigned)
*Why:* 2,396 LOC / 40 routes; everyone edits it for the pivot → conflicts + churn.
- **R3.1** extract routers (agents, tasks, requests, events/wait, wake, digest, portal-pages) into `app/`. *Verify:* import graph clean.
- **R3.2** behavior-preserving. *Verify:* all 40 routes respond identically; full suite green; route/OpenAPI list unchanged.

> **Sequencing decision (2026-06-01, Tim + kedar):** R3 is a pure, behavior-preserving refactor — zero new
> capability — so it does **not** sit on the critical path. Doing it *now* is counter-productive: A1/watchdog
> is in flight and **A2** adds a `worker_runs` table + read endpoint *inside `main.py`*, so splitting the file
> mid-A2 would create the very merge churn R3 exists to prevent. **Do R3 once, on a stable base, in this
> window:** after `A1 + ISS-15 watchdog` + `A2 (worker-runs endpoint)`, and **before** the B-series Surface
> build (which will add many endpoints — they should land into clean routers, not the monolith). Net order:
> **A1+watchdog → A2 → R3 → A3 + B-series.** Safe to do then: R3 touches no routes, so route↔contract parity
> stays intact (verify via Swagger `/openapi.json` — _FT-DEPLOY-4 parity guard retired 2026-06-12, Swagger is source of truth_). Left **unassigned** until that window opens.

---

## PHASE 1 — ENGINE (Forge): worker = a real, observable, safe execution path

### A1 — Capture worker output
*Why:* worker stdout/stderr → /dev/null today, so the portal can never show progress.
- **A1.1** capture each wake-run's stdout/stderr. **A1.2** tag it (agent, wake_id, task). *Verify:* trigger a wake → that run's text is retrievable + non-empty.

### A2 — Persist + expose worker output  (needs R1 for the table)
*Why:* the portal (B1) needs output as queryable data.
- **A2.1** `worker_runs` table (migration `002_*` via R1): run_id, agent_id, task_id, started/ended, output, exit. **A2.2** read endpoint `GET /api/agents/{id}/runs` / per-task runs. *Verify:* after a wake, `GET` returns the run's reasoning/progress.

### A3 — "prompt" event type  (needs R2 decision)
*Why:* lets the portal prompt an agent (B2) via the bus.
- **A3.1** new `prompt` agent_event carrying a human message. **A3.2** daemon treats it as a wake trigger; worker sees the prompt in context. *Verify:* insert a prompt event for X → X wakes → its worker references the prompt text.

### A4 — "resume in-progress task" wake trigger  (needs C1/C2)
*Why:* long tasks must continue across one-shot worker sessions.
- **A4.1** wake-scan flags an idle agent owning an in_progress task with unfinished work. **A4.2** daemon re-wakes; worker continues from the digest. *Verify:* long task → worker exits partial (still in_progress) → re-woken → 2nd session advances the SAME task.

### A5 — Narrow tool-allowlist (drop `--dangerously-skip-permissions`)
*Why:* unattended workers currently run with FULL permissions (live security gap, visible in process args).
- **A5.1** define a `settings.json` allowlist (orcha API calls, in-project read/write, git). **A5.2** boot workers with it instead of `--dangerously-skip-permissions`. *Verify:* woken worker performs an allowed op (post to orcha) AND a disallowed op (delete outside project / arbitrary network) → allowed succeeds, disallowed denied.

---

## PHASE 2 — CONTINUITY (Vault): N wakes read as ONE agent

### C1 — Digest write-on-exit
*Why:* a worker's reasoning is lost on exit unless snapshotted; continuity needs it.
- **C1.1** worker snapshots digest (focus/decisions/learnings/open_threads) before exit (on `/orcha-done` + on bounded-turn end). *Verify:* after a wake, the agent's latest digest reflects the new focus/decisions.

### C2 — Digest rehydrate-on-boot
*Why:* a fresh worker must continue as the SAME agent, not from scratch.
- **C2.1** spawned worker loads the latest digest into context at boot. *Verify:* wake X twice on one task → 2nd worker references the 1st's decisions/open-threads.

### C3 — Summaries (future seed)
*Why:* condense long threads for the human portal view.
- **C3.1** endpoint summarizing a task/agent thread (needs the Haiku/API-key decision). *Verify:* request a summary → coherent condensed text. *(Deferred from v1.)*

---

## PHASE 3 — SURFACE (Frame): the portal is the only thing the human touches

### B0 — Shared approval-control primitive  (NEW — implements G1; do before B3/B4)
*Why:* one consistent Approve/Reject+reason control, reused by every decision surface.
- **B0.1** UI component: `[Approve]` `[Reject]` + reason textarea (required on Reject). **B0.2** a uniform decision API/shape `{decision: approve|reject, reason}` persisted + emitting an event the target agent consumes. *Verify:* drop the component on a dummy decision → Approve/Reject+reason persists, Reject-without-reason blocked, agent receives `{decision,reason}` next wake.

### B1 — Show worker progress  (needs A2)
*Why:* the human must see what a headless worker is doing.
- **B1.1** render A2's run output as a live feed in the task/agent view. *Verify:* after a worker runs, portal task view shows its progress text.
- **B1.2 — log-type taxonomy, FINAL 9 types (kedar 2026-06-02).** The feed classifies a worker's stream
  into: (1) **narration** — assistant text; (2) **tool call** — name + summarized input; (3) **tool
  result** — collapsible; (4) **code diff** — ⭐ see B1.3; (5) **orcha action** — *self*-actions only
  (claim task, post progress, mark done); (6) **decision** — B0 `decision_made` inline; (7) **lifecycle** —
  wake start/kind, completion/exit, **watchdog-killed**, errors, rate-limit; (8) **hooks/thinking** —
  collapsed by default; (9) **inter-agent request (in/out)** — split OUT of #5: requests this agent
  sent/received, with **direction + status (open/answered/closed) + thread**, so the collaboration graph is
  first-class. *Verify:* a run renders each present type correctly, classified not raw; request-in/out shows
  direction + lifecycle distinct from self-actions.
- **B1.3 — ⭐ code diffs (MUST-HAVE, kedar 2026-06-02).** Render the worker's file changes as a real
  **colored unified diff** (diff2html or similar). **Source = ISS-8's `worker_runs.diff`** (the net
  `git diff vs origin/main`, full-fidelity — catches Bash/sed edits, edit-undo nets empty) — now shipped,
  so B1 uses it directly (no interim `Edit`/`Write` parse needed). Served via `GET /api/agents/{aid}/runs`
  + `/tasks/{tid}/runs`. *Verify:* a worker that edits files shows a viewable colored diff in the portal.

### B8 — Model selector from the portal  (NEW — kedar 2026-06-02)
*Why:* the human should choose which model an agent/worker uses, with options visible.
- **B8.1** portal shows the available models (**Opus 4.8 / Sonnet 4.6 / Haiku 4.5**) and lets the human set
  the model per-agent (and/or per-task). **B8.2** the notifier launches the worker with the chosen
  `--model`. *Verify:* set an agent to Haiku in the portal → its next wake's worker runs on that model
  (confirm via the run record / stream-json).

### B10 — Plan-approval portal surface (implements G2; uses B0)  (NEW — kedar 2026-06-02, flagged by Frame)
*Why:* **G2 (plan-first gate) has no portal surface today.** The portal only shows Approve/Reject on
`needs_verification` tasks (B4) and renders task threads READ-ONLY, so a human cannot approve an
*in-progress* task's plan from the portal — approval only happens via `/orcha-post`/API (recorded by hand
as a human thread message). Sibling to B3 (requests) / B4 (verify): a third decision surface, all reusing
the **B0** control (currently mounted only on the `?demo=decision` dummy).
- **B10.1** mount the B0 Approve/Reject+reason control on the **in-progress task's plan message**
  (`subject_type=plan_approval`, `target_agent_id=`the assignee). **B10.2** the decision + reason routes to
  the assignee (so it sees approval/feedback on next wake) and is recorded — not a hand-typed thread note.
  *Verify:* a task posts a plan → human clicks Approve/Reject+reason in the portal → assignee receives
  `{decision, reason}` next wake; a reason-less Reject is blocked; the approval is queryable (a real
  `decisions` row), not just free-text on the thread.

### B11 — Create / register an agent FROM the portal  (NEW — kedar 2026-06-02; required for terminal-free)
*Why:* portal-only means you must be able to add an agent without a terminal. The **API already exists**
(`POST /api/containers/{cid}/agents` — alias/role/prompt; + `POST /api/agents/{id}/reachability` for
wake) — what's missing is the **portal surface**. Use case proven: we created **Invy** (a headless-only
test worker, wake-on + no live tab) via the API to kill the live-tab test confound; that creation should
be a portal action.
- **B11.1** portal form: alias + role + system prompt → `POST …/agents`. **B11.2** options: set
  reachability/wake (incl. a **"headless-only"** toggle = wake on, no tab) so an operator can spin up a
  daemon-only worker like Invy. **B11.3** the new agent shows in the roster immediately.
  *Verify:* create an agent from the portal → it appears in the roster + is wakeable; a headless-only one
  is driven solely by the daemon. *(Keep the agents-suggest / humans-decide rule: this is a HUMAN action.)*

### B9 — Run any Claude skill from the portal  (NEW — kedar 2026-06-02; generalizes B2)
*Why:* the human should trigger any skill on an agent without a terminal.
- **B9.1** portal affordance to invoke any `/orcha-*` (or other) skill on a chosen agent — posts a prompt/
  command event the woken worker executes. **B9.2** the result/progress surfaces via the B1 feed.
  *Verify:* run e.g. `/orcha-snapshot` on an agent from the portal → the worker executes it → output
  appears in the feed.

### B2 — Prompt an agent from the portal  (needs A3)
*Why:* prompting must move from terminal to portal.
- **B2.1** UI box that posts an A3 `prompt` event. *Verify:* type a prompt → agent wakes → reply appears in the thread.

### B3 — Approve/Reject requests  (uses B0/G1)
*Why:* agent→human requests answered in-portal, with rationale.
- **B3.1** list human-addressed requests; **B3.2** Approve/Reject via the B0 control. *Verify:* worker posts a human request → human Approve/Reject + reason → worker sees `{decision,reason}` next wake.

### B4 — Verify/sign-off + decision-checkpoint  (uses B0/G1)
*Why:* the human-authoritative gate, in the portal, with reasons.
- **B4.1** Verify/Reject on `needs_verification` tasks via B0 (reason routes to the agent — supersedes the bare P1 buttons). **B4.2** decision-checkpoint: agent surfaces a decision → human Approve / Reject(=STOP) + reason via B0. *Verify:* needs_verification → Approve→completed / Reject+reason→back to in_progress with the reason on-thread; checkpoint Reject halts the agent with the reason.

### B5 — Assign a task from the portal
*Why:* task assignment moves to the portal.
- **B5.1** create + assign a task to an agent from the UI → wakes the agent (A's task_assigned + auto-start). *Verify:* assign in portal → agent woken → begins.

### B6 — Continuous-agent view  (needs C1/C2)
*Why:* successive wakes must read as ONE agent, not disjoint sessions.
- **B6.1** render a same-agent's wakes + digest as one coherent timeline. *Verify:* multiple wakes of X → single continuous thread in the portal.

### B7 — Human close/cancel authority over ANY task or request  (NEW — ISS-23; uses B0)
*Why:* the human is the authoritative party but today close is owner-scoped (only a request's requester
can close it). The human must be able to abandon a stale request or force-close a task regardless of owner.
- **B7.1** API: a `kind='human'` actor may close/cancel **any** task or request (override the owner-only
  rule), audited. **B7.2** the reason is routed to the owning agent via the **B0** decision primitive
  (so the agent learns *why* its item was closed). **B7.3** portal affordance: a Close/Cancel control on
  any task/request, using the B0 Approve/Reject+reason surface. *Verify:* a human closes a request they
  did NOT create → it goes `closed`; the owning agent receives a `{decision, reason}` event next wake;
  a non-human actor attempting the same is rejected.

---

## PHASE 3.5 — PORTAL REDESIGN (design-system adoption)  (Frame; NEW — kedar 2026-06-03)
Source artifact: **`docs/portal-redesign-ref/`** — a Claude-Design handoff (evolved teal-orca brand,
Quantal amber-dot maker mark, dense operational dashboard, full light/dark via tokens). Vanilla
HTML/CSS/JS, built to lift straight into the static portal. **NOTES.md** has the rationale; **chat** has intent.

> **This is a cohesive replacement, not a bolt-on.** It SUBSUMES the bespoke per-page CSS and several open
> UX items — build those items ONCE, inside the matching D-task, instead of twice. The backend/logic from
> in-flight work (B0 decisions, B10, SSE client `199982a9`, verify) is REUSED; only the per-page HTML/CSS is
> replaced by the shared system. **Recommended sequencing:** land D0+D1 (foundation) first, then adopt
> page-by-page (D2→D5), folding each open ISS/B item into its page. Honors the gate: queue behind the
> current open items (ISS-39/29/40, C1) clearing.

### D0 — Design-system foundation (shared)  (do first)
*Why:* one token + component system replaces four bespoke stylesheets; the status pill, avatar, shell,
deeplinks, modal, toast and theme toggle become shared + consistent.
- **D0.1** add `styles.css` (token layer + components; light/dark/`auto` via `[data-theme]` + `prefers-color-scheme`).
- **D0.2** add `app.js` (sidebar+topbar `mountShell`, `pill()`/`avatar()`/`kindBadge()`, `agentLink`/`taskLink`/`requestLink`, `renderDiff`, `runCard`+`activateRuns`, modal, toast, `/`-search, theme cycle). **Make "acting as" data-driven** — use the real `kind='human'` agent, not the hardcoded `"Dario"`.
- **D0.3** make `window.ORCHA` a **live, mutated-in-place** object so `app.js`'s captured `D` reference stays valid across the existing 3s refresh. *Verify:* every page mounts the same shell; theme persists; pills/avatars render identically in list + detail. *Absorbs:* **ISS-34** (consistent prominent status pill).

### D1 — Live data adapter (snapshot → `window.ORCHA`)  (do first)
*Why:* the design reads one `window.ORCHA` object; in production that's the FastAPI snapshot.
- **D1.1** replace static `data.js` with a loader: `GET /api/containers` → `GET /api/containers/{cid}`, map `{container, agents, tasks, requests}` → the component shape (`container`, `agents`+`byAlias`, `tasks`, `requests`), mutate in place, re-render on the 3s cadence; honor `?cid=` + 1:1:1 auto-resolve.
- **D1.2** field mapping + graceful fallbacks: agent `kind`(have)/`model`(B8)/`wake_enabled`(reachability)/`current_task`(derive: in_progress assignee)/`last_active`; task `assignee`(`assignees[0]`)/`priority`/`plan`(D7)/`runs`(D6); request `from`/`to`(alias-resolve `requester_id`/`target_id`; null target→`human`)/`chain_depth`(have)/`task_link`. *Verify:* all four pages render live container data with no console errors; missing fields show `—`, never `undefined`.

### D2 — `home.html` — dashboard / control room
*Why:* "what needs me right now" becomes the hero; replaces the current stub-card home.
- ctxbar (container) · **"Needs your attention" action queue** (needs_verification + open escalations) · agents-at-a-glance table · live-activity strip (from `GET /api/containers/{cid}/events` or recent runs) · tasks-by-status kanban. *Verify:* action queue counts match DB; each card one click from acting; kanban groups by status.

### D3 — `agents.html` — activity hub + detail
*Why:* one place to watch everything about one agent.
- roster (pill, role, current task, model, wake, human/AI, last-active) + detail: persona, **memory digest** (`/digest`), **model + wake controls** (B8 + reachability), **requests in/out**, **run history** (`/runs`), bidirectional deeplinks. *Absorbs:* **ISS-33** (agent-view plan-approval, no dead-end), **ISS-36** (status root-caused + approval surfacing decoupled from status), **ISS-35/38** (deeplinks); implements **B6** (continuous-agent timeline = digest+runs) + the **B8** surface.

### D4 — `tasks.html` — list + thread + plan-approval/verify GATE
*Why:* the human-authority surface, in the new system.
- list **ordered status-first then time** with prominent pills + assignee deeplink; detail thread (`/messages`); the **GATE** — plan + DoD + diff together, approve/reject with **required-reason-on-reject** → `POST /api/decisions` + verify; runs+diffs. **Gate the plan card on the DURABLE decision (ISS-41), not session memory** — once a `plan_approval` exists, show the decided-note (who·when·reason), never re-ask; keep the session Set as optimistic UI only. *Absorbs:* **ISS-32** (plan card scrollable), **ISS-33** (no dead-end), **ISS-34/35/37**, **ISS-41** (re-surfacing approval); reuses **B0 + B10 + B4 + B7**.

### D5 — `requests.html` — list + detail + chains
*Why:* walkable agent↔agent comms with escalation.
- list + detail with **chains** (`in_service_of`/`chain_depth`), escalate-to-human, answer, convert-to-task, both parties deeplinked. *Absorbs:* **ISS-38**; reuses **B3** + the request-chain view.

### D6 — Live run feed (SSE) wiring  (needs ISS-39 fixed)
*Why:* the marquee "watch your agent work".
- point `app.js` `startLiveFeed` at `GET /api/agents/{aid}/runs/{run_id}/stream`; classify the 9 types; collapsible sections **survive the 3s refresh**; tear the `EventSource` down on view change. *Depends on:* **ISS-39** (backend stalls at `seq 1`) fixed first. *Absorbs:* **B1** (worker-progress feed), the SSE client `199982a9`, **ISS-28** (sections stay open).

### D7 — Backend snapshot enrichment (fields the design needs)  (verify routes/schemas via Swagger `/openapi.json` — G6 retired 2026-06-12)
*Why:* the design surfaces fields not in today's `/api/containers/{cid}` payload.
- add per-agent `model`(B8) / `wake_enabled`(reachability join) / `current_task` / `last_active`; per-task `plan` summary (earliest non-human message) + **`plan_decision` (latest `plan_approval` for the task — so the card suppresses durably, ISS-41)** + light `runs` summary; per-request `task_link`. Accept light extra detail-endpoint calls where a join is awkward. *Verify:* routes/schemas appear correctly in Swagger `/openapi.json` (G6/FT-DEPLOY-4 retired 2026-06-12).

### D8 — Deferred design screens (after the core 4)
`run.html` (standalone SSE feed → folds into **D6/B1**) + `new-agent.html` (create-agent form → **B11**). The
designer flagged these as the natural next two; not in the core-4 first pass.

---

## ACCEPTANCE — terminal-free E2E
From the portal ONLY: prompt X (B2→A3) → X works, progress shows (A1/A2→B1) → X asks via the approval
control, exits → human Approve/Reject+reason in portal (B0/B3) → fresh same-X resumes with context
(C1/C2, A4) → task → needs_verification → human verifies+reason (B4) → completed. **No terminal touched;
portal reads as one continuous agent; every human decision carried a reason.** That pass = pivot done.
