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
| Row shape | `{event_id, event_name, type, zone, priority, actor_ref, actor_alias, actor_kind, deeplink, preview, ts, read}` — `type` is the classified human kind; `deeplink` is `{kind, id}` or `null`. The row does **NOT** ship `is_task_request` — the classifier computes it server-side but the feed route drops it (row shape verified in the route docstring) | Mobile can't branch a *task*-request row from an *info*-request row, so it doesn't try: **every row renders an Acknowledge button** (portal parity). The 5 "stateful" `event_name`s (`PN_STATEFUL`, §1 boundary box) *additionally* show an honest hint + a deep-link chip |
| The single veto | `POST /api/agents/{aid}/notifications/{event_id}/acknowledge` body `{suppress_wake:true}` (default **true**); response `{agent_id, event_id, suppressed, human_acked_at}`; **idempotent** (re-ack = 200 no-op); **404** if the event isn't the agent's. Accepted on **every** row kind — the server stamps `human_acked_at` even on a request/task row (it does not 400 those) | Per-row **Acknowledge** on every row → optimistic removal, rollback on non-2xx; safe to retry. On a stateful row the ack is real; the *wake* just persists if open work remains |
| Bulk veto ("all") | `POST /api/agents/{aid}/notifications/read` body `{through_ts, suppress_wake:true, ack_event_ids:[…]}`; **requires a non-empty `ack_event_ids`** when `suppress_wake:true`; **`ack_event_ids` is hard-capped at 200** (`400 "ack_event_ids is limited to 200 rows"`); stamps exactly those loaded, agent-owned rows (a timestamp-only bound is rejected — it could swallow an unseen neighbor at the same `ts`) | **Acknowledge all** sends **all** loaded rows' `event_id`s (every kind — portal parity), not a bare timestamp; offered **only when the loaded page is the full pending set**; a backlog **>200 is sent in sequential ≤200 batches** (§3) |
| Snooze | `POST /api/agents/{aid}/wake/snooze` body `{snooze_seconds}` **or** `{until_ts}` (exactly one; 422 otherwise); `snooze_seconds:0` or a past `until_ts` **clears**; response `{agent_id, snooze_until}` | Snooze picker sends `snooze_seconds` for relative choices, `until_ts` for "until 9 AM"; **Clear** sends `snooze_seconds:0` |
| Snooze read state | `snooze_until` rides the **container snapshot** per agent; the client computes `snoozed = snooze_until != null && snooze_until > now()` (same as the portal/wake-scan `snoozed` bool) | Active-snooze "wakes again at…" reads straight off the roster snapshot — no extra call |
| Snooze visibility gate | Snooze is offered **only** when the agent has `auto_wake_interval_secs` set (already a live agent field) | The Snooze control **does not render at all** for agents with no clock/auto-wake configured |

### Portal parity + the two honest scope boundaries (load-bearing)

The web portal renders **Acknowledge on every row** and its "Acknowledge all" **includes** the
stateful rows. Mobile matches that exactly — anything else is an undisclosed web/mobile divergence
that would tell the user two different stories. Since the feed row does not expose `is_task_request`,
mobile *can't* branch anyway, and it *shouldn't*: acknowledge always means the same honest thing
(*"I've seen this — don't wake {agent} for this event"*), and the server accepts it on every row.
PR #106 is still deliberately narrow, so the UI has to state two boundaries or it will lie:

