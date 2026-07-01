# Flow 11 — Create & assign a task

Mockups: [`../mockups/11-create-task.html`](../mockups/11-create-task.html)

> **Status: ships against the existing API.** `POST /api/containers/{cid}/tasks` is live (the portal
> creates tasks with it today); the agent picker reads the snapshot; later reassignment is
> `POST /api/tasks/{tid}/assign`. No new backend asks.

## 1. Story

The human captures a piece of work — title, what "done" means, who should do it — in under a
minute, from anywhere in the workspace. The form is a faithful mobile mapping of the API schema:
nothing invented, nothing dropped. The one field we editorialize is **Definition of done**: it gets
first-class treatment (required, helper text) because it is the contract the whole verify loop
(flow 08) settles against — the agent stops at `needs_verification` and the human checks the result
against exactly this text.

## 2. Entry points

- **Android:** FAB on the Home and Tasks tabs → **full-screen dialog** (M3): X to dismiss,
  **Create** text button in the app bar.
- **iOS:** toolbar **+** on the Home and Tasks tabs → **sheet at the `.large` detent** with a nav
  bar: **Cancel** (leading) / **Create** (trailing, bold).

## 3. Form — field-by-field mapping to the API schema

| UI field | API field | Required | Notes |
|---|---|---|---|
| Title | `title` | **yes** | single line |
| Description | `description` | no | multiline, "context the agent will read" |
| Definition of done | `definition_of_done` | **yes** | multiline; helper text: *"How will you know it's done? The agent stops at needs-verification and you check against this."* |
| Assign to | `assignee_alias` | no | opens the agent picker sheet (avatars + live status pills, from the snapshot); **Unassigned** allowed — task parks in the backlog, assign later via `POST /api/tasks/{tid}/assign` |
| Priority | `priority` (int) | defaulted | segmented **Low / Normal / High** → `300 / 100 / 20`. Lower int = more urgent; `100` matches the portal's default, `20` lands inside the portal's high-priority badge tint (`P≤20`) |
| Depends on *(Advanced)* | `depends_on` (array of task ids) | no | multi-select over the container's non-terminal tasks; collapsed by default |
| Park it *(Advanced)* | `not_ready` (bool) | no | toggle, copy: *"Park it — the agent won't start yet."* Task is created `pending` instead of ready-to-claim |
| — (implicit) | `created_by_agent_id` | **yes** | the paired human's agent id (pairing payload, flow 03) — never shown as a field |

Out of scope for mobile v1: the portal's optional create-time **protocol** block (#55) — a
power-user affordance that stays portal-only until asked for.

## 4. Screens & states (mockup frames)

| Frame | State | Notes |
|---|---|---|
| N1 | Create form — Android dark | full-screen dialog, filled example ("Add dark-mode screenshots to the website", DoD, Andrew, Normal), Advanced expanded (depends-on chip + park toggle) |
| N2 | Create form — iOS light | `.large`-detent sheet, nav-bar Cancel/Create |
| N3 | Assignee picker | bottom sheet: Unassigned row + agent rows with avatar, role, live status pill |
| N4 | Validation error | empty DoD → inline error, Create disabled |
| N5 | Discard-draft confirm | iOS action sheet, shown only when the form is dirty |
| N6 | Submit failure | danger banner in the form, every field preserved |

## 5. Behavior

- **Validation:** **Create is disabled until `title` and `definition_of_done` are both non-empty**
  (whitespace-trimmed). Inline required-errors appear on field blur or on a disabled-Create tap
  (frame N4) — the button never silently ignores a tap.
- **Priority:** three-way segmented control, default **Normal**. The raw int is never asked for on
  mobile; task lists render the mapped word + `P{n}` pill consistent with the portal thresholds.
- **Assignee picker (N3):** reads agents (`kind='ai'`) from `GET /api/snapshot/{cid}`; each row
  shows avatar, role line, and live status pill (status→color per foundations). A busy agent is
  selectable — the task simply queues for it; the row says so ("working — will pick this up next").
  Empty container (no agents): the picker shows an empty state ("No agents registered yet — the
  task will start unassigned") and the field falls back to Unassigned.
- **Dirty-form dismissal:** X / Cancel / swipe-down with any field edited → discard confirm
  (frame N5: "Discard Draft" destructive / "Keep Editing"). A pristine form dismisses silently.
  iOS marks the sheet `interactiveDismissDisabled` while dirty so swipe-down routes through the
  same confirm.
- **Submit:** one POST with exactly the schema fields (omit empty optionals). On 2xx:
  - dismiss the form, **snackbar (Android) / toast (iOS)**: "Task created · assigned to Andrew —
    he'll wake and start" (assignment wakes the agent automatically; unassigned copy: "Task
    created — parked in the backlog"),
  - navigate to the new **Task detail** (flow 05) so the first status change is visible live (SSE).
- **Submit failure** (non-2xx / timeout): stay on the form, danger banner at the top ("Couldn't
  create the task — nothing was lost") with Retry; all fields keep their values (frame N6). 4xx
  validation details from the server render under the offending field when identifiable.
- **Unreachable:** if the container probe fails while the form is open, the form stays editable but
  Create disables and the shared unreachable banner (flow 04) appears — same no-offline-queue rule
  as everywhere else; the draft survives until connectivity returns.

## 6. Platform notes

- **Android:** M3 full-screen dialog (X + action button in the top app bar), fields as filled text
  fields; picker and priority are a modal bottom sheet + segmented button row; park toggle is an M3
  Switch. Snackbar confirmation.
- **iOS:** sheet with nav-bar Cancel/Create, grouped-inset style fields; picker is a nested sheet
  (`.medium` detent); park toggle is a standard Toggle row. Toast banner confirmation.
- **Both:** Advanced (`Depends on`, `Park it`) sits behind a collapsed disclosure so the default
  form is four fields tall. Field order fixed: Title → Description → Definition of done → Assign
  to → Priority → Advanced.

## 7. Endpoints used

| Action | Endpoint | Status |
|---|---|---|
| Create the task | `POST /api/containers/{cid}/tasks` `{title, description?, definition_of_done, priority, created_by_agent_id, assignee_alias?, depends_on:[], not_ready?}` | exists |
| Agents for the picker | `GET /api/snapshot/{cid}` (agents slice) | exists |
| Open tasks for Depends on | `GET /api/containers/{cid}/tasks` (non-terminal) | exists |
| Assign / reassign later | `POST /api/tasks/{tid}/assign` | exists |
| Live status after create | SSE `GET /api/containers/{cid}/events` | exists |
