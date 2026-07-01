# Flow 05 — Tasks (list · detail · thread)

Mockups: [`../mockups/05-tasks.html`](../mockups/05-tasks.html)

> **Status: ships entirely against the existing API.** Every endpoint below is in `/openapi.json`
> today — no new asks. Worker runs inside the task detail are specced separately in
> [flow 06](06-runs.md); the verify/plan-approval sheets in flow 08 (this flow only defines their
> entry points).

## 1. Story

Tasks are the second tab of the container workspace and the heart of the product: the human checks
what agents are doing, unblocks them, and talks to them on the task thread. The mobile Tasks world
is three screens deep: **list** (grouped by status) → **detail** (description, definition of done,
dependencies, actions) → **thread** (chat-style read + send). Content parity target is the portal's
`tasks.html`; the phone reshapes it, never re-invents it.

## 2. Tasks list (tab root)

### Grouping — kanban order, active work first

Sections in fixed order, each a `section-h` header with count. Empty groups are omitted:

| # | Group | Status | Pill |
|---|---|---|---|
| 1 | In progress | `in_progress` | `s-accent` (pulsing dot) |
| 2 | Blocked | `blocked` | `s-warn` |
| 3 | Needs verification | `needs_verification` | `s-violet` |
| 4 | Ready | `ready` | `s-info` |
| 5 | Pending (waiting on deps) | `pending` | `s-idle` |
| 6 | Done | `completed` | `s-ok` — **collapsed by default** |
| 7 | Cancelled | `cancelled` | `s-danger` — **collapsed by default** |

- Terminal groups (Done / Cancelled) render as collapsed headers with a count; tap expands.
  Collapse state persists per container.
- The portal lists `needs_verification` first; mobile deliberately leads with `in_progress` —
  on a phone the dominant job is *watching live work* — and gives verification its own louder
  surfaces instead: the **Needs me** filter chip and the Home-tab action queue (flow 04).
- Any unknown status falls into a trailing "Other" group (same never-drop rule as the portal).
- Within a group: priority ascending (lower number = higher priority), then updated-at descending.

### Task card anatomy (list row)

```
[status pill]  Title (2-line max)
               [avatar] assignee · P20 · 🔒 waits on 1 · updated 12m ago
```

- **Status pill** — word + dot, classes per the table above (color never alone).
- **Title** — `titleSm 15/650`, 2-line clamp. Root task gets a small `root` tag.
- **Assignee** — small avatar (squircle for AI, circle for human) + alias; "unassigned" muted.
- **Priority** — `P{n}` tag; P≤20 tinted danger, P≤40 warn (portal `p-hi`/`p-md` parity).
- **Dependency lock** — a small lock icon + "waits on N" when the task has unmet `depends_on`
  (always present on `pending`, and on `blocked` when the block is dependency-caused).
- **Updated-ago** — relative time of the last touch (created / started / last message).

### Filter chips + search

- Chip row under the app bar, horizontally scrollable: **All** · **Needs me** · one chip per AI
  agent (from the snapshot: Dana, Andrew, Ethan, Code Reviewer, …). Single-select.
- **Needs me** = tasks in `needs_verification` **plus** `in_progress` tasks with an undecided
  plan approval — everything waiting on the human. Chip shows a count badge.
- Agent chips filter by assignee.
- **Search** filters client-side over title + description. Android: collapsing M3 search bar in
  the top app bar. iOS: `.searchable` field in the navigation bar (pull down to reveal).
- Chips and search compose (search within the filtered set).

### Create

Android: FAB "+" (list root only). iOS: toolbar "+". Both open the Create-task flow (flow 11).
Disabled with an explanatory note while unreachable.

## 3. Task detail

Pushed from the list. One fetch powers the whole screen: `GET /api/tasks/{tid}/messages` returns
`{task, messages[]}` — header, sections, and the thread preview come from it.

Top-to-bottom anatomy:

1. **Header card** — title (`titleLg`), status pill (lg), priority tag, assignee row
   (avatar + alias). Root tag when applicable.
