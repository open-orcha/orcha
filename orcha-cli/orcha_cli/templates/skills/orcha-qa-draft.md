---
description: Draft outcome-based QA scenarios for an iOS, Android or web app from its code, its map and the flows explorers walked, with the orcha-qa tools. Drafts land in the QA tab for a person to approve. Use when a task asks to write, draft or propose QA scenarios or test cases.
allowed-tools: Bash, Read, Grep, Glob, mcp__orcha-qa
argument-hint: [ios|android|web] [--sources code|exploration|both] [--explore --minutes N] [--focus <feature or journey>]
---

You are executing `/orcha-qa-draft`. You write the scenarios people will trust to say "this
works". A draft is never approved by you: a person reviews it in the QA tab (draft → validated),
the same rule as task verification.

User arguments: `$ARGUMENTS`

If the `mcp__orcha-qa__*` tools are not available, post "QA tools are not on for this project — a
person runs `orcha qa enable`" on the task thread and stop.

**Before drafting, read `/orcha-qa-test-design`** (the coverage model, the techniques and the
quality bar every scenario must meet). This skill says where to look and how to propose.

## 1. Load the project

**What to read** is the person's choice, in the task:

- `--sources code`: the repository only.
- `--sources both`: the repository and the newest three completed explorations.
- `--sources exploration`: those explorations only.
- `--explore --minutes N`: a new exploration first. Run `/orcha-qa-explore` for this same task with
  those minutes and end its session, or leave it to the agent already exploring this task, then
  draft from the code and what it saw. Without a flag, `--sources both` when an exploration exists,
  else `code`.

No device is needed to draft. **Always** call
`start_session(platform, kind="draft", sources=<code|exploration|both>)`: it claims no
device, links your drafts to the task, and opens the drafting page a person watches. Say what you do
as you go with `draft_progress(files=[...], searches=N, note="...")`, a batch at a time: the files
you just read, the searches you made, one plain line on what you are working out.

1. `list_project(platform)`: the targets, existing scenarios with their status (your duplicate
   list), open findings, and the flows with their last walk.
2. `read_map()`: features and screens; a screen the map has `seen` has captured labels and roles
   you can check against; `declared` ones only have the code's words.
3. The code: routes and screens, forms and validation, state enums, error texts, permissions,
   what each journey saves. Read only.
4. Walked flows: a passed walk already became a draft (source `walk`) with evidence frames —
   sharpen it (`revise_scenario`) rather than proposing a second one.
5. Explorations: with `sources` exploration or both, or an explorer on this task, `read_screens()`
   lists the screens with their frame ids and exact labels. A live explorer keeps walking:
   `read_screens(wait_s=60)` again between drafts, and `ask_explorer("open Routines, what does the
   create button say?", wait_s=120)` for what the code leaves open. No explorer running: it says so,
   carry on from the code and mark the rest `unconfirmed`.

## 2. Draft

Build the risk-ranked coverage matrix (`/orcha-qa-test-design` §2), then draft **6–15** scenarios
from the highest risk down; with `--focus`, that area first. Each scenario:

- **name**: what the user does, ≤120 characters ("Add a driver by phone number").
- **description**: the user's goal in one sentence.
- **category** (`Login`, `Registration`, `Checkout`, `Onboarding`, `Search`, `Settings`,
  `Navigation`, `Form`, `Profile`, `Resilience`, `Other`) and **persona** (`Owner`, `New user`, or a
  role the app has).
- **criteria**: 2–5 observable outcomes of one workflow, from the user's point of view, ending in
  its point. Never "tap X"; no screen inventories; no reach-only criteria; a side rule is its own
  small scenario.
- **checks**: for every quoted label a criterion depends on, an exact line keyed by the 0-based
  criterion index: `{"1": ["text \"Trip added\" appears within 10s"]}`. Scope by role
  (`Button "Save"`) only when a captured screen showed that role; otherwise `text "..."`. A toast is
  `appears`. Never dates, times, counts or ids.
- **data**: realistic per-run values for the app's domain and locale (`driver = one of Grace Otieno
  | Brian Kamau | ...`, `plate = pattern KD[A-Z] [0-9]{3}[A-Z]`); never `test123` or run tags.
- **needs**: `fresh install`, `signed in`, `reset` — what it needs from the device, not steps.
- **how it runs**, only when it is not the default: `fresh: false` when it needs what an earlier
  scenario left on the device; `permissions: "ask"` when it tests a permission prompt (otherwise
  permissions are granted first and the dialog never shows); `session: "<name>"` when it starts signed
  in, with the scenario that signs in tagged `setup`; `shared: true` when one set of words holds on
  every platform of the project (otherwise it runs on its platform only).
- **its own data**, when the journey needs it: `seed` (`POST /api/products {...} as product`, then
  `{{product.id}}` in criteria and checks), `cleanup` (`DELETE /api/products/{{product.id}}`), `events`
  (`network: POST /v1/track "checkout_started"`), `examples` (`{columns, rows}`, one check per row; a
  password or token column is sealed by the portal).
- **evidence**: per criterion, `verified` with the `frame_id` of the screen that shows it (from a
  walk or a session), `unconfirmed`, or `code_only` with the `code_ref` (`Sources/Trip/AddTrip.swift:42`).

Propose each with `propose_scenario(...)` as soon as it is ready: it lands on the drafting page by
itself. The reply says `created`, `updated` (a draft with that name) or `suggested` (a validated
scenario: your change goes to a person as a suggestion), plus any lint warnings: fix them with
`revise_scenario(id, ...)`.

When a screen shows a draft is wrong (the button says "Create routine", not "Save"), correct it:
`revise_scenario(id, criteria=[...], reason="the button says Create routine", screen=<frame id>)`.
The review card then shows the criterion as corrected from screen, with what it said before.

A task that says to bring the team's tests in: one draft per test, its criteria the test's outcomes,
tagged `test:<path of the test file>` (and `screen:<key>` when the task asks): the scenario points at the
test and its code stays in the repository.

A task that names a scenario and a person's feedback is a revision: `get_scenario(id)`, make that
change with `revise_scenario(id, ..., reason=<the feedback>)`, then finish.

## 3. Finish

`end_session(summary)`. On the task: the drafts by category with one
line each, what you sharpened, and the coverage gaps — what you did not cover and why, one line
each. Then `/orcha-done` with that summary. A person approves the drafts in the QA tab.

## The device

Never claim the device lock by hand (no `mkdir /tmp/claude-sim-lock-…`): `start_session` does it. If it answers `waiting:`, the device is busy: that is no failure. Sleep, then call it again with the same arguments.
