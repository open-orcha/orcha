# Orcha Portal-Only Pivot — Testable Breakdown (mental model)

> Goal: **terminal-free Orcha.** The PORTAL becomes the sole human surface; headless
> `claude -p` workers (booted AS the agent: persona + Epic C digest + ORCHA_ALIAS) are the
> execution path. Continuity holds because every wake re-spawns the SAME agent, so the portal
> reads as one continuous agent. Human↔agent is async/turn-based via DB-as-bus + the wake daemon.
> Draft by Tim (task 8e6dd726). STATUS: **PR #41 (collated A+B+C) is MERGED to `origin/main`** — that
> clean base is what Phase 0.5 (refactors) and the pivot branch off, each task in its own worktree (Q1).

## The loop we're building (the "bigger picture")
```
 Human (portal)                  DB-as-bus + wake daemon              Headless worker (= the agent)
 ─────────────                   ──────────────────────              ─────────────────────────────
 1 prompt agent X  ───event───▶  2 daemon detects, wakes X  ───────▶ 3 boot AS X (persona+digest+alias)
                                                                      4 read inbox/task, do a bounded turn
 7 see progress  ◀──portal────   6 output routed to DB  ◀──────────  5 post progress/question, snapshot
 8 answer / approve / verify ─▶  (new event) ─▶ wake fresh X  ──────▶  continue from digest (same agent)
                                 (resume-trigger re-wakes for long tasks until task → needs_verification)
 9 verify/sign-off in portal ─▶  task completed
```
Three layers compose it: **Engine** (A/Forge), **Continuity** (C/Vault), **Surface** (B/Frame).
Each step below is independently testable — listed in rough dependency order.
**Layer 0 verifies what is ALREADY shipped** (the merged A/B/C deployed on the live stack) — do these
first to confirm the foundation before the pivot builds on it.

## Layer 0 — VERIFY ALREADY-SHIPPED (regression baseline on the live stack)
### Epic A already done (PR #41) — wake engine
- **VA1 — Reachability registry.** `POST /api/agents/{id}/reachability` stores headless_cwd/tmux_target/
  wake_enabled; readable back. *Verify:* set reachability → query → fields persisted.
- **VA2 — wake-scan.** `GET /api/containers/{cid}/wake-scan` lists idle agents with pending work +
  transport/idle/cooldown. *Verify:* agent with a pending event shows up as a candidate.
- **VA3 — Headless wake.** Daemon spawns `claude -p` for an idle agent with pending work; worker drains
  its inbox. *Verify:* (DONE earlier — Forge woke headless and answered a request).
- **VA4 — tmux wake.** `send-keys` into a live pane wakes the in-tab agent in place. *Verify:* agent
  running in a tmux pane gets a turn injected. **(NOT yet verified — needs an agent in tmux.)**
- **VA5 — wake-ack + cooldown audit.** `agent_wake_state` records last_wake_kind/event/time; repeat
  within cooldown is debounced. *Verify:* after a wake, row updated; immediate re-scan skips it.
- **VA6 — Auto-start on ready task.** Assigned + ready + idle agent auto-claims+begins, and NEVER crosses
  the verify gate. *Verify:* assign a ready task → agent auto-starts → still stops at needs_verification.
- **VA7 — Targeted task_ready.** Completing a dependency emits task_ready to the assignee. *Verify:*
  finish a dep → assignee receives task_ready.
- **VA8 — Cron stopgap.** `orcha notifier --once` catches a previously-missed event. *Verify:* idle agent
  + pending event → one tick issues the wake (DONE in dry-run + real).
- **VA9 — Wake ON by default / opt-out.** wake_enabled defaults true; false disables. *Verify:* set
  false → daemon skips that agent.

### Epic B already done (PR #40, P1+P2) — portal write actions
- **VB1 — Portal Verify (approve).** Click Verify on a needs_verification task → completed, downstream
  unblocked, task_verified emitted. *Verify:* in portal + DB.
- **VB2 — Portal Reject.** Reject w/ feedback → task→in_progress + a `[verification rejected]` thread
  message + task_verified(feedback). *Verify:* agent sees the feedback next wake.
- **VB3 — Acting-as identity.** Auto-act-as the sole human, else an "Acting as" picker (localStorage),
  no-auth MVP. *Verify:* the verify action carries the human actor_id.
- **VB4 — 422 body-cap fix.** Over-length `/messages` POST returns a CLEAR error (not a silent 422).
  *Verify:* post an over-length body → explicit message.
- **VB5 — close-implications endpoint.** `GET /api/tasks/{tid}/close-implications` aggregates downstream/
  blocked tasks, in-flight agents, open child requests, spawned_task_id. *Verify:* correct counts for a
  task with deps + children. **(P3 HOLD + decision-checkpoint are GATED — not in this baseline.)**

