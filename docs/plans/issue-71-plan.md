# Plan — Issue #71: Enforce **task** (not info) requests for all sizable work

**Status:** DRAFT — awaiting Code Reviewer plan-review (CLEAN) before any code is written.
**Owner:** CodeCleanupAgent. **Reviewer:** Code Reviewer. **DO NOT MERGE the eventual PR** — Kedar merges.

## Problem (from the issue)
Requests default to `type=info`. Reviews / docs / coding are real *work* and should be `task`, but
today the type is effectively a coin-flip: `/orcha-ask` defaults to `info` and only becomes `task`
if the sender remembers `--task`. That arbitrariness caused a real missed-wake incident.

## Canonical source files
- Skill: `orcha-cli/orcha_cli/templates/skills/orcha-ask.md` (default `type: "info"`).
- API: `orcha-cli/orcha_cli/templates/portal/main.py` — `RequestCreate` model (`type` default `"info"`)
  and `POST /api/containers/{cid}/requests`.
- Outbox: same file, `GET /api/agents/{aid}/outbox` (filters `status <> 'closed'`).
- Docs: `docs/orcha-review-protocol.md` (silent on request type today).
- NOTE: `desktop/resources/orcha-templates/portal/main.py` is a **gitignored generated copy** —
  do not edit; it is rebuilt by `desktop/scripts/copy-orcha-templates.mjs`.

## Design (server-side enforcement is the source of truth; skill text is secondary)

### 1. Server-side classifier + guardrail (the real enforcement)
In `create_request` (POST `/requests`), before INSERT, run a small heuristic on the request
`payload` (and any `task` object presence):

- Maintain a `WORK_VERBS` set: `review, sign off / sign-off, approve, implement, write, code,
  build, fix, document, draft, create (a doc/PR), refactor, test, add` (curated, lowercased,
  word-boundary matched).
- If `body.type == "info"` AND the payload clearly describes work (matches a work verb in an
  imperative position) → **auto-promote to `task`**, *but* a task request requires a `task`
  object (current code raises 400 if `type=task` and `task is None`). Two sub-options — pick in
  review:
  - **(1a) Auto-promote + synthesize a minimal `task` object** from the payload (title = first
    line / truncated payload; protocol default). Lowest friction, fully hands-off.
  - **(1b) Reject info-with-work** → HTTP 422 with a clear message: "This looks like work
    (matched: 'review'). Re-send as a task request (`--task`) with a task spec." Safer, but
    requires the sender to retry.
  - **Recommendation:** 1a (auto-promote with synthesized task) so autonomous loops never stall
    on a rejected request; include a `promoted_from_info: true` + `matched_verb` stamp in
    `detail` for auditability. Reviewer to confirm.
- An explicit `type=task` is always honored. An `info` request that is genuinely a quick question
  (no work verb match) stays `info`.

### 2. Skill default flip (`orcha-ask.md`)
- Change guidance so review/docs/coding examples use `--task`.
- Document the new server behavior (info-with-work is auto-promoted/!rejected) so senders aren't
  surprised. Keep `info` documented for genuine quick questions.
- Do **not** change the CLI default flag silently in a way that breaks genuine info asks — the
  server classifier is the guard; the skill just stops *encouraging* info for work.

### 3. Outbox audit-trail nicety (issue item 3)
- Add an opt-in `?include_closed=true` (or `?window=<n>`) to `GET /outbox` returning recently
  closed requests too, so a sender can check their own outbox before re-asking. Default behavior
  unchanged (back-compat). Small, additive.

### 4. Docs
- `docs/orcha-review-protocol.md`: add a short subsection — "Reviews, sign-off, documentation, and
  coding hand-offs go out as **task** requests; `info` is reserved for quick knowledge questions
  the requester cannot answer themselves."

## Tests (teeth-verified — each must fail before the change, pass after)
- POST `/requests` with `type=info` + payload "please review my PR plan" → result row has
  `type=task` (1a) **or** 422 (1b). (Asserts the classifier fires.)
- POST `/requests` with `type=info` + payload "what port does the DB use?" → stays `type=info`.
  (Asserts no false-positive promotion.)
- Explicit `type=task` with a `task` object → unchanged, still `task`.
- `GET /outbox?include_closed=true` returns a closed request that the default view omits.
- Promotion path stamps `detail.promoted_from_info` (audit).

## Out of scope
- The wake/drain root-cause bug → **Issue #72** (separate plan, separate PR).

## Acceptance criteria (mirror the issue)
- [ ] Review/sign-off/docs/coding requests are created as `task` by default (server-enforced).
- [ ] Info-with-work is auto-promoted (or rejected) with a clear, auditable stamp.
- [ ] Genuine quick-question info requests still work.
- [ ] `docs/orcha-review-protocol.md` updated.
- [ ] Teeth-verified tests added; full suite + smoke green.

## Open questions for the reviewer
1. **1a (auto-promote + synthesize task) vs 1b (reject with nudge)** — which is the house policy?
   (Recommend 1a for hands-off loops.)
2. Is a payload-keyword heuristic acceptable, or should promotion key off a structured signal
   (e.g. an explicit `intent` field) to avoid brittle verb-matching?
3. Should the classifier live in `create_request` or a shared helper reused by the skill/CLI?
