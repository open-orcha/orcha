# Flow 07a — Nudge or close ANY request (operator actions)

Addendum to [`07-requests.md`](07-requests.md). Mockups: [`../mockups/07a-nudge-close-any-request.html`](../mockups/07a-nudge-close-any-request.html).
Owns GitHub issue #30 sub-scope: *"human can only answer requests directed at them; let the human
close or nudge ANY request, as on the web portal."*

> **Status: buildable against the existing API.** Every action here is served by endpoints already in
> `/openapi.json`. This is a client-side gating + layout change — no new backend is required. One
> cleanup ask (retire the daemon-only `triage-close` from the human UI) is flagged in
> [doc 13](../13-api-asks.md).

---

## 1. Why this exists (the gap)

On the **web portal** the human is an **operator/arbiter**: the requests console lists *all*
container traffic — including agent↔agent asks the human is no party to — and every actionable
request offers **Nudge** and **Close** (`requests.html` `actionsFor()`):

```
if (r.status === "open" || r.status === "answered")  → Nudge      // NO role gate
Close                                                 → always     // reason required if not yours
```

On **mobile today**, two of the three pieces are already in place — and one is missing:

| Piece | Mobile status today |
|---|---|
| **See** all requests (incl. agent↔agent) | ✅ done — the Requests tab lists the whole container with the web's `All / Open / Answered / Escalations / Task reqs` chips (`WorkspaceScreen.kt` "ALL container requests"; iOS `RequestsTabView` web-parity lenses). |
| **Close** any request | ⚠️ partial — only reachable for third-party requests, buried in the detail **overflow menu** as *"Close with reason…"* + *"Triage-close (stale)"*. Inbound-to-you requests offer **no** Close at all. |
| **Nudge** any request | ❌ missing — Nudge is gated behind `isRequester`. A human **cannot** nudge an agent↔agent request that is stuck, nor an inbound request. |

So the human can now *see* every request on the phone but can't *act* on most of them the way the
portal allows. This flow closes that gap by promoting **Nudge + Close** to a universal **operator
action tier** on the request detail, and retiring the mislabeled `triage-close`.

---

## 2. The model — "acting as operator"

The request-detail action zone splits into two tiers (top to bottom):

1. **Your move** (role-specific — unchanged). Shown only when applicable:
   Respond · Accept task / Reject… · Convert to task · Escalate.
2. **Operator actions** (NEW — universal). Shown for **any request in an actionable state**,
   regardless of whether the human is requester, target, or neither:
   **Nudge** · **Close**.

When the human is **neither** requester nor target, a subtle operator note sits above the tier —
mirroring the portal's *"Arbitrating as {alias} — … Every action is logged."*:

> ⚑ Acting as operator (**{you}**). Closing another agent's request needs a reason — it's sent to
> the owner so they know why.

This keeps the mental model honest: an operator action on someone else's request is authoritative
and logged, and a forced close is explained to the owner.

---

## 3. Actions — grounded in the real endpoints

### Nudge — `POST /api/requests/{rid}/nudge {actor_agent_id, note?}`
- **Human-only** (agents get 403 — fine, the phone is always the human).
- **Never changes state** (SELECT-only handler). State-routed recipient:
  - `open` → wakes the **target** (still owes the answer).
  - `answered` → wakes the **requester** (must act on the answer or close it).
- `accepted` → **409** "became a task — nudge the task, not the request" → so **hide Nudge** on
  `accepted` requests and point the user at the spawned task (the detail already links it).
- `rejected / converted_to_task / closed` → terminal → **hide Nudge**.
- If the next-action owner is a human (escalated-to-human, human target/requester, null target) or
  the nudger themselves → **200 `{nudged:false}`** clean no-op. The UI treats this as an
  informational (not error) outcome — see §5.

