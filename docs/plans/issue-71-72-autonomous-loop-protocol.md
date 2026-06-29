# Autonomous Plan→PR Loop Protocol — Issues #71 & #72

This protocol governs a **hands-off** loop: a plan is reviewed and approved before any code is
written, code is implemented, a PR is opened and reviewed, and the loop runs to completion with
**no human intervention** until the final verification gate. Kedar is the only one who merges.

It applies to two parallel tracks, each with its own plan and its own PR:
- **#71** — enforce `task` (not info) requests for sizable work. Plan: `docs/plans/issue-71-plan.md`.
- **#72** — drain turn closes a request-answered event without acting on it. Plan:
  `docs/plans/issue-72-plan.md`.

## Roles
- **CodeCleanupAgent (requester/implementer)** — writes plans, implements, opens PRs, drives the loop.
- **Code Reviewer (reviewer)** — reviews each PLAN and each PR; replies CLEAN or NEEDS CHANGES to the
  requester; **escalates the completed result of every PLAN review and every PR review to Kedar**.

## Hard rules (non-negotiable)
1. **Every** request from CodeCleanupAgent to Code Reviewer is a **`task` request** (`--task`), never
   info. (This is literally what #71 is about — we eat our own dog food.)
2. **Plan gate:** no implementation code is written for an issue until its PLAN review comes back
   **CLEAN**.
3. **DO NOT MERGE.** A CLEAN PR review means the PR is *approved and mergeable* — it is **not**
   merged. Kedar merges. Agents never merge.
4. **No self-certification.** The implementer's task ends at `needs_verification`; Kedar verifies.
5. The loop is **autonomous**: each verdict is acted on via `/orcha-listen` (long-poll) without
   waiting for a human. The only human touchpoints are (a) Code Reviewer's escalations to Kedar and
   (b) the final `needs_verification`.

## State machine (per track, #71 and #72 run independently)

```
DRAFT_PLAN
   │  (CodeCleanupAgent writes docs/plans/issue-NN-plan.md)
   ▼
PLAN_REVIEW_REQUESTED ──(task request to Code Reviewer)──┐
   │                                                     │
   │  Code Reviewer reviews plan, escalates result to Kedar,
   │  replies to CodeCleanupAgent: CLEAN | NEEDS CHANGES
   ▼
   ├─ NEEDS CHANGES → CodeCleanupAgent revises plan, re-sends task request → PLAN_REVIEW_REQUESTED
   └─ CLEAN ↓
IMPLEMENT
   │  (branch feat/issue-NN-...; code + teeth-verified tests; full suite + smoke green)
   ▼
PR_OPENED  (push branch, open PR to main; DO NOT MERGE)
   │
   ▼
PR_REVIEW_REQUESTED ──(task request to Code Reviewer)──┐
   │                                                   │
   │  Code Reviewer reviews PR, escalates result to Kedar,
   │  replies to CodeCleanupAgent: CLEAN | NEEDS CHANGES
   ▼
   ├─ NEEDS CHANGES → CodeCleanupAgent pushes fixes, re-sends task request → PR_REVIEW_REQUESTED
   └─ CLEAN ↓
PR_CLEAN_AND_MERGEABLE   (verify PR is mergeable; DO NOT MERGE)
   │
   ▼
ASK_VERIFICATION  (only once BOTH tracks reach PR_CLEAN_AND_MERGEABLE:
                   CodeCleanupAgent → orcha-done → task to needs_verification; ping Kedar)
```

## CodeCleanupAgent's per-wake decision logic (drives the loop hands-off)
On each `/orcha-listen` event (a request answered by Code Reviewer):
1. Identify which track (#71/#72) and which gate (PLAN vs PR) the answer is for.
2. **CLEAN on PLAN** → close the answered request; begin IMPLEMENT for that track.
3. **NEEDS CHANGES on PLAN** → revise the plan doc per feedback; re-send a **task** plan-review
   request; close the old one.
4. **CLEAN on PR** → confirm the PR is mergeable (`gh pr view --json mergeable`); mark that track
   PR_CLEAN. If the *other* track is also PR_CLEAN → `orcha-done` (needs_verification) + notify Kedar.
   **Never merge.**
5. **NEEDS CHANGES on PR** → push fixes to the PR branch; re-send a **task** PR-review request.
6. Always re-check source of truth (GH PR state, request status) before acting; never assume from
   memory. Record progress in the task thread (`/orcha-post`) every transition.

## Code Reviewer's responsibilities (requested of them, to be encoded in THEIR own task+protocol)
- Accept the plan-review / PR-review **task** requests.
- For each PLAN review: assess `docs/plans/issue-NN-plan.md` against the issue's acceptance criteria,
  call out gaps, and reply to CodeCleanupAgent with **CLEAN** (plan is sound, implement) or
  **NEEDS CHANGES** (+specifics). Then **escalate the completed plan-review result to Kedar**.
- For each PR review: review the diff against the protocol/state-machine/code conventions, reply
  **CLEAN** (approved + mergeable, DO NOT MERGE) or **NEEDS CHANGES** (+specifics). Then **escalate
  the completed PR-review result to Kedar**.
- Maintain their own task with a protocol mirroring these gates so the loop survives across their
  own wake/drain cycles.

## Why this protocol exists
This is the concrete fix for the failure that motivated #71/#72: a review went out as an *info*
request and a drain turn closed it without acting. Here, reviews are **task** requests with their own
task-bound lifecycle, the loop's next action is explicit and re-derivable from source-of-truth on
every wake, and the final human gate is preserved.
