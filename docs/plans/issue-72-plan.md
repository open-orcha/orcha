# Plan — Issue #72: Drain turn closes a request-answered event without acting on it

**Status:** DRAFT — awaiting Code Reviewer plan-review (CLEAN) before any code is written.
**Owner:** CodeCleanupAgent. **Reviewer:** Code Reviewer. **DO NOT MERGE the eventual PR** — Kedar merges.

## Problem (from the issue)
When an answer (e.g. plan-review "CLEAN") arrives while a short-lived "drain"/sidecar body is alive,
the drain turn is (correctly) forbidden from starting task work — but it still **advances the wake
cursor** (`delivered_ts`) past the answer event and/or closes the request. That erases the only
"unhandled" signal, so after the live body exits **no fresh worker ever spawns** to do the unblocked
work. The loop goes silent on a green light. Non-deterministic (timing-dependent).

## Canonical source files (orcha-cli copies — desktop copy is gitignored/generated)
- `orcha-cli/orcha_cli/notifier.py`:
  - `build_resident_sidecar_drain_prompt` — the "would be a SECOND concurrent embodiment" contract
    (~L637–679); drain omits task auto-start by design.
  - drain sidecar success path advancing the cursor via `wake-ack` (`delivered_ts=ack_ts`,
    `release_lease=False`) (~L3310–3333).
  - `_suppress_wake` — auto-close answered request then advance cursor `kind='skipped'` (~L343–362).
  - single-flight spawn claim (`wake-claim`) (~L2417–2430); cursor-advance in `tick` (~L2542–2560).
- `orcha-cli/orcha_cli/templates/portal/main.py`:
  - `wake_scan` pending-events computation vs `delivered_ts` and `_NON_WAKING_EVENTS`.
  - `wake_claim` (atomic lease; `NOT EXISTS running worker_run`).
  - `wake_ack` (`delivered_ts = GREATEST(...)` monotonic cursor advance).
  - `triage_close_request` — flips answered→closed, publishes `request_closed`.
  - (Line numbers to be re-resolved in the orcha-cli copy at implementation time; the #72 map read
    the stale desktop copy.)
- Tests: `tests/test_iss288_wake_suppression.py`, `tests/test_r1_live_embodiment.py`,
  `tests/test_wake_single_flight.py`, `tests/test_iss307_graded_wake.py`.

## Root-cause statement
A drain turn (resident sidecar OR `_suppress_wake`) consumes the answer event in TWO ways that both
erase the trigger: (a) it advances `delivered_ts` past the event so `wake_scan` no longer counts it
as pending, and/or (b) it closes the request so `has_work` drops. Neither path guarantees a
follow-on task-bound worker. The work depends on luck (whether another body was alive).

## Design — pick one primary strategy (recommend Option A; B/C as fallbacks)

### Option A — Don't advance the cursor past *actionable* answer events in a drain turn (RECOMMEND)
Distinguish **housekeeping-drainable** events (pure notifications, acks) from **actionable**
events (a `request_answered` / `request_closed` that unblocks task work for *this* agent).
- In the drain sidecar success path, compute `ack_through_ts` so it acks only the
  non-actionable events and **parks the cursor *before* the actionable answer event**, leaving it
  pending. After the live body exits, the existing wake gate (`should_wake` once `lease_active`
  and `embodiment_running` clear) sees the still-pending event and spawns a proper task worker.
- A drain turn may still post a heartbeat / read context, but must NOT close a request whose
  closure would erase an unblocking trigger. (i.e. drain closes only "pure ack" requests via the
  existing #288 triage path; an answered *task* request that unblocks work is left answered.)

### Option B — Spawn-on-exit reconciliation
When a live body / drain sidecar exits (lease released), run a reconciliation pass: re-scan for
answer events that were acknowledged-but-not-actioned and re-arm them (reset cursor or enqueue a
synthetic wake) so the next notifier tick spawns a worker. Heavier; adds a reconciliation step to
the lease-release path.

### Option C — Defer-don't-drain for actionable events
At the point Orcha decides to fold an event into a live body (the drain decision), if the event is
classified actionable, **don't fold it** — leave it for a fresh task-bound worker once the live
body exits. Cleanest conceptually but changes the drain-vs-spawn decision surface.

**Recommendation:** Option A — smallest, most local change, directly removes the "cursor advanced
past an unactioned trigger" defect, and reuses the existing post-exit wake gate. Reviewer to confirm
A vs C (C is the more "correct" architecture if we're willing to touch the drain decision).

## Classifying "actionable" (shared with #71's spirit)
An answer event is **actionable for the recipient** when it answers a request where the recipient is
the **requester** and the answer unblocks their work — concretely: `request_answered` /
`request_closed` for a request whose `type=task` (or that has an `originating_task_id`). Pure-ack
notifications and info answers are housekeeping-drainable. Reviewer to confirm the exact predicate.

## Tests (teeth-verified — reproduce the bug, then prove the fix)
- **Repro test:** seed an agent with an OPEN task-type review request; mark a short-lived body alive
  (lease held); deliver the answer ("CLEAN") via the drain path; assert that after the drain exits
  and lease clears, `wake_scan`/`should_wake` still reports the event pending and a spawn occurs
  (NOT just that the request flipped closed). Must FAIL on current code, PASS after.
- Drain still drains pure notifications (no regression): a non-actionable inbox event is acked and
  the cursor advances as before.
- Idempotency: the re-armed event does not cause an infinite wake loop (spawned worker actions it
  and acks once).
- Existing `test_iss288_wake_suppression.py` still passes (Tier-1 pure-ack auto-close unaffected).

## Coordination note
This is the root-cause fix; #71 is hygiene. The two PRs are independent but #72 references #71.
Sits next to the #56 wake work.

## Acceptance criteria (mirror the issue)
- [ ] A request-answered event that unblocks work always results in a proper worker doing that work,
      regardless of whether a body was alive when the answer arrived.
- [ ] A drain turn never erases an unblocking trigger without either doing the work or guaranteeing
      a follow-on worker spawns.
- [ ] Reproduction test (answer while a short-lived body is alive → unblocked task subsequently runs).
- [ ] Full suite + smoke green; no regression in existing wake/drain tests.

## Open questions for the reviewer
1. **Option A vs C** — park-the-cursor (local) vs defer-don't-drain (cleaner, broader change)?
2. Exact "actionable event" predicate — is `type=task` ⨯ requester-is-recipient ⨯ answered/closed
   sufficient, or do we need `originating_task_id` too?
3. Interaction with the #288 triage-close auto-ack path — must we exempt task-type answered requests
   from Tier-1 auto-close, or only from the cursor-advance?
