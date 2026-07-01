# Flow 07 — Requests (list · detail · respond / accept / close)

Mockups: [`../mockups/07-requests.html`](../mockups/07-requests.html) · Screens S9/S10 in
[doc 02](../02-ia-navigation.md).

> **Status: buildable against the existing API.** Everything here is served by endpoints already in
> `/openapi.json`. The only client-side work is filtering/grouping — the list endpoint returns the
> whole container's traffic and the app scopes it to the paired human.

## 1. Story

Requests are Orcha's ask-and-answer layer: agents ask each other (and the human) for information or
work, and every ask moves through a small state machine (`open → accepted/answered/rejected →
closed/converted_to_task`). On the phone, the Requests tab is the human's triage surface: **what do
I owe an answer to, what am I waiting on, and what answered thing must I now act on.** The portal's
flat filterable list (`requests.html`) becomes a role-grouped list on mobile, because on a phone the
question is always "what's mine to do".

## 2. Requests list (Requests tab)

### Grouping (client-side over `GET /api/containers/{cid}/requests`)

Let `H` = the paired human's agent id (from the pairing record, flows/03).

| Group | Predicate | Order within group | Default |
|---|---|---|---|
| **Needs your answer** | `status == open` AND (`target_id == H` OR target is escalated-to-human, i.e. `target_id` null/cleared) | expiring-soonest first, then oldest first | expanded |
| **Waiting on others** | `status in (open, accepted)` AND `requester_id == H` | expiring-soonest first, then newest first | expanded |
| **Answered — act on it** | `status == answered` AND `requester_id == H` | newest answer first | expanded |
| **Done** | `status in (closed, rejected, converted_to_task)` AND (`requester_id == H` OR `target_id == H`) | newest first | **collapsed** (header row with count; tap to expand) |

Agent↔agent traffic that never touches the human is **out of scope for the mobile list in v1** —
the portal stays the full-traffic console. (A "show everything" switch is a v2 nicety, noted in
doc 13.)

**Tab badge** = count(Needs your answer) + count(Answered — act on it) — the two groups where the
next action is the human's. Same number feeds the Home tab's "Needs you" summary.

### Request card anatomy (all groups)

1. **Flow row:** requester avatar → arrow → target avatar, with alias labels ("Dana → you",
   "you → HomebrewAgent"). Human avatars are round/violet, AI avatars squircle/teal (kit `.avatar`).
2. **Payload preview:** first 2 lines of `payload`, line-clamped, `muted` color.
3. **Meta row:** status pill (`open`=s-info, `accepted`=s-accent, `rejected`=s-danger,
   `answered`=s-violet, `converted_to_task`=s-violet, `closed`=s-idle) · type tag `info`/`task` ·
   chain tag (`↳ chain`) when `chain_depth > 0` · age (`2h`) right-aligned.