2. **Verify entry point** — only when `needs_verification`: a violet-tinted card
   ("Awaiting your verification" + claimed result preview) with a prominent **Review & verify**
   button and a chevron. Tapping opens the **verify sheet from flow 08** (`POST
   /api/tasks/{tid}/verify {approve, feedback?, actor_agent_id}`) — the sheet itself is specced
   there, not here. The same slot hosts the plan-approval entry when a plan is pending (flow 08).
3. **Description** — plain text section; links auto-linked.
4. **Definition of done** — a highlighted, checklist-styled card (accent-soft fill, accent border,
   one check-bulleted line per DoD clause; a single-paragraph DoD renders as one bullet). Purely
   presentational in v1 — no per-item state exists in the API.
5. **Dependencies** — one row per `depends_on` task: lock (unmet) or check (completed) icon,
   title, status pill; tap navigates to that task. Section hidden when there are none.
6. **Attachments row** — horizontally scrollable chips of everything attached on this task's
   thread (image chips show a thumbnail). Tap = viewer / share sheet via
   `GET /api/tasks/{tid}/attachments/{stored_name}`.
7. **Thread row** — "Thread · N messages", last-message preview, chevron → thread screen (§4).
8. **Worker runs** — section per [flow 06](06-runs.md).
9. **Close task** — **in the overflow menu** (ellipsis, top-right), never a bare button on the
   page: "Close task…" styled destructive.

### Close / cancel behavior (destructive)