### Epic C already done (PR #39) — memory digest + resume
- **VC1 — Digest write.** `/orcha-snapshot` (or POST digest) stores a snapshot row (current_focus,
  decisions[], learnings[], open_threads[]). *Verify:* snapshot → new row in agent_memory_digests.
- **VC2 — Digest read.** `GET` returns the latest digest for an agent. *Verify:* GET → newest snapshot.
- **VC3 — SessionStart rehydrate.** `orcha rehydrate` / the hook loads the latest digest into a new
  session. *Verify:* fresh session shows the agent's prior focus/decisions ("where we left off").
- **VC4 — Ownership boundary intact.** Digest lives in shared Postgres (portal-visible, agent-authored);
  Claude Code file-memory is untouched (no sync). *Verify:* digest in DB; ~/.claude memory unchanged.

> Note the pivot REUSES these: VA3 headless-wake → A1/A2 add output capture; VC1–VC3 digest mechanism →
> C1/C2 make it fire automatically in the worker lifecycle; VB1–VB5 → B1–B5 surface human actions in the
> portal. Layer 0 = "the parts exist and pass"; Layers 1–3 = "wire them into the terminal-free loop."

## Phase 0.5 — ENABLING REFACTORS (do on origin/main FIRST, before the pivot)
Behavior-preserving; full test suite green before AND after each step. Only what the pivot directly
stresses — not a cleanup spree. Merge these to origin/main, then pivot tasks branch off the refactored base.

### R1 — Incremental migration runner  [HIGHEST — do before ANY new schema]  (owner: Forge/infra)
*Why:* `migrations/001_init.sql` runs ONLY via Postgres initdb on a FRESH volume — there is no way to add
a table to a live DB (the cause of the manual `psql` replays and the wipe-on-reinit pain). The pivot adds
new tables (worker output, prompt plumbing, maybe consumer offsets), so fix this first.
- **R1.1 — `schema_migrations(version PK, applied_at)` + mark 001 as the applied baseline.**
  *Verify:* table exists, 001 recorded as applied, existing rows untouched.
- **R1.2 — runner applies `migrations/*.sql` in lexical order, each in its own txn, skipping
  already-applied (idempotent).** *Verify:* add a throwaway `999_probe.sql` → run → applied+recorded;
  run again → no-op.
- **R1.3 — wire the runner into boot** (portal startup after DB-healthy, plus `orcha up` / `orcha migrate`).
  *Verify:* `orcha up` on an EXISTING volume applies a pending migration WITHOUT wiping (rows survive).
- **R1.4 — keep fresh-init whole** (initdb baseline OR runner-from-empty; record baseline either way).
  *Verify:* fresh `orcha init` produces the full schema AND an existing DB receives `002+`.
*Outcome:* future schema ships as `002_*.sql`, applied by `orcha up` to the live DB — no wipe, no manual
psql. Also closes the relaunch-safety footgun.

### R2 — Event-consumer model: decide + harden  [before new event types]  (owner: Forge + Tim)
*Why:* `/wait` is cursor-based at-least-once with a client flat-file cursor; mutations 409 on repeat
(safe, not idempotent) — findings `d94727e7` (queue-stranding) + `97b1fdf5` (request idempotency). The
pivot adds prompt + resume events and routes worker output through the same bus.
- **R2.1 — DECIDE the model:** server-side per-consumer offset/ack (a `consumer_offsets` table) vs keep
  the client cursor and make it robust. Write the decision down. *Verify:* decision doc + chosen contract.
- **R2.2 — wake/inbox routine DRAINS the full open set on a wake** (not one event). *Verify:* 3 pending
  requests + one wake → all 3 handled.