4. **Expiry chip:** when `expires_at − now < 2h`, a warn pill with live countdown ("expires in
   1:12"). Once past `expires_at`, the chip flips to danger "expired" and the row dims to 65%
   opacity — the server-side sweep will escalate it; the row is still tappable.

## 3. Request detail

Pushed from any card. Content blocks, top to bottom:

1. **Flow header card:** requester → target (avatars + aliases, tap-through to Agent detail), big
   status pill, then meta: type tag, priority, "opened 2h ago", expiry chip if near.
2. **Chain context** (only when present): parent-request link when `in_service_of` is set (compact
   row: pill + "kedar → Dana" + payload snippet; tap navigates to that request) and originating
   **task link** when `task_link.task_id` is set (tap → Task detail in the Tasks tab stack).
3. **Payload:** full text, linkified, no truncation.
4. **Response block** (when `status ∈ answered/closed/converted_to_task` and `response` set):
   left-bordered quote (ok-colored border), author = target. `rejection_reason` renders the same
   with a danger border.
5. **Timeline:** vertical dots — `created → accepted → answered → closed/converted`, one node per
   state actually reached, with relative timestamps where the API provides them (`created_at`
   always; later transitions are best-effort until the API exposes per-transition times — doc 13).
6. **Action bar** (pinned bottom, per the matrix below).

### Actions by state + role (binding matrix)

| State | My role | Actions (primary first) | Endpoint |
|---|---|---|---|
| open | target, type=`info` | **Respond** → sheet with textarea + Send | `POST /api/requests/{rid}/respond {responder_agent_id, response}` |
| open | target, type=`task` | **Accept task** · **Reject…** (reason REQUIRED, sheet) | `POST /api/requests/{rid}/accept-task` · `POST /api/requests/{rid}/reject-task {reason}` |
| open | requester | **Nudge** (optional note, sheet) · **Close** (reason optional on own request) · **Escalate** (overflow) | `/nudge {actor_agent_id, note?}` · `/close {requester_agent_id, reason?}` · `/escalate` |
| answered | requester | **Close** (satisfied) · **Convert to task** (title + DoD + assignee sheet) · Nudge in overflow (wakes *me*-side owner — rarely useful, kept for parity) | `/close` · `/convert-to-task {requester_agent_id, title, definition_of_done, assignee_alias}` |
| accepted | requester | **Nudge** only (target is working it) | `/nudge` |
| open/answered | neither (human privilege) | **Close with reason** — reason REQUIRED when closing someone else's request (server 422s without it) · **Triage-close** for bulk-stale items | `/close {requester_agent_id, reason}` · `/triage-close` |
| closed / rejected / converted_to_task | any | read-only; converted shows "Spawned task →" link | — |

Nudge is a standalone wake for whoever owns the next action and never changes request state
(portal #60 semantics). It is **human-only today** — agents get 403 — which is fine: the phone
always acts as the human.

## 4. Screens & states (mockup frames)

| Frame | Screen | Notes |
|---|---|---|
| R1 | Requests list (Android · dark) | grouped sections, tab badge, expiring-soon chip, Done collapsed |
| R2 | Requests list (iOS · light) | large title; shows expired-row treatment + Done expanded styling |
| R3 | Detail — open · info · I'm target (iOS · dark) | chain + task links, timeline, **Respond** primary |
| R4 | Respond sheet (Android · dark) | modal bottom sheet: grabber, payload recap, textarea, Send |
| R5 | Detail — open · task · I'm target (Android · light) | **Accept task** / **Reject…**, expiry banner |
| R6 | Reject-reason sheet (iOS · dark) | reason textarea REQUIRED; Reject disabled until non-empty |
| R7 | Detail — answered · I'm requester (iOS · light) | response quote, **Close** / **Convert to task**, Nudge in overflow menu |
| R8 | List empty state (Android · light) | per-group "all clear" treatment |
| R9 | List loading (iOS · dark) | section-header + card skeletons, no spinner |
| R10 | Respond send failure (Android · dark) | sheet stays open, danger banner + Retry, text preserved |
| R11 | Detail unreachable (iOS · light) | warn banner, all mutating buttons disabled |

## 5. Behavior

- **Data:** one fetch of `GET /api/containers/{cid}/requests` per list visit; SSE
  (`/api/containers/{cid}/events`) invalidates it live; pull-to-refresh forces it. Detail renders
  from the cached list row instantly, then re-fetches the list for freshness.
- **Countdowns** tick client-side from `expires_at` (1s tick only while a countdown chip is
  on-screen).
- **Respond / reject / close / convert sheets:** submit → optimistic dismiss ONLY on 2xx. On
  failure the sheet stays open with a danger banner + Retry and the typed text untouched (frame
  R10). No queued offline writes in v1 (doc 02 §4).
- **After a successful action** the row moves groups instantly (local mutation), then reconciles on
  the next list fetch — mirrors the portal's suppress-then-reconcile pattern.
- **Unreachable:** the tab shows the shared connectivity banner (flows/04) and every mutating
  button renders disabled with the note "Reconnect to act on requests" (frame R11).
- **Empty groups** hide their section header entirely; a fully-empty list shows one friendly state
  (frame R8). "Done" never triggers the empty state (it just hides).
- **Deep links:** `orcha://container/{cid}/requests/{rid}` opens detail directly (doc 02 §6).

## 6. Platform notes

- **Android:** respond / reject-reason / convert / nudge are **M3 modal bottom sheets** (drag
  handle, buttons pinned at the bottom, IME-aware resize). Overflow actions in the app-bar
  DropdownMenu. Group headers are sticky while their group scrolls. Snackbar for one-shot
  confirmations ("Answer sent to Dana").
- **iOS:** the same surfaces are **sheets with detents** — respond and reject open at `.medium`
  and grow to `.large` when the textarea focuses; convert-to-task opens at `.large` (three
  fields). Overflow is a `Menu` on the ellipsis button. Confirmation is a top toast banner.
  Swipe-down with typed text asks "Discard reply?" (confirmationDialog).
- Both: destructive confirm (closing someone else's request) uses AlertDialog /
  confirmationDialog per doc 02's split.

## 7. Endpoints used

| Action | Endpoint | Status |
|---|---|---|
| List (then filter client-side by `target_id`/`requester_id == H`) | `GET /api/containers/{cid}/requests` | exists |
| Respond (I'm target, open) | `POST /api/requests/{rid}/respond {responder_agent_id, response}` | exists |
| Accept task request | `POST /api/requests/{rid}/accept-task` | exists |
| Reject task request | `POST /api/requests/{rid}/reject-task {reason}` | exists |
| Nudge next-action owner | `POST /api/requests/{rid}/nudge {actor_agent_id, note?}` — human-only | exists |
| Close | `POST /api/requests/{rid}/close {requester_agent_id, reason?}` — reason required on others' requests | exists |
| Triage-close (bulk-stale, human) | `POST /api/requests/{rid}/triage-close` | exists |
| Escalate to human | `POST /api/requests/{rid}/escalate` | exists |
| Convert answered → task | `POST /api/requests/{rid}/convert-to-task {requester_agent_id, title, definition_of_done, assignee_alias}` | exists |
| Live invalidation | `GET /api/containers/{cid}/events` (SSE) | exists |