- **Acknowledge suppresses EVENT-DRIVEN wake reasons only — and the row says so when work remains.**
  For a purely event-driven row (a message, a closed loop, an **open info-request** — an info request
  wakes purely via its event, so acking it *fully* stops the wake), Acknowledge is the whole story.
  For the 5 "stateful" event names
  **`PN_STATEFUL = {request_created, escalation, agent_suggested, task_assigned, task_ready}`**, the
  underlying work can outlive the ack: an **open task-request** keeps `has_pending_task_request` true,
  an **assigned-ready task** keeps `auto_tasks`. Those rows **still get an Acknowledge button** (the
  ack is accepted — the server stamps `human_acked_at`), but they **additionally** show one true line
  — *"Acknowledging marks it seen. If it still has open work — a live request or a ready task —
  {agent} keeps waking until you resolve it."* — plus a **deep-link chip** from the row's `deeplink`:
  **Answer →** (request), **Unassign →** (ready task), **Open →** (other). The hint is honest for all
  five because it's conditional: acknowledging *does* mark it seen; the *wake* only persists **if** the
  work still exists. (This corrects the earlier draft, which wrongly said these rows "can't be acked"
  and that "the server would refuse to suppress their wake" — the server accepts the ack fine.)
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
│ Pending wakes · 4                                                    ✕ / — │
│ These will wake Andrew next time. Acknowledge to say you've seen it —      │
│ Andrew won't be woken for that event.                                     │
├───────────────────────────────────────────────────────────────────────────┤
│ 💬 message from Kedar          "please review the plan"    2m  [Acknowledge]│
│ 🔁 loop closed                  "run finished · 0 open"    8m  [Acknowledge]│
│ 📥 task-request from Ethan      "review the API shape"     5m  [Acknowledge]│
│    ⚠ If it still has open work, Andrew keeps waking.          [ Answer → ] │
│ ✅ assigned task ready          "Publish weekly digest"   12m  [Acknowledge]│
│    ⚠ A ready task still wakes until it's reassigned.        [ Unassign → ] │
├───────────────────────────────────────────────────────────────────────────┤
│                       [  Acknowledge all 4  ]                              │
╰───────────────────────────────────────────────────────────────────────────╯
```

- **Header:** `Pending wakes · {total_pending}`; subtitle names the agent and states what
  Acknowledge means. Dismiss = swipe / grabber (both) plus an explicit **✕** (iOS) / back (Android).
- **Every row is ackable** (portal parity): type-tinted badge glyph, `actor_alias`, human `preview`,
  relative `ts`, trailing **Acknowledge** button (`.btn.tonal.sm`).
  - **Per-row Acknowledge** → `POST …/notifications/{event_id}/acknowledge {suppress_wake:true}`.
    **Optimistic:** the row animates out immediately and `total_pending` decrements. **Rollback:** on
    any non-2xx the row slides back in and a snackbar (Android) / toast (iOS) says *"Couldn't
    acknowledge — tap to retry."* Idempotent, so retry is always safe.
- **Stateful rows** (`event_name ∈ PN_STATEFUL`) keep their Acknowledge button but **add** an honest
  hint line + a deep-link chip driven by the row's `deeplink` — because the underlying work can
  outlive the ack:
  - hint (true for all five, conditional): *"Acknowledging marks it seen. If it still has open work —
    a live request or a ready task — {agent} keeps waking until you resolve it."*
  - `request_created` (task-request) / `escalation` / `agent_suggested` → **Answer →** (Reject inside)
    — routes to the request detail (flow 07) where the real veto lives.
  - `task_assigned` / `task_ready` → **Unassign →** — routes to the task detail (flow 05) assignee
    control.
  - These are **still acknowledged** by Acknowledge-all (parity); the ack is accepted, the *wake* just
    persists while the work exists — so the panel re-fetches after a bulk ack and any still-open
    stateful row re-appears truthfully (dimmed `read=true`).
- **Acknowledge all** (footer, primary-tonal, full width):
  - Sends `POST …/notifications/read {suppress_wake:true, through_ts:<max loaded ts>,
    ack_event_ids:[<ALL loaded event_ids>]}` — every loaded row, all kinds (portal parity).
  - **200-cap batching:** `ack_event_ids` is hard-capped at **200** server-side. The common case
    (≤200 pending) is a **single call**, identical to the portal. For a backlog **>200**, the client
    sends the ids in **sequential batches of ≤200** (each batch's `through_ts` = the max `ts` in that
    batch) under one confirm + a progress indicator; a failed batch **halts and re-fetches** (idempotent,
    so already-acked rows stay acked and aren't re-sent).
  - **Confirm-gated** (see §4). On success the panel clears the acked rows optimistically, then
    **re-fetches** the pending feed so any row that arrived after load, or any still-open stateful row,
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
| Title | "Acknowledge all 4?" | (action-sheet note) "Acknowledge all 4 pending wakes? Andrew won't be woken for any of them." |
| Body | "Andrew won't be woken for these 4 notifications. Any that still have open work — a live request or a ready task — stay on your other lists until you resolve them." | — |
| Confirm | filled **Acknowledge all** button | **Acknowledge all 4** (bold, default) |
| Cancel | text **Cancel** | **Cancel** (separate group) |
| Count | the **loaded** pending count — every row is acked (portal parity), so the number matches what actually happens |  |
| >200 backlog | one confirm, then sequential ≤200 batches with a progress indicator (§3) | same |

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
| N3 | Pending-wakes panel — populated | iOS · dark (`.sheet`) | **Acknowledge on every row**; 2 plain event rows + 2 stateful rows (task-request, ready-task) that each keep Acknowledge *and* add an honest hint + a deep-link chip; **Acknowledge all 4** footer |
| N4 | Pending-wakes panel — mid optimistic ack | Android · light (modal bottom sheet) | one event row collapsing out; count ticking 3→2; rest of feed intact |
| N5 | Acknowledge-all confirm | iOS · dark | `confirmationDialog` action sheet; count = **all loaded (4)** — parity |
| N6 | Acknowledge-all confirm | Android · dark | M3 `AlertDialog`; body: "any that still have open work stay on your other lists until you resolve them" |
| N7 | Panel — partial-load guard | Android · light | footer disabled + "Showing the newest 20 — scroll to load all"; note re >200 → ≤200 batches |
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
is **portal parity** (§1): **every** pending row offers Acknowledge on both platforms and the web
portal, and the 5 `PN_STATEFUL` rows *additionally* carry an honest hint + a deep-link to the real
veto (Answer / Unassign) — same rule everywhere, so a user sees one consistent truth about what a veto
can and can't stop. Acknowledge-all sends every loaded id in ≤200 batches (identical to the portal's
single call for the common ≤200 case).