- **R2.3 — mutation endpoints idempotent** (respond/close/accept return current state 200 on repeat, not
  409). *Verify:* repeat a close → 200 no-op, not an error.
  *(R2.1's offset table may defer to a pivot task; R2.2/R2.3 are small + high-value now.)*

### R3 — Split `main.py` into routers  [before parallel endpoint work; optional but recommended]  (owner: Frame or Forge)
*Why:* `main.py` = 2,396 LOC / 40 routes; Forge/Frame/Vault are all about to edit it for the pivot →
merge conflicts + god-file churn. Mechanical, behavior-preserving split.
- **R3.1 — extract routers** (agents, tasks, requests, events/wait, wake, digest, portal-pages) into an
  `app/` package; `main.py` just wires them. NO path or behavior changes.
- **R3.2 — Verify:** all 40 routes respond identically, full test suite green, route/OpenAPI list unchanged.
  *(Do it as ONE isolated task, tests gating.)*

**Sequencing:** R1 → R2 (at least the decision) → R3, all merged to `origin/main` before pivot tasks
branch off it. R1 unblocks A1/A2's worker-output table; R2 unblocks A3/A4's new event types; R3 unblocks
parallel endpoint work in Layers 1 & 3.

## Layer 1 — ENGINE (Epic A / Forge): make a worker a real, observable, safe execution path
- **A1 — Capture worker output.** Stop sending the headless worker's stdout/stderr to /dev/null;
  capture it per wake-run.
  *Verify:* trigger a wake; retrieve that run's captured text (non-empty, matches what the worker did).
- **A2 — Persist + expose worker output.** Store each run's output keyed by (agent, wake, task) and
  expose a read endpoint.
  *Verify:* `GET` the run output for agent X; see its reasoning/progress as data (feeds B1).
- **A3 — "prompt" event type.** A new agent_event the daemon treats as a wake trigger carrying a
  human message.
  *Verify:* insert a prompt event for X via API → daemon wakes X → X's worker sees the prompt text.
- **A4 — "resume in-progress task" wake trigger.** Daemon re-wakes an idle agent that owns an
  in_progress task with unfinished work, so long tasks continue across worker sessions.
  *Verify:* assign a long task; worker does partial work + exits (task still in_progress); daemon
  re-wakes; a 2nd worker advances the SAME task. Observe ≥2 sessions moving one task forward.
- **A5 — Narrow tool-allowlist (drop --dangerously-skip-permissions).** Unattended workers run with a
  settings.json allowlist (orcha API calls, in-project read/write, git) — not full permissions.
  *Verify:* a woken worker performs an allowed op (post to orcha) AND a disallowed op (e.g. delete
  outside project / arbitrary network) → allowed succeeds, disallowed is denied. Ship early (safety).

## Layer 2 — CONTINUITY (Epic C / Vault): make N wakes read as ONE agent
- **C1 — Digest write-on-exit.** Before a worker exits, it snapshots its digest
  (current_focus, decisions[], learnings[], open_threads[]).
  *Verify:* wake worker, have it decide something; after exit the agent's latest digest row reflects it.
- **C2 — Digest rehydrate-on-boot.** A freshly-spawned worker loads the latest digest as context so it
  continues as the same agent (not from scratch).
  *Verify:* wake X twice on one task; the 2nd worker references the 1st's decisions/open-threads.
  (C1+C2 are the backbone of A4 and of the "continuous agent" portal view B6.)
- **C3 — Summaries (future seed).** Condense an agent/task thread into a human-readable summary.
  *Verify:* request a summary for a task → coherent condensed text. (Defer; Epic C seed.)

## Layer 3 — SURFACE (Epic B / Frame): the portal is the only thing the human touches
- **B1 — Show worker progress.** Render A2's routed output as a live progress/reasoning feed in the
  task (and agent) view.
  *Verify:* after a worker runs, open the portal task view → see its progress text appear.
- **B2 — Prompt an agent from the portal.** A UI box that posts an A3 "prompt" event.
  *Verify:* type a prompt in the portal → agent wakes → its reply shows up in the thread (E2E with A3).
- **B3 — Approve / reject requests.** Buttons on requests addressed to the human (extends existing P1
  verify/reject).
  *Verify:* worker posts a human request → human clicks approve/reject → worker sees the decision next wake.
- **B4 — Verify / sign-off in the portal.** The human-authoritative gate: verify needs_verification
  tasks + decision-checkpoint approve/STOP, all in-portal.
  *Verify:* task → needs_verification → human verifies in portal → completed. Checkpoint → approve/STOP works.
- **B5 — Assign a task from the portal.** Create + assign a task to an agent from the UI.
  *Verify:* create a task assigned to X in portal → X is woken (A's task_assigned + auto-start) → begins.
- **B6 — Continuous-agent view.** Present a same-agent's successive wakes as ONE coherent timeline.
  *Verify:* across multiple wakes of X, the portal shows a single continuous thread, not disjoint sessions.

## Dependency order (how the steps stack)
```
A5 (safety) ── ships first, independent
A1 → A2 ─────────────────▶ B1            (capture → expose → display)
A3 ─────────────────────▶ B2            (prompt event → portal prompt)
C1 → C2 ─────────────────▶ A4, B6       (continuity → resume-trigger + continuous view)
(existing P1/P2) ───────▶ B3, B4, B5    (portal human actions)
```

## The acceptance test (terminal-free, the whole point)
**E2E:** Using ONLY the portal — prompt agent X (B2→A3) → X wakes, works, progress shows (A1/A2→B1) →
X asks a question and exits → human answers in portal (B3) → fresh same-agent X wakes and continues with
context (C1/C2, A4) → task → needs_verification → human verifies in portal (B4) → completed. **No terminal
touched end-to-end, and the portal read as one continuous agent.** That E2E pass = the pivot is done.

## What is NOT changing
DB-as-bus, the wake daemon, headless workers booting as the agent, the request/task state machine, and the
human-authoritative gate all already exist. The pivot is: capture+route+display worker output, add the
prompt + resume triggers, lock down permissions, and move every human action into the portal.
