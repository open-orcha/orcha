# Flow 14 — Scheduled (repeating) tasks

Mockups: [`scheduled-tasks.html`](scheduled-tasks.html) · Design system: [`../01-foundations.md`](../01-foundations.md) · [`../12-component-inventory.md`](../12-component-inventory.md)

Mobile (iOS + Android) design for **scheduled tasks** — a task that re-fires on a fixed interval —
adding the mobile equivalent of [PR #68](https://github.com/open-orcha/orcha/pull/68) (closes
[#27](https://github.com/open-orcha/orcha/issues/27)). This is a delta on the delivered GH #30
package: same tokens, same components, same iOS-HIG / Android-Material-3 skeletons. Nothing here
re-invents a component — it reuses the create form (flow 11), the task card + detail (flow 05), and
the shared state patterns (flow 04).

> **Status: creation + list + detail read ship against PR #68's API. The one gap is
> editing/turning-off a schedule on an existing task — no update route exists — flagged as new API
> ask [A7](../13-api-asks.md#a7--task-update-endpoint-edit--turn-off-a-schedule-new).** Firing is entirely server-side (the notifier calls
> `POST /api/containers/{cid}/fire-due-schedules`); it is never a client action, so the apps add no
> new connectivity or realtime surface — they reuse GH #30's SSE + laptop-unreachable model wholesale.

---

## 1. What PR #68 actually gives us (ground truth)

Verified against the PR #68 diff (the field is not in live `/openapi.json` until #68 merges):

| Fact | Detail | Design consequence |
|---|---|---|
| One opt-in field | `schedule_interval_secs` on create: `Optional[int]`, `ge=60`, `null` = run-once | The whole feature is **one field** on the create form + two read fields on the card/detail |
| Cadence anchor | Re-fires `schedule_interval_secs` **after each completion** (`completed → ready`), never overlaps | Copy everywhere reads "after each run / after it finishes", not "every X on the clock" |
| Minimum | DB `CHECK (… >= 60)`; create validates `ge=60`; portal client + server both reject `< 60` | Picker floor = 60s; below-min error mirrors server copy verbatim |
| No dependencies | Server **400** if a scheduled task has `depends_on` (either direction) | Repeat and Depends-on are **mutually exclusive** in the create UI |
| Two read fields | `schedule_interval_secs` + `last_fired_at` ride the shared task-list builder — surfaced on the snapshot poll **and** `GET /api/containers/{cid}/tasks` with no extra call | List badge + detail schedule section need **zero new read endpoints** |
| `last_fired_at` | Stamped `now()` **only on re-arm**; "observability only" (the due check keys off `completed_at`) | "Next run" is **unknown before the first re-arm** — never show a countdown that would be fiction |
| No update route | The only mutations on an existing task are cancel / done / verify / assign / protocol. **Nothing sets `schedule_interval_secs` after create.** | Change-interval / turn-off-but-keep-task = **new API ask [A7](../13-api-asks.md#a7--task-update-endpoint-edit--turn-off-a-schedule-new)** |
| Re-arm guard | Re-arm matches **only** `status='completed'`, and only while the container is `active` | **Cancelling the task stops all future runs today** — no new API needed to *end* a repeat |
| Firing | `POST …/fire-due-schedules` is the notifier's server-side tick | Not a user action; no button, no client surface |

### The turn-off hinge (important, honest)

There are two different "stop" intentions and they land on different sides of the API gap:

- **End the repeat entirely (stop the task):** works **today** via the existing
  `POST /api/tasks/{tid}/cancel`. A cancelled task is no longer `completed`, so it never re-arms.
  Mobile surfaces this as the normal **Close task** in the detail overflow (flow 05 §3) — for a
  repeating task the confirm copy gains one line: *"This also stops it from repeating."*
- **Keep the task but change the interval, or pause repeating without closing:** needs **A7**. Until
  A7 ships, these controls render **disabled with an honest note**, never a dead button.

## 2. Interval picker (creation) — friendly, but faithful to 60s

Presets map 1:1 to the portal's `fmtInterval` humanization so the phone, the web portal, and the CLI
all say the same words:

| Preset | `schedule_interval_secs` | Portal renders |
|---|---|---|
| Every 5 min | `300` | "5 min" |
| Every 15 min | `900` | "15 min" |
| Every hour | `3600` | "1 hour" |
| Every 6 hours | `21600` | "6 hours" |
| Daily | `86400` | "1 day" |
| Custom… | value × unit (Min / Hours), floored at 60s | humanized on save |

- **Default when Repeat is toggled on:** Every hour (`3600`) — a safe, common cadence well above the floor.
- **Custom** opens a value + unit control (Minutes / Hours). The resolved seconds must be a whole
  number `>= 60`; below that the field shows the inline error and Create is blocked.
- **Below-minimum copy (mirrors PR #68 verbatim):**
  *"Repeat interval must be a whole number of seconds ≥ 60 (or leave it blank)."* The picker's
  friendly phrasing above it reads *"The shortest repeat is 1 minute."*
- **Off/default:** Repeat is **off by default** — the form is unchanged from flow 11 for anyone who
  doesn't want a schedule; `schedule_interval_secs` is simply omitted from the POST.

## 3. Where it lives in the create form

Repeat is a row inside the existing **Advanced** disclosure (flow 11 §3), co-located with
**Depends on** and **Park it**, because Repeat and Depends-on are mutually exclusive and co-location
makes the grey-out legible:

```
Advanced ▾
  Depends on          [chips…]      ← greyed + noted when Repeat is on
  Repeat              ( ●) off/on   ← greyed + noted when Depends-on has chips
     └ when on:  [5m][15m][1h•][6h][Daily][Custom]
        helper: Runs once, then re-runs this long after each finish.
                Cadence is measured from completion, so runs never overlap.
  Park it             ( ●)
```

- **Mutual exclusion (matches server 400):** if **Depends on** has any chips, the Repeat toggle is
  disabled with the note *"A repeating task can't have dependencies."* If **Repeat** is on, the
  Depends-on row is disabled with the same note. The user can never build the combination the server
  rejects.
- **Park it** stays compatible: a parked (`not_ready`) repeating task is created `pending`; it starts
  repeating only after it first runs and completes (re-arm keys off `completed`).

## 4. List — the "Repeats" badge

On the task card meta row (flow 05 §2), scheduled tasks gain one tag, mirroring the portal's
`↻ every X`:

```
[status pill]  Publish the weekly digest
               [avatar] Andrew · P100 · ↻ every hour · updated 8m ago
```

- **Tag:** `↻ every {humanized interval}`, accent-tinted (`.tag.sched`) so it reads as a distinct,
  positive property — not a status. Status stays the pill; the badge is metadata, exactly like the
  portal.
- **Next-fire on the card:** shown **only** once `last_fired_at` exists, appended as `· next ~4:12 PM`.
  A brand-new repeating task that has never re-armed shows just `↻ every hour` — no countdown
  (avoids the fiction the token-level guidance calls out).
- Repeating tasks sort and group by their live status like any task; the badge is orthogonal to the
  status grouping.

## 5. Detail — the Schedule section

A new **Schedule** section in task detail (flow 05 §3), placed right after the Definition-of-done
card. Because a scheduled task can never have dependencies, this section effectively takes the
Dependencies slot for these tasks.

```
SCHEDULE
┌───────────────────────────────────────────────┐
│ Repeats        every hour                       │
│ Last run       3:12 PM · 2h ago                 │   ← last_fired_at (or "hasn't re-armed yet")
│ Next run       ~4:12 PM · in 58m                │   ← ONLY when last_fired_at exists
│ ─────────────────────────────────────────────  │
│ Measured from each completion — runs never       │
│ overlap.                                         │
└───────────────────────────────────────────────┘
```

- **Before the first re-arm** (`last_fired_at` null): "Last run" reads *"Hasn't re-armed yet"* and
  "Next run" reads *"After this run finishes"* — never a numeric countdown.
- **After a re-arm:** "Next run" = `last_fired_at + interval`, rendered as an absolute time + a
  relative hint.
- **Edit / turn-off (overflow menu):** the detail overflow (ellipsis) gains **Change interval…** and
  **Turn off repeat…**. Both depend on **A7** and render **disabled** with a footnote
  *"Editing a repeat needs an app update — coming soon."* until A7 ships. The existing **Close task…**
  item is always live and, for a repeating task, its confirm copy gains *"This also stops it from
  repeating."* — the honest, ships-today way to end a repeat.

## 6. Screens & states (mockup frames)

| Frame | Screen | Platform · theme | Notes |
|---|---|---|---|
| R1 | Create — Repeat **off** (default) | iOS · light | Advanced expanded; Repeat toggle off; form identical to flow 11 for non-schedule users |
| R2 | Create — Repeat **on**, preset picker | Android · dark | chips 5m/15m/1h•/6h/Daily/Custom, "Every hour" chosen; helper copy; Depends-on greyed |
| R3 | Create — **Custom** + below-min error | iOS · dark | Custom = value×unit; "30 sec" → danger ring + server-verbatim error; Create disabled |
| R4 | Create — mutual exclusion (Depends-on set) | Android · light | Depends-on chip present → Repeat toggle disabled + note |
| R5 | Tasks list — Repeats badges | Android · dark | cards with `↻ every X`; one fresh (no next), one fired (`· next ~4:12 PM`) |
| R6 | Tasks list — Repeats badge | iOS · light | large-title list; badge on a needs-verification repeating task |
| R7 | Task detail — Schedule section (fired) | iOS · dark | cadence / last run / next run populated; overflow with disabled A7 items |
| R8 | Task detail — Schedule (never re-armed) | Android · light | "Hasn't re-armed yet" / "After this run finishes"; Close-task confirm copy note |
| R9 | List loading skeleton | iOS · light | shimmer cards (badge is just a card property — no special skeleton) |
| R10 | Detail — laptop unreachable | Android · dark | shared flow-04 danger banner; Change-interval/Turn-off already disabled (A7) stay disabled, Close disabled too |

Empty state is unchanged from flow 05 (a container with no tasks shows the standard "No tasks yet");
there is no separate "no repeating tasks" empty state — repeating tasks are ordinary tasks with a badge.

## 7. Platform notes (iOS vs Android)

| Aspect | Android (Material 3 / Compose) | iOS (SwiftUI / HIG) |
|---|---|---|
| Repeat toggle | M3 `Switch` row inside the Advanced section | `Toggle` row in the grouped-inset form |
| Interval presets | `FilterChip` single-select row | horizontal capsule `Picker`-style segmented chips |
| Custom value | `OutlinedTextField` (number) + `SingleChoiceSegmentedButtonRow` for Min/Hours | `TextField` (.numberPad) + segmented `Picker` for Min/Hours |
| Below-min error | inline supporting text in error color under the field | inline caption in `.red` under the field |
| Badge | tinted `AssistChip`-style tag on the card | bordered `Text` capsule tag on the row |
| Schedule section | `OutlinedCard` with `ListItem` two-slot rows | grouped `LabeledContent` rows in a card |
| Edit/turn-off | `DropdownMenu` items, disabled with helper text | `Menu` items, `.disabled(true)` with footnote |
| Close-task confirm | M3 `AlertDialog` (+ the extra "also stops repeating" line) | `confirmationDialog` (same extra line as the note) |
| Feedback | `Snackbar` ("Task created · repeats every hour") | top toast banner (same copy) |

Everything else — status pills, DoD card, thread, bubbles, unreachable banner, create-form
validation, dirty-discard — is inherited unchanged from flows 05 and 11.

## 8. Endpoints used

| Action | Endpoint | Status |
|---|---|---|
| Create a repeating task | `POST /api/containers/{cid}/tasks {…, schedule_interval_secs}` (omit or `null` = run-once) | **PR #68** (merges as part of #27) |
| List with badge fields | `GET /api/containers/{cid}/tasks` → each task carries `schedule_interval_secs`, `last_fired_at` | **PR #68** (shared task-list builder) |
| Detail schedule fields | `GET /api/tasks/{tid}/messages` → `{task,…}` carries the same two fields | **PR #68** |
| End a repeat (stop the task) | `POST /api/tasks/{tid}/cancel {actor_agent_id, reason?}` | exists |
| **Change interval / turn off but keep the task** | *no route today* → **[A7](../13-api-asks.md#a7--task-update-endpoint-edit--turn-off-a-schedule-new)** proposed task-update endpoint | **NEW — ask A7** |
| Firing (server-side, not client) | `POST /api/containers/{cid}/fire-due-schedules` — notifier tick | **PR #68**, server-only |
| Live status after create / re-arm | SSE `GET /api/containers/{cid}/events` | exists |

## 9. Coordination

Scoped for **Andrew** (Android) and **Ethan** (iOS) to build from, on top of the GH #30 base they
already acknowledged. No new connectivity/auth/nav decisions — firing is server-side and the read
fields ride existing endpoints. The only open contract question is **A7** (the task-update endpoint
shape), which is a backend + portal decision; the apps ship the create/list/detail-read designs now
and wire the edit/turn-off affordance when A7 lands.