**Show Nudge when:** `status ∈ {open, answered}` **and** the nudge would wake *someone other than
you* — i.e. **hide** it when `open && you are the target` or `answered && you are the requester`
(nudging then just wakes yourself → a guaranteed `{nudged:false}` no-op). In every other case the
routed recipient is another agent (useful) or a genuine "waiting on a human" case (the informative
no-op in §5). Availability otherwise does **not** depend on role.

### Close — `POST /api/requests/{rid}/close {requester_agent_id, reason?}`
- A **human may close ANY request in any non-closed status** (authoritative abandon).
- **Owner** (you sent it): reason optional → confirm dialog, no text needed.
- **Not owner** (someone else's request): **reason REQUIRED** — server returns **422
  `reason_required`** without it. The reason is **routed to the owner** so they learn why.
- Idempotent: re-closing a closed request → 200 `{already_closed:true}` (treat as success).

**Show Close when:** `status ∉ {closed, rejected, converted_to_task}` (i.e. `open`, `answered`, or
`accepted`). Reason field is required whenever `requester_id != you`.

### Triage-close — DO NOT expose to the human
`POST /api/requests/{rid}/triage-close` is an **internal daemon/system endpoint** (#288):
`actor_type='system'`, `actor_id=NULL`, answered-only, no reason, stamps `{auto:true,
reason:'triage_skip'}`. It exists so the notifier can auto-close a pure-ack answered request without
spawning the requester. It is **not** a human operator action and must **not** masquerade as one.
→ **Remove "Triage-close (stale)" from the mobile overflow menu.** A human abandoning a stale
request uses **Close** with a reason. (Flagged in doc 13.)

---

## 4. Revised action matrix (supersedes the matrix in 07 §3)

`R` = requester, `T` = target, `—` = neither. "you" = the paired human.

| status | Your move (role-specific) | Operator actions | Operator note? |
|---|---|---|---|
| `open`, type=info, T=you | **Respond** | **Close** *(Nudge hidden — you owe the answer)* | no |
| `open`, type=task, T=you | **Accept task** · **Reject…** | **Close** *(Nudge hidden)* | no |
| `open`, R=you | **Escalate** (overflow) | **Nudge** *(wakes the target)* · **Close** | no |
| `open`, — (neither) | — | **Nudge** · **Close (reason)** | **yes** |
| `answered`, R=you | **Convert to task** · **Escalate** (overflow) | **Close** *(Nudge hidden — wakes you)* | no |
| `answered`, T=you | — | **Nudge** *(wakes the requester)* · **Close (reason)** | no |
| `answered`, — (neither) | — | **Nudge** · **Close (reason)** | **yes** |
| `accepted` (any role) | — (work moved to the spawned task) | **Close** only — *Nudge hidden* (nudge the task) | if neither |
| `closed / rejected / converted_to_task` | read-only | — | no |

**Rule of thumb for engineers:**
- `showClose = status ∈ {open, answered, accepted}` (any non-terminal).
- `showNudge = status ∈ {open, answered}` **minus** `(open && target == you)` and `(answered &&
  requester == you)`.
- `closeNeedsReason = requesterId != you` → route through the Close-with-reason sheet; otherwise the
  owner confirm dialog.
- **Operator note** (§2 banner) shows only when `you are neither requester nor target`.

Role only decides which *extra* buttons appear in "Your move" — the operator tier is computed purely
from `status` + owner/target identity, so it lights up uniformly across every request the human can
see, including agent↔agent ones.

---

## 5. Sheets, dialogs & result feedback

- **Nudge sheet** — one optional note field. Sub-copy is state-routed so the human knows who wakes:
  - open → *"Wakes {targetAlias} — they still owe an answer."*
  - answered → *"Wakes {requesterAlias} — they must act on the answer or close it."*
  - Confirm label **Nudge**. On **200 `{nudged:true}`** → confirmation "Nudged {role/alias}".
    On **200 `{nudged:false}`** → **informational** toast/snackbar, *not* an error:
    "No agent to wake — a human owns the next action." Sheet dismisses either way (the call
    succeeded). On network failure → sheet stays open, danger banner + Retry, text preserved.
- **Close — owner** → confirm dialog (AlertDialog / confirmationDialog), no text. "Close this
  request? {ownerHint} sees it closed on the next sync."
- **Close — not owner** → **Close-with-reason sheet**. Reason field **required**; Close disabled
  until non-empty. Helper: *"Required — sent to {ownerAlias} so they know why you closed it."*
  A 422 from the server maps to inline "A reason is required to close another agent's request"
  (defensive; the disabled-button guard should prevent it).
- After any successful close the detail **pops back** to the list and the row moves to Done
  (optimistic, then reconciles on next fetch — the existing suppress-then-reconcile pattern).

---

## 6. Frames (see mockup)

| Frame | Screen | Notes |
|---|---|---|
| N1 | Detail — agent↔agent, neither role (Android · dark) | operator note + **Nudge · Close** tier; NO respond/accept |
| N2 | Detail — agent↔agent, neither role (iOS · light) | same, HIG layout; overflow no longer needed |
| N3 | Nudge sheet (Android modal bottom sheet · dark) | optional note, state-routed sub-copy ("wakes Ethan") |
| N4 | Close-with-reason sheet (iOS · dark) | reason REQUIRED, "sent to Mahima", Close disabled until typed |
| N5 | Detail — inbound, I'm target (iOS · light) | **Respond** primary + operator **Nudge · Close** now present |
| N6 | Result feedback (Android snackbar + iOS toast) | success "Nudged Ethan" vs no-op "No agent to wake" |
| N7 | List swipe actions (iOS · light) | *enhancement* — leading Nudge (blue) / trailing Close (red) |
| N8 | List quick actions (Android · dark) | *enhancement* — trailing overflow → Nudge / Close per row |

Frames N7/N8 are an **optional fast-triage enhancement** beyond portal parity (the portal only acts
from detail). They make "nudge/close ANY request" efficient when triaging many at once. Ship the
detail tier (N1–N6) first; list quick-actions can follow.

---

## 7. Platform notes

- **Android (Material 3):** operator tier is a button row under "Your move" — **Nudge** = tonal,
  **Close** = neutral (or `danger-tonal` when a reason is required). Nudge / close-with-reason are
  **M3 modal bottom sheets** (drag handle, IME-aware). Owner-close is an **AlertDialog**.
  One-shot result = **Snackbar**. List quick-actions (N8): `SwipeToDismissBox` background actions or
  a trailing overflow per row.
- **iOS (HIG / SwiftUI):** operator tier as buttons below "Your move"; **Close** uses `.dangerTonal`
  when a reason is required, otherwise `.neutral`. Nudge / close-with-reason are **`.sheet` with
  `.medium`/`.large` detents**. Owner-close is a **`confirmationDialog`**. Result = **top toast
  banner**. List quick-actions (N7): `.swipeActions` — leading `Nudge` (`.tint(.blue)`), trailing
  `Close` (`role: .destructive`).
- **Both:** the operator note renders only when `role == neither`. Destructive/forced close always
  confirms first (doc 02's dialog-vs-sheet split).

---

## 8. Endpoints used

| Action | Endpoint | Gating |
|---|---|---|
| Nudge next-action owner | `POST /api/requests/{rid}/nudge {actor_agent_id, note?}` | human-only; `open`/`answered` only |
| Close (own) | `POST /api/requests/{rid}/close {requester_agent_id}` | owner, any non-closed status |
| Close (other's — forced) | `POST /api/requests/{rid}/close {requester_agent_id, reason}` | human; **reason required** (422 without) |
| ~~Triage-close~~ | ~~`POST /api/requests/{rid}/triage-close`~~ | **daemon/system only — remove from human UI** |
| List (all traffic) | `GET /api/containers/{cid}/requests` | exists; already shown on mobile |
| Live invalidation | `GET /api/containers/{cid}/events` (SSE) | exists |

Everything is already in `/openapi.json`. No new API is required for this feature.
