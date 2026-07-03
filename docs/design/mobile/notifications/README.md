# Flow 15 — Notification acknowledge + clock-wake snooze

Mockups: [`notify-ack-snooze.html`](notify-ack-snooze.html) · Gallery: [`renders/gallery-full.png`](renders/gallery-full.png)
Design system: [`../01-foundations.md`](../01-foundations.md) · [`../12-component-inventory.md`](../12-component-inventory.md) · [`../02-ia-navigation.md`](../02-ia-navigation.md)

Mobile (iOS + Android) design for **per-notification human acknowledge + clock-wake snooze** — the
mobile equivalent of [PR #106](https://github.com/open-orcha/orcha/pull/106) (closes
[#89](https://github.com/open-orcha/orcha/issues/89)). This is a delta on the delivered GH #30
package: same tokens, same components, same iOS-HIG / Android-Material-3 skeletons. Nothing here
re-invents a component — it reuses the agent roster + detail (flow 09), the sheet/dialog patterns
(flows 08/11), status pills, the shared state + laptop-unreachable model (flow 04), and the deep-link
navigation already used across tasks/requests.

> **Status: every surface ships against PR #106's real API — there is NO new API ask.** All four
> endpoints and both read fields (`total_pending`, `snooze_until`) are in the PR and verified below
> against its diff (they are not in live `/openapi.json` until #106 merges). The one thing to flag is
> not a gap but a **coordination note**: the badge count and active-snooze state both ride the
> container snapshot the roster already polls, so the apps add **zero new realtime surface** — they
> reuse GH #30's SSE + laptop-unreachable model wholesale.

---

## 1. What PR #106 actually gives us (ground truth)

Verified against the PR #106 diff (`feat/gh89-notification-ack`). None of these are in live
`/openapi.json` until #106 merges.

| Fact | Detail | Design consequence |
|---|---|---|
| Bell-badge count | `total_pending` rides the **container snapshot** (`get_container`) per agent — a batch count, no extra call per agent | Badge is a **roster property**, like a status pill — no new poll, no new endpoint |
| Pending feed | `GET /api/agents/{aid}/notifications/pending?limit=&before_ts=&before_id=` → rows + envelope `total_pending`; returns **both zones** (work + conversation) | One paginated feed powers the whole panel |
| Row shape | `{event_id, event_name, type, zone, priority, actor_ref, actor_alias, actor_kind, deeplink, preview, ts, read}` — `type` is the classified human kind; `deeplink` is `{kind, id}` or `null` | Row renders: type-tinted badge, actor, human phrasing (`preview`), relative time, and either an **Acknowledge** button or a **deep-link** |
| The single veto | `POST /api/agents/{aid}/notifications/{event_id}/acknowledge` body `{suppress_wake:true}` (default **true**); response `{agent_id, event_id, suppressed, human_acked_at}`; **idempotent** (re-ack = 200 no-op); **404** if the event isn't the agent's | Per-row **Acknowledge** → optimistic row removal, rollback on non-2xx; safe to retry |
| Bulk veto ("all") | `POST /api/agents/{aid}/notifications/read` body `{through_ts, suppress_wake:true, ack_event_ids:[…]}`; **requires a non-empty `ack_event_ids`** when `suppress_wake:true`; stamps exactly those loaded, agent-owned rows (a timestamp-only bound is rejected — it could swallow an unseen neighbor at the same `ts`) | **Acknowledge all** sends the loaded rows' `event_id`s, not a bare timestamp; it is offered **only when the loaded page is the full pending set** |
| Snooze | `POST /api/agents/{aid}/wake/snooze` body `{snooze_seconds}` **or** `{until_ts}` (exactly one; 422 otherwise); `snooze_seconds:0` or a past `until_ts` **clears**; response `{agent_id, snooze_until}` | Snooze picker sends `snooze_seconds` for relative choices, `until_ts` for "until 9 AM"; **Clear** sends `snooze_seconds:0` |
| Snooze read state | `snooze_until` rides the **container snapshot** per agent; the client computes `snoozed = snooze_until != null && snooze_until > now()` (same as the portal/wake-scan `snoozed` bool) | Active-snooze "wakes again at…" reads straight off the roster snapshot — no extra call |
| Snooze visibility gate | Snooze is offered **only** when the agent has `auto_wake_interval_secs` set (already a live agent field) | The Snooze control **does not render at all** for agents with no clock/auto-wake configured |

### The two scope boundaries (honest, load-bearing)

PR #106 is deliberately narrow, and the UI has to say so or it will lie:

- **Acknowledge suppresses EVENT-DRIVEN wake reasons only.** An **open task-request** keeps
  `has_pending_task_request` true and an **assigned-ready task** keeps `auto_tasks` — the *work still
  exists*, so the agent still wakes for it. Those rows appear in the pending feed (they can still make
  the agent act), but they carry a `deeplink` and their `type` is a request/task kind. Mobile renders
  them **without an Acknowledge button** — instead a one-line honest hint + a deep-link to the *real*
  veto (**Answer / Reject** the request, or **Unassign** the task). Acknowledging one of these would
  only hide the row; it would not stop the wake.
- **Snooze gates ONLY the clock (`auto_wake_due`) reason.** Event wakes, ready-task wakes and
  owed-request wakes **still fire through a snooze**. The snooze copy states this plainly: *"Snooze
  only pauses the scheduled check-in. Real work still wakes {agent}."* An expired snooze
  **self-clears** (no write needed — the snapshot's `snoozed` just flips false past `snooze_until`).

---

## 2. Where it lives in mobile IA

Two touch-points, both on the **Agents** surface (flow 09) — nothing new in the tab bar.

1. **Agent roster row** — a **bell + count** trailing affordance appears **only when `total_pending`
   > 0**. It reads as a metadata badge (like a status pill), not a primary action. Tapping the bell
   opens the **Pending-wakes panel** directly; tapping the rest of the row still opens agent detail.
   A **snoozed** agent (clock configured + `snoozed` true) also shows a small `zZ` chip on the row so
   the state is legible from the list.
2. **Agent detail** — a **Wakes** section near the top:
   - a **Pending wakes** row (`🔔 3 pending`) that opens the same panel; `0 pending` when empty;
   - the **Scheduled wake** row + **Snooze** control, rendered **only** if `auto_wake_interval_secs`
     is set (idle → "Wakes every 1h · Snooze"; active → "Snoozed · wakes again 4:12 PM · Clear").

The **Pending-wakes panel** itself is a **modal sheet** (Android modal bottom sheet with a drag
handle / iOS `.sheet` with `.medium` + `.large` detents and a grabber) so it can grow to a scrollable
feed and be dismissed with a swipe on both platforms.

---

## 3. The Pending-wakes panel (the veto surface)

```
╭──────────────────────────────── grabber ─────────────────────────────────╮
│ Pending wakes · 3                                                    ✕ / — │
│ These will wake Andrew next time. Acknowledge to say you've seen it —      │
│ the agent won't be woken for it.                                          │
├───────────────────────────────────────────────────────────────────────────┤
│ [event]  💬 message from Kedar            "please review the plan"   2m  [Acknowledge] │
│ [event]  🔁 loop closed                    "run finished · 0 open"   8m  [Acknowledge] │
│ ── still needs an answer (acknowledging won't clear it) ───────────────────┤
│ [req]    📥 open task-request from Ethan   "review the API shape"    5m  [ Answer → ] │
│ [task]   ✅ assigned task ready            "Publish weekly digest"  12m  [Unassign → ] │
├───────────────────────────────────────────────────────────────────────────┤
│                       [  Acknowledge all 2  ]                              │
╰───────────────────────────────────────────────────────────────────────────╯
```

- **Header:** `Pending wakes · {total_pending}`; subtitle names the agent and states what
  Acknowledge means. Dismiss = swipe / grabber (both) plus an explicit **✕** (iOS) / back (Android).
- **Event rows** (the ackable kind): type-tinted badge glyph, `actor_alias`, human `preview`, relative
  `ts`, trailing **Acknowledge** button (`.btn.tonal.sm`).
  - **Per-row Acknowledge** → `POST …/notifications/{event_id}/acknowledge {suppress_wake:true}`.
    **Optimistic:** the row animates out immediately and `total_pending` decrements. **Rollback:** on
    any non-2xx the row slides back in and a snackbar (Android) / toast (iOS) says *"Couldn't
    acknowledge — tap to retry."* Idempotent, so retry is always safe.
- **Scope-boundary rows** (open task-request / assigned-ready task) sit under a subtle divider label
  **"Still needs an answer — acknowledging won't clear it."** They carry **no Acknowledge button**;
  instead a deep-link chip driven by the row's `deeplink`:
  - `type` = request kind → **Answer →** / (**Reject** available inside) — routes to the request detail
    (flow 07) where the real veto lives.
  - `type` = ready-task kind → **Unassign →** — routes to the task detail (flow 05) assignee control.
  - These count toward `total_pending` (they *are* pending) but are **excluded** from the
    Acknowledge-all payload (see below).
- **Acknowledge all** (footer, primary-tonal, full width):
  - Sends `POST …/notifications/read {suppress_wake:true, through_ts:<max loaded ts>,
    ack_event_ids:[<loaded ackable event_ids>]}`. **Only the ackable event rows** go in
    `ack_event_ids` — scope-boundary rows are never bulk-acked (the server would refuse to suppress
    their wake anyway; the work still exists).
  - **Confirm-gated** (see §4). On success the panel clears the acked rows optimistically, then
    **re-fetches** the pending feed so any row that arrived after load, or any scope-boundary row,
    re-appears truthfully.
  - **Partial-load guard:** the button is offered **only when the loaded page is the entire pending
    set** (`loaded_rows == total_pending`). If more pending rows exist than were loaded, the footer
    instead reads *"Showing the newest {n} — scroll to load all before acknowledging everything,"* and
    the button is disabled. This mirrors the portal's "hide Acknowledge all when partially loaded"
    rule and prevents a timestamp bound from silently eating an unseen older row.

---

## 4. Acknowledge-all confirm — platform-split

The bulk action is the one destructive-ish moment (it suppresses several wakes at once), so it is
confirm-gated, and the confirm is the clearest iOS-vs-Android divergence:

| | Android (Material 3) | iOS (HIG) |
|---|---|---|
| Pattern | **`AlertDialog`** centered | **`confirmationDialog`** (action sheet from the bottom) |
| Title | "Acknowledge all 2?" | (action-sheet note) "Acknowledge all 2 pending wakes? Andrew won't be woken for any of them." |
| Body | "Andrew won't be woken for these 2 notifications. Items that still need an answer are left alone." | — |
| Confirm | filled **Acknowledge all** button | **Acknowledge all 2** (bold, default) |
| Cancel | text **Cancel** | **Cancel** (separate group) |
| Count | always the **ackable** count (excludes scope-boundary rows), so the number matches what actually happens |  |

Per-row Acknowledge is **not** confirmed on either platform — it is a single, idempotent, optimistic
action with rollback, exactly like archiving one mail. Only the bulk action gets a confirm.

---

## 5. The clock-wake snooze control

Rendered in **agent detail → Wakes**, and **only** when `auto_wake_interval_secs` is set.

**Idle (no active snooze):**
```
SCHEDULED WAKE
┌─────────────────────────────────────────────┐
│ 🕑  Checks in every hour            [ Snooze ] │
│     Next scheduled check-in ~4:12 PM          │
└─────────────────────────────────────────────┘
```

**Snooze picker** (opened by the Snooze button):

| Choice | Sends | Portal parity |
|---|---|---|
| For 1 hour | `{snooze_seconds: 3600}` | "1 hour" |
| For 4 hours | `{snooze_seconds: 14400}` | "4 hours" |
| Until 9 AM tomorrow | `{until_ts: <client-computed epoch>}` | "until tomorrow 9am" |

- **Android:** a small **modal bottom sheet** listing the three choices (+ **Clear snooze** when one is
  active). **iOS:** a **`confirmationDialog`** / `Menu` with the same three items (+ **Clear** / a
  destructive **Clear snooze** row when active).
- **"Until 9 AM tomorrow"** the client computes `until_ts`; the other two send `snooze_seconds`. Exactly
  one field per call (the server 422s if both).

**Active snooze:**
```
SCHEDULED WAKE
┌─────────────────────────────────────────────┐
│ 💤  Snoozed · wakes again 4:12 PM    [ Clear ] │
│     Snooze only pauses the scheduled check-in.│
│     Real work still wakes Andrew.             │
└─────────────────────────────────────────────┘
```
- "wakes again {time}" is `snooze_until` formatted (absolute + relative hint). State comes straight
  off the snapshot's `snooze_until`; the client computes `snoozed`.
- **Clear** → `POST …/wake/snooze {snooze_seconds:0}` → response `snooze_until:null` → reverts to idle.
- **Expiry is silent:** once `snooze_until` passes, the next snapshot poll returns `snoozed=false`
  and the row reverts to idle with **no user action and no write** — the copy never promises a wake at
  a time that's already gone.
- On the roster, an active snooze also shows the small `zZ` chip (§2).

---

## 6. States (each surface: empty / loading / error / laptop-unreachable)

| Surface | Empty | Loading | Error | Laptop-unreachable |
|---|---|---|---|---|
| **Bell + badge** (roster/detail) | badge simply absent (`total_pending == 0`) | roster skeleton (flow 04/09) — badge is just a row property | roster error state (flow 04) | shared flow-04 danger banner; last-known count dimmed |
| **Pending-wakes panel** | "All caught up" state — big check glyph, *"Nothing pending. {agent} will only wake for real work."* | 3–4 shimmer rows (`.skel.card-h74`) | "Couldn't load pending wakes" state + **Retry** | danger banner pinned atop the sheet; feed dimmed; **Acknowledge / Acknowledge all disabled** (can't reach the laptop) |
| **Snooze control** | (control hidden entirely if no `auto_wake_interval_secs`) | inline row skeleton within detail | inline "Couldn't update snooze" toast; state unchanged (optimistic revert) | Snooze/Clear **disabled**; row shows last-known state + the banner |

Notes:
- The panel's optimistic actions **revert** on the unreachable/error path — a veto only "sticks"
  after a 2xx, never on the assumption the laptop is up.
- "Laptop-unreachable" is the same connectivity model as the whole app (flow 03/04): it is a
  transport failure, not a per-feature error, so the banner + disabled-actions treatment is inherited,
  not reinvented.

---

## 7. Frames in the gallery

| Frame | Screen | Platform · theme | Notes |
|---|---|---|---|
| N1 | Agents roster — bell badges + snooze chip | iOS · light | rows with `🔔 3`; one snoozed agent shows `zZ`; one agent with 0 pending has no badge |
| N2 | Agents roster — bell badges | Android · dark | M3 list rows; badge on the bell; tap target note |
| N3 | Pending-wakes panel — populated | iOS · dark (`.sheet`) | 2 ackable event rows (Acknowledge) + divider + 1 open-request + 1 ready-task deep-link row; **Acknowledge all 2** footer |
| N4 | Pending-wakes panel — mid optimistic ack | Android · light (modal bottom sheet) | one event row collapsing out; count ticking 3→2; rest of feed intact |
| N5 | Acknowledge-all confirm | iOS · dark | `confirmationDialog` action sheet; count = ackable only (2) |
| N6 | Acknowledge-all confirm | Android · dark | M3 `AlertDialog`; body spells out "items that still need an answer are left alone" |
| N7 | Panel — partial-load guard | Android · light | footer disabled + "Showing the newest 20 — scroll to load all" |
| N8 | Agent detail — Wakes section, snooze **idle** | iOS · light | Pending-wakes row + "Checks in every hour · Snooze"; grouped-inset |
| N9 | Snooze picker | Android · dark (bottom sheet) | 1 hour / 4 hours / Until 9 AM tomorrow |
| N10 | Agent detail — snooze **active** | Android · dark | "Snoozed · wakes again 4:12 PM · Clear" + honest "real work still wakes" line |
| N11 | Panel — empty ("All caught up") | Android · light | check glyph state |
| N12 | Panel — loading skeleton | iOS · dark | shimmer rows |
| N13 | Panel — laptop unreachable | Android · dark | danger banner pinned; feed dimmed; actions disabled |
| N14 | Per-row ack rollback | iOS · light | row slid back + toast "Couldn't acknowledge — tap to retry" |

Bell-badge loading/error and the snooze error-toast are inherited from flow 04/09 and called out in
§6 rather than given dedicated frames (they are not new visuals).

---

## 8. Platform notes (iOS vs Android)

| Aspect | Android (Material 3 / Compose) | iOS (SwiftUI / HIG) |
|---|---|---|
| Panel container | `ModalBottomSheet` with drag handle | `.sheet` with `.presentationDetents([.medium, .large])` + grabber |
| Bell badge | `BadgedBox` on a bell `Icon` in the roster `ListItem` trailing slot | bordered count capsule beside an SF Symbol `bell.fill` in the row trailing slot |
| Event row action | `TextButton`/tonal `Button` "Acknowledge" | bordered-tinted `Button` "Acknowledge" (`.buttonStyle(.bordered)`) |
| Optimistic remove | `AnimatedVisibility` shrink + `SnackbarHost` for rollback | `.transition(.move+.opacity)` + top toast for rollback |
| Deep-link row | `AssistChip` "Answer →" / "Unassign →" → `NavController` | bordered `Button` with chevron → `NavigationLink` |
| Acknowledge-all confirm | `AlertDialog` | `confirmationDialog` (action sheet) |
| Snooze picker | `ModalBottomSheet` list | `confirmationDialog` / `Menu` |
| Snooze idle/active row | `OutlinedCard` + `ListItem` two-slot; trailing `TextButton` | grouped `LabeledContent` in a card; trailing `Button` |
| Clear snooze | `TextButton` "Clear" (or destructive row in the sheet) | `.destructive` role in the menu / a "Clear" button |
| Empty / loading / error | flow-04 `state` + `skel` components | same, themed |
| Back / dismiss | system back or swipe collapses the sheet | swipe-down or ✕ dismisses; back-swipe on detail |

Everything else — status pills, avatars, banners, snackbars/toasts, skeletons, the unreachable model,
deep-link navigation — is inherited unchanged from the GH #30 base (flows 04/05/07/09).

---

## 9. Endpoints used (all real in PR #106 — no new API ask)

| Action | Endpoint | Status |
|---|---|---|
| Bell-badge count | `total_pending` per agent on `GET /api/containers/{cid}` snapshot | **PR #106** |
| Load pending feed | `GET /api/agents/{aid}/notifications/pending?limit=&before_ts=&before_id=` → rows + `total_pending` | **PR #106** |
| Acknowledge one | `POST /api/agents/{aid}/notifications/{event_id}/acknowledge {suppress_wake:true}` (idempotent) | **PR #106** |
| Acknowledge all | `POST /api/agents/{aid}/notifications/read {suppress_wake:true, through_ts, ack_event_ids:[…]}` | **PR #106** |
| Snooze the clock wake | `POST /api/agents/{aid}/wake/snooze {snooze_seconds}` or `{until_ts}` (0/past clears) | **PR #106** |
| Snooze read state | `snooze_until` per agent on the snapshot (client computes `snoozed`) | **PR #106** |
| Snooze visibility gate | `auto_wake_interval_secs` per agent (existing field) | exists |
| Deep-link — answer/reject request | `POST /api/requests/{rid}/respond` / `/reject` (via flow 07) | exists |
| Deep-link — unassign ready task | task assignee mutation (via flow 05) | exists |
| Live refresh | SSE `GET /api/containers/{cid}/events` | exists |

**No new API ask.** Every surface is buildable on the endpoints above. If review surfaces a
capability the design assumes but the PR does not ship, it is added to
[`../13-api-asks.md`](../13-api-asks.md); at authoring time there is none.

## 10. Coordination

Scoped for **Andrew** (Android) and **Ethan** (iOS) to build on top of the GH #30 base they already
acknowledged. No new connectivity/auth/nav decisions — the badge count and snooze state ride the
snapshot the roster already polls, and the veto/snooze actions are ordinary POSTs with optimistic +
rollback (the pattern already used for task actions). The only cross-platform contract to keep aligned
is the **scope-boundary rule** (§1): a request/task-kind row must deep-link, never offer a bare
Acknowledge — same rule on both platforms and the web portal, so a user sees one consistent truth
about what a veto can and can't stop.