1. User taps overflow → "Close task…".
2. App fetches `GET /api/tasks/{tid}/close-implications` **before** showing any confirm, and
   bakes the downstream effects into the dialog copy (e.g. *"1 waiting task will unblock:
   Run-log retention sweep"*). If the fetch fails, the confirm still shows with generic copy —
   never block the action on the preview.
3. Confirm surface: **Android = M3 AlertDialog** with the implications as body + an optional
   reason textarea inline. **iOS = `confirmationDialog`** (action sheet) with the implications
   as the note; "Close task" (destructive) confirms immediately, "Add reason & close…" opens a
   one-field alert first (confirmationDialogs can't host text fields).
4. Confirm → `POST /api/tasks/{tid}/cancel {actor_agent_id, reason?}` (actor = the paired
   human's agent id). Success: snackbar/toast "Task closed", status flips to `cancelled`
   locally, list invalidated. The reason is recorded and routed to the assignee (portal parity).
5. Hidden for root tasks and for `completed`/`cancelled` (server would 409 anyway).

## 4. Task thread screen

Chat-style, full screen, newest at the bottom.

- **Bubbles:**
  - Agent messages → `.bubble.theirs` (left), author alias in accent above the body, small
    avatar, mono timestamp below.
  - The paired human's own messages (author id == pairing `humanAgentId`) → `.bubble.mine`
    (right, accent fill). Another human's messages render left like agents (circle avatar).
  - System/decision entries (plan approved, verified, task closed, unattributed posts) →
    `.bubble.system` — centered, dashed, muted.
- Message text is the `body` field; attachments render inside the bubble (image thumbnail /
  file chip).
- **Composer:** paperclip (attach → `POST /api/tasks/{tid}/attachments`, staged as chips above
  the field), rounded input ("Message {assignee}…"), send button (disabled while empty and while
  attachments are uploading).
- **Send:** optimistic — the bubble appends immediately in a "sending" state, then
  `POST /api/tasks/{tid}/messages {author_agent_id, body, attachments?}` with the paired human's
  agent id as author. Confirmed on 2xx.
- **Send failure:** the bubble stays, marked unsent (danger outline) with a **retry chip**
  directly under it — "Not sent · Tap to retry". Retry re-POSTs the same payload; long-press
  offers Delete draft. No offline queue in v1: while unreachable the composer disables with a
  note.
- Thread is append-only (no edit/delete of sent messages) — parity with the portal.

## 5. Screens & states (mockup frames)

| Frame | Screen | Notes |
|---|---|---|
| T1 | Tasks list (Android, dark) | FAB, bottom nav Tasks active, status groups, chips, collapsed terminal groups |
| T2 | Tasks list (iOS, light) | large title, toolbar "+", `.searchable` hint, pending group with dep lock |
| T3 | List empty (Android, light) | "No tasks yet" + Create CTA; FAB stays |
| T4 | Task detail (iOS, dark) | in_progress; DoD checklist card, deps, attachments, thread + runs rows |
| T5 | Cancel confirm (iOS) | `confirmationDialog` action sheet; close-implications as the note |
| T6 | Cancel confirm (Android, light) | AlertDialog with implications + optional reason textarea |
| T7 | Detail, needs_verification (Android, dark) | violet pill + "Review & verify" entry card → flow 08 |
| T8 | Thread (iOS, dark) | mixed bubbles incl. system decision; composer |
| T9 | Thread send failure (Android, dark) | unsent bubble + retry chip |
| T10 | List loading skeleton (iOS, light) | shimmer cards under chip row |
| T11 | Detail load error + unreachable (Android, light) | danger banner + state layout with retry |

States without dedicated frames reuse the shared patterns: thread-empty uses the standard state
layout ("No messages yet — say hi to {assignee}") above the composer; full-screen unreachable is
flow 04's.

## 6. Behavior (data & realtime)

- **List fetch:** `GET /api/containers/{cid}/tasks` on tab enter; cached per container.
- **Pull-to-refresh** on list, detail, and thread (M3 `PullToRefreshBox` / `.refreshable`) —
  full refetch of that screen's query.
- **SSE invalidation:** the workspace's `GET /api/containers/{cid}/events` stream invalidates the
  tasks-list query on any task event, and the open detail/thread query when the event's task id
  matches. Falls back to 30s polling per the shared connectivity model (doc 02 §4).
- **Thread live-append:** while the thread screen is open, a matching SSE event refetches
  `GET /api/tasks/{tid}/messages` and appends new messages; auto-scrolls only when already
  pinned to the bottom.
- **Detail load error:** state layout ("Couldn't load this task") + Try again. A cached copy, if
  present, renders with a "Couldn't refresh — showing cached" banner + retry (portal #74 parity).
- **Unreachable:** non-blocking danger banner pinned under the app bar; all mutating controls
  (composer, close, verify) disable with the banner as the explanation.

## 7. Platform notes

- **Android:** list is the Tasks destination of the bottom Navigation bar; FAB create; collapsing
  M3 search bar; AlertDialog for close-confirm (reason field inline); snackbar feedback ("Task
  closed", "Message sent" only on retry-success). Predictive back from detail/thread.
- **iOS:** `NavigationStack` per tab, large title collapses on scroll; toolbar "+"; `.searchable`;
  `confirmationDialog` for close-confirm (+ alert for reason); inline toast banner for feedback;
  swipe-back everywhere. Tab re-tap pops thread → detail → list.
- Everything else — grouping, card anatomy, DoD card, bubbles, states — pixel-equivalent.

## 8. Endpoints used

| Action | Endpoint | Status |
|---|---|---|
| Tasks list | `GET /api/containers/{cid}/tasks` | exists |
| Task detail + thread | `GET /api/tasks/{tid}/messages` → `{task, messages[]}` (text in `body`) | exists |
| Send message | `POST /api/tasks/{tid}/messages {author_agent_id, body, attachments?}` | exists |
| Upload attachment | `POST /api/tasks/{tid}/attachments` (multipart) | exists |
| Fetch attachment | `GET /api/tasks/{tid}/attachments/{stored_name}` | exists |
| Close-implications preview | `GET /api/tasks/{tid}/close-implications` (fetched before the confirm) | exists |
| Close / cancel task | `POST /api/tasks/{tid}/cancel {actor_agent_id, reason?}` | exists |
| Verify (entry point only — sheet in flow 08) | `POST /api/tasks/{tid}/verify {approve, feedback?, actor_agent_id}` | exists |
| Runs section | see [flow 06](06-runs.md) | exists |
| Realtime invalidation | SSE `GET /api/containers/{cid}/events` | exists |
