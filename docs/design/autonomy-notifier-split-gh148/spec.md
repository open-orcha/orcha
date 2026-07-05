# Separate the Autonomy slider from the Event-notifier state — design spec

**Issue:** GH #148 · **Designer:** Dana · **Platforms:** web portal, Android, iOS · **Ships as:** one PR.

Mockup: [`mockup.html`](./mockup.html) (open in a browser — all three platform variants on one page).

---

## 1. The problem, in one line

Today one control does two unrelated jobs, so operators can't tell them apart. We split it into
**two controls** that look and behave like the two different things they are.

| Concept | What it means | Backend field | Endpoint |
|---|---|---|---|
| **Event-notifier** | The kill-switch. Do agents wake **at all**? Paused = nothing wakes. | `containers.wakes_enabled` (bool) | `POST /api/containers/{cid}/wakes` `{enabled, actor_agent_id}` |
| **Autonomy** | How far agents may go **when they do** act: Plan-only / Build-to-PR / Full. | `containers.autonomy_level` (`plan`\|`pr`\|`full`) | `POST /api/containers/{cid}/autonomy` `{level, actor_agent_id}` |

These are **orthogonal**: pausing the notifier must not change the autonomy level, and vice-versa.
Both endpoints already exist and are **human-only** (`_require_kind('human')`) — **no backend or schema
change is needed**. This is a UI/UX separation only.

### The mental model we want operators to hold
> **Notifier = the power switch. Autonomy = the gearbox.**
> With the power off, the gearbox setting is remembered but nothing moves. Turning the power off
> never re-shifts the gears.

---

## 2. Current state (what we're replacing)

### Web — `orcha-cli/orcha_cli/templates/portal/static/app.js`, the `AUT_RUNGS` topbar switch
One 4-rung strip `[ Paused | Plan-only | Build to PR | Full ]` renders as a single connected control,
so the two backends read as one 4-step slider. Rung 0 is the wake kill-switch; rungs 1–3 are the level.
The fusion is the bug: it looks like "more paused → more autonomous," which is wrong.

### Mobile (Android + iOS)
- **Notifier:** surfaced only as a **read-only** banner derived from `container.status != "active"`
  ("This Orcha is paused — resume from the laptop"). It reads the *wrong field* (`status`, the
  container lifecycle) instead of `wakes_enabled`, and it can't be toggled in-app.
- **Autonomy:** the DTO carries `autonomy_level` (Android) but **no UI surfaces or edits it**. On iOS
  the DTO doesn't even decode `wakes_enabled` yet.

So on mobile this is mostly greenfield: add two proper, independent controls. Mobile already writes
other human actions with `humanId` as the actor (cancel, verify, decide-plan, create-task…), so
writing to the two human-only endpoints is feasible with the identity the app already has.

---

## 3. The two controls (shared spec)

### 3.1 Notifier — a binary switch
- Two states: **Running** (green) / **Paused** (red). Always shows current state with a colored dot + label.
- **Running → Paused** is destructive-flavored (halts all wakes): confirm first.
  Copy: *"Pause all agent wakes? Agents stop waking immediately. In-flight work finishes; nothing new
  starts. Humans & live terminals still work."* — primary **"Pause all wakes"** (danger).
- **Paused → Running** is safe: lighter confirm.
  Copy: *"Resume agent wakes? Agents resume waking at the current autonomy level."* — primary **"Resume"**.
- When Paused, keep the persistent reinforcement that already exists on web (red topbar edge +
  micro-banner with a Resume affordance); mirror a paused banner on mobile.

### 3.2 Autonomy — a 3-option segmented selector
Three mutually-exclusive levels, each lit in its own brand tone when active:

| Level | Label | Tone | One-line meaning (tooltip/subtitle) |
|---|---|---|---|
| `plan` | **Plan-only** | warn / amber | Agents wake & propose, but every plan stops at the approval gate — you approve before any execution. |
| `pr` | **Build to PR** | info / blue | Agents execute approved plans up to an open PR; you still merge. |
| `full` | **Full** | accent / teal | Agents may carry approved work to its terminal state without further gates. |

- Selecting a **different** level confirms first (it changes the authority envelope; **Full** is
  destructive-flagged because it removes the human completion gate). Selecting the current level is a no-op.
- The active level renders **the same whether the notifier is Running or Paused** — this is the whole
  point. When Paused, the autonomy control is de-emphasized (dimmed) with a hint *"applies when running,"*
  but stays legible and editable so you can pre-set the level before resuming.

### 3.3 States (both controls, every platform)
- **Loading** (snapshot not yet in): controls disabled/skeletoned.
- **Optimistic write → reconcile → revert on failure** (mirror the web `setWakes`/`setAutonomy` shape:
  paint the new state immediately, confirm from the response, revert + toast on error).
- **No actor / not writable:** web already gates on an *acting human* (locked + "Pick an acting human"
  hint); mobile uses the paired `humanId`. If for any reason no human identity is available, show both
  controls **read-only** rather than hiding them.
