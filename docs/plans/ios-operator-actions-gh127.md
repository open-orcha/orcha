# Plan — iOS operator actions: nudge or close ANY request (GH #127 / spec 07a)

**Owner:** Ethan (iOS) · **Issue:** open-orcha/orcha #127 · **Spec:**
`docs/design/mobile/flows/07a-nudge-close-any-request.md` (on `design/mobile-request-nudge-close`)
· **Branch:** `feat/ios-operator-actions-gh127` off `main`.

## Goal
Bring the iOS request detail to portal parity: a human can **Nudge** or **Close** *any* request they
can see — including agent↔agent traffic they are no party to — not just requests they sent. Retire
the mislabeled daemon-only **Triage-close** from the human UI. This is a **client-side gating +
layout change only** — every action is already served by `/openapi.json`; no backend work.

## Grounding against the live API (verified against the running server, not assumed)
- **Nudge** `POST /api/requests/{rid}/nudge {actor_agent_id, note?}` → 200
  `{nudged: bool, nudged_role, nudged_agent_id, reason?}`. SELECT-only, never changes state.
  `accepted` → 409 ("became a task"); `rejected/converted_to_task/closed` → 409. When the routed
  recipient is a human / the nudger → 200 `{nudged:false}` clean no-op (confirmed in
  `main.py:7702-7801`).
- **Close** `POST /api/requests/{rid}/close {requester_agent_id, reason?}` → 200. A human may close
  ANY non-closed request. Not-owner **without a reason** → **422 `reason_required`**. Re-closing a
  closed request → 200 `{already_closed:true}` (`main.py:7614-7660`).
- **Triage-close** `POST /api/requests/{rid}/triage-close` is `actor_type='system'`, daemon-only —
  **must not** be a human button (`main.py:7804+`). Removed from the UI.

## Visibility rules (spec 07a §4, computed from status + owner/target identity)
Let `you = paired human id`, `isRequester = requesterId == you`,
`targetIsYou = targetId == you` (literal — **not** null), `isTarget = targetId == you || targetId == nil`.
- `showClose  = status ∈ {open, answered, accepted}`
- `showNudge  = status ∈ {open, answered}` **minus** `(open && targetIsYou)` and `(answered && isRequester)`
  — i.e. hide the nudge that would only wake *yourself* (a guaranteed no-op).
- `closeNeedsReason = requesterId != you` → route through the Close-with-reason sheet; else the owner
  confirm dialog.
- **Operator note** banner shows only when `!isRequester && !isTarget` (neither role).

## Changes (all under `ios/Orcha/`)
1. **`Data/Dtos.swift`** — add `NudgeResult { nudged: Bool; nudgedRole: String?; nudgedAgentId: String? }`
   (snake_case keys) so the nudge outcome is typed.
2. **`Data/OrchaApiClient.swift`** — `nudgeRequest(...)` returns `NudgeResult` via `postDecoding`
   (was a fire-and-forget `post`). **Remove** `triageCloseRequest` (only served the retired button).
3. **`App/AppModel.swift`** — `nudgeRequest` decodes the result and sets a state-aware toast:
   `{nudged:true}` → "Nudged {alias}" (alias resolved from `nudged_agent_id`, else role); `{nudged:false}`
   → informational "No agent to wake — a human owns the next action." **Remove** `triageCloseRequest`.
   `closeRequest` unchanged (already handles owner + forced-with-reason; `already_closed` is a 200 so it
   already succeeds).
4. **`Screens/RequestDetailScreen.swift`** — the core UI:
   - **Tier 1 "Your move"** (role-specific, unchanged behaviour): Respond / Accept·Reject / Convert-to-task.
     Nudge & Close **move out** of this tier.
   - **Operator note** card (warn-bordered ⚑) when neither role.
   - **Tier 2 "Operator actions"**: `Nudge` (tonal) · `Close` (neutral when owner, `dangerTonal` when a
     reason is required), gated by the rules above.
   - **Close** tap → owner: `.confirmationDialog` (no text); not-owner: existing `closeWithReason` sheet
     (copy names the owner: "sent to {owner} so they know why").
   - **Nudge** sheet: state-routed sub-copy — open → "Wakes {target} — they still owe an answer.";
     answered → "Wakes {requester} — they must act on the answer or close it."
   - **Toolbar overflow**: keep **Escalate** (requester, open/answered). **Remove** "Close with reason…"
     (now the operator Close button) and **"Triage-close (stale)"** entirely.

## Non-goals (deferred, called out in the spec)
- List swipe quick-actions (frames N7/N8) — optional fast-triage enhancement; ship the detail tier first.
- Any backend / OpenAPI change — none required.

## Verification
- Build the app for the iOS Simulator (proven setup from prior GH #30 work).
- Drive the three role cases against the live localhost:8001 stack: (a) agent↔agent request (neither) →
  operator note + Nudge·Close, forced-close needs a reason; (b) inbound-to-me → Respond + Nudge·Close;
  (c) my own answered request → Convert + Close, Nudge hidden. Confirm the nudge no-op path shows the
  informational toast, not an error.

## Review / handoff (never self-certify)
Plan → **Code Reviewer** CLEAN → open PR → **Code Reviewer** CLEAN → escalate to **Kedar**. Kedar
merges. Work stops at `needs_verification`.