- **Container not `active` (laptop-level pause/stop via `/orcha-pause`):** this is a *separate, higher*
  state than the notifier. Show a distinct read-only banner ("This Orcha is paused/stopped on the
  laptop") and **disable both in-app controls** — you can't toggle wakes on a container that's globally
  paused. Do **not** conflate this with the notifier switch. (See §6.)
- **Full-autonomy** selection and **Pause** are the two danger-flagged actions.

---

## 4. Web portal

Replace the one `AUT_RUNGS` strip with **two labeled groups** in the topbar, separated by a divider so
they read as two things:

```
┌─ Notifier ──────────┐   ┌─ Autonomy ─────────────────────────────┐
│  ●  Running   [switch] │ │  Plan-only  ·  Build to PR  ·  Full     │
└──────────────────────┘   └────────────────────────────────────────┘
```

- **Notifier group:** micro-label "Notifier" + a pill/toggle showing ● Running (green) / ● Paused (red).
  Click → confirm modal → `POST /wakes`. This is today's rung 0, extracted and labeled.
- **Autonomy group:** micro-label "Autonomy" + a 3-segment control; active segment lit in its tone.
  Click a segment → confirm modal → `POST /autonomy`. These are today's rungs 1–3, extracted.
- Keep the existing paused reinforcement (red topbar border + `#pausebar` micro-banner + Resume),
  now driven **only** by the notifier.
- Narrow widths: the two groups wrap; labels stay. Both groups collapse to icon-triggered popovers
  below the topbar breakpoint (reuse the existing responsive topbar behavior).
- Keep the acting-human lock on both groups (unchanged behavior, now applied per-group).

**Implementation note for CodeCleanupAgent (web lead):** the JS already has separate `setWakes()` and
`setAutonomy()` writers and separate `wakesPaused()`/`autLevel()` readers — only `paintAutonomy()` and
the `AUT_RUNGS` render need restructuring into two hosts. No new endpoints, no new state.

---

## 5. Mobile — one language, two platform dialects

Both apps get a **Container controls** surface (a compact card on the workspace header, expanding to a
sheet) holding the two controls stacked. The paused banner already at the top of the workspace stays,
re-sourced from `wakes_enabled`, and becomes **tappable → opens the controls sheet with Resume primed.**

### Placement
- Entry point: a control on the workspace top bar (a gear / "Autonomy" chip next to the connection
  chip), plus the tappable paused banner. Opens a sheet.
- Sheet contents, top→bottom: **Notifier** row (switch) → divider → **Autonomy** row (segmented) →
  a one-line explainer of the power/gearbox relationship.

### Android (Material 3 / Compose) — for Andrew
- Surface: a `ModalBottomSheet` opened from the header control.
- **Notifier:** an M3 `ListItem` with a trailing `Switch` (green track = Running). Toggling **off**
  opens an `AlertDialog` (destructive confirm) before the write; toggling on opens a light confirm.
- **Autonomy:** `SingleChoiceSegmentedButtonRow` with three `SegmentedButton`s (Plan-only / Build to PR /
  Full), the selected one tinted in its tone. Selecting **Full** opens a destructive `AlertDialog`.
- Back/dismiss: sheet scrim + back gesture dismiss without writing. Toasts → `Snackbar`.
- Wire `wakesEnabled` / `autonomyLevel` from the snapshot; add `setWakes`/`setAutonomy` to
  `OrchaApiClient` (POST with `actorId = humanId`). Fix the workspace banner to read `wakesEnabled`,
  not `status`.

### iOS (HIG / SwiftUI) — for Ethan
- Surface: a `.sheet` (or a `Menu` for quick access) presenting a `Form`/grouped list.
- **Notifier:** a `Toggle` ("Notifier — Running/Paused"), green when on. Flipping **off** triggers a
  `.confirmationDialog` (destructive "Pause all wakes"); flipping on a light confirm.
- **Autonomy:** a segmented `Picker` (`.pickerStyle(.segmented)`) with the three levels; selecting
  **Full** presents a destructive `.confirmationDialog`.
- Dismiss: swipe-down / Cancel without writing. Toasts → the app's existing banner/toast component.
- Add `wakesEnabled` to `Container` DTO decoding; add the two POST calls to the API layer
  (`actor = humanId`). Re-source the paused banner from `wakesEnabled`.

### Read-only fallback
If the app can't resolve a human actor, render both controls disabled (switch/segments non-interactive)
with a footnote *"Change autonomy from the laptop"* — never hide them, so the state is always legible.

---

## 6. Grounded-in-reality notes / flags for the team

1. **No API asks.** Both endpoints exist, are human-only, and return the updated field. Mobile already
   holds a `humanId` actor. Nothing new is required from the backend.
2. **`container.status` ≠ `wakes_enabled`.** The old mobile banner read `status`. These are two
   different states — `status` is the container lifecycle (active/paused/stopped, set by `/orcha-pause`
   on the laptop), `wakes_enabled` is the in-container wake switch. The **notifier control is
   `wakes_enabled`**; keep a *separate* read-only banner for a laptop-level `status` pause, and disable
   the in-app controls while `status != active`. Please confirm this two-tier model reads right to you
   before build — it's the one spot where the split touches an existing (mis-sourced) banner.
3. **Pre-SPEC-1 snapshots** may omit `wakes_enabled` — treat unknown as **Running** (default), matching
   the web `wakesPaused()` fallback; treat unknown `autonomy_level` as **plan**.
4. **Danger flags** stay consistent everywhere: **Pause** and **Full** confirm with a destructive
   primary; **Resume** and Plan/PR confirm with a neutral primary.

---

## 7. Deliverables checklist
- [x] This spec (`spec.md`).
- [x] Cross-platform mockup (`mockup.html`) — web topbar + Android sheet + iOS sheet, showing Running
      and Paused states side-by-side.
- [ ] Rendered PNG attached to GH #148 (for reviewers who don't clone).
- [ ] Handoff request to CodeCleanupAgent (web lead) to coordinate the one shared implementation PR
      with Andrew (Android) and Ethan (iOS).
