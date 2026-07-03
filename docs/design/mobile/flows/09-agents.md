# Flow 09 — Agents (list · detail · controls)

Mockups: [`../mockups/09-agents.html`](../mockups/09-agents.html)

> Covers the **Agents tab** (S13), **Agent detail** (S14) and **Agent controls** (S15) from
> [doc 02](../02-ia-navigation.md). Conversation (Converse) is **flow 10**; the run-log screen with
> its streaming behavior is **flow 06** — this spec only defines the entry points into both.
> Everything here runs against endpoints that exist in `/openapi.json` today — no new API asks.

## 1. Story

Agents are the heart of Orcha — the user opens this tab to answer "who is doing what right now?"
The list is a roster: every AI agent as a card with live status, the working ones pulsing with
their current task named, humans in their own small section below. Tapping an agent gives the
full picture the portal gives today — what they're doing now, who they are (persona), what they've
asked and been asked, their recent worker runs — plus the human-authority controls: change their
model, tune auto-wake, start a conversation, or retire them.

## 2. Portal parity — what the portal Agents page shows today (and where it lands on mobile)

Ground truth: `orcha-cli/orcha_cli/templates/portal/static/agents.html` + the shared renderers in
`app.js`. The mobile agent detail must cover **all** of this:

| # | Portal element | Portal source | Mobile treatment |
|---|---|---|---|
| 1 | Roster: avatar, name, role, status glyph, embodiment-lease badge (`live` terminal / `in convo` / `task`) | roster + `leaseOf()` | Agents list cards; the lease badge folds into the status pill + current-task line (a pulsing `working` pill with a task named *is* the lease made legible) |
| 2 | Detail header: avatar, alias, kind badge (AI/Human), role, status pill, model, last active, origin, agent id | `renderDetailMain()` header card | Detail header block (big avatar, name, role, status pill, `.tag.model` chip, heartbeat ago). Agent id + origin live under the overflow → "Details" |
| 3 | Gate callout: plan awaiting approval / decided note / task needs verification | `gateCallout()` | Attention banner at top of detail, deep-links to the task's approval/verify sheet (flow 08) |
| 4 | Conversation panel (presence, markdown turns, attachments, slash commands, "Pair in terminal") | `conversation.js` | **Converse** primary button → flow 10. The embedded *terminal* is desktop-only — out of scope for mobile v1 (noted in doc 13) |
| 5 | Persona preview + lazy "Expand full prompt" | `personaExpandBlock()` + `GET /persona` | Collapsible **Persona** section; collapsed = 2-line preview from the snapshot, expand fetches the full system prompt |
| 6 | Controls (human-only): provider + model segmented controls, wake-enabled badge, auto-wake presets | model/awake segs | **Controls** rows: Model row → picker sheet; Auto-wake toggle + cadence; Wake (daemon) shown as a read-only badge, matching the portal |
| 7 | Current task card + all-tasks chips | `agentTasks()` | **Now** section (current task + current run) + "All tasks →" link into the Tasks tab pre-filtered to this agent |
| 8 | Memory digest (current focus, decisions, learnings, open threads) | `digestBlock()` + `GET /api/agents/{aid}/digest` | Collapsible **Memory** section below Persona, same lazy fetch |
| 9 | Incoming / outgoing requests (capped lists, load-more) | `reqIn()/reqOut()` | **Requests** summary rows (open/answered counts + newest payload preview), tapping opens the Requests tab filtered to this agent |
| 10 | Worker runs live feed (status, wake kind, stop-run, diff, streaming log) | `renderRuns()` + `runCard()` | **Recent runs** list (status, wake kind, started/ended); tap → run-log screen (flow 06, incl. stop-run + streaming) |

Mobile adds two things the portal doesn't have: a **Retire** action (the API exists; the portal has
no affordance for it) and per-agent **token/turn usage** sourced from the container token-usage
endpoint.

## 3. Screens & states (mockup frames)

| Frame | Screen | Notes |
|---|---|---|
| A1 | Agents list (Android · dark) | Agents tab active. AI cards: Dana `working` (pulsing pill + current task), CodeCleanupAgent `waiting`, Ethan `needs human`, Code Reviewer `blocked`, Andrew `idle`. Humans section with kedar |
| I1 | Agents list (iOS · light) | Same anatomy, large title, iOS tab bar. Proves the light theme |
| A4 | List loading skeleton | Shimmer cards while the first snapshot loads; tab bar stays interactive |
| I2 | Agent detail — working (iOS · dark) | Dana working on "Mobile app design (GH #30)": header, Converse primary, **Now** (task + live run), Controls rows, Persona/Requests/Runs/Usage below |
| A2 | Model picker (Android · dark) | Modal bottom sheet; radio list grouped by runtime (Claude/Codex), current model marked, confirm button enables only on change |
| A3 | Agent detail — terminated (Android · light) | Grayed header, `s-danger` pill, danger banner, Converse + all controls disabled |
| I3 | Retire confirm (iOS · dark) | Destructive `confirmationDialog` — step 2 of the double confirm (step 1 is the overflow menu item) |

States that are spec'd but share layouts with other flows (no dedicated frame):

- **Detail load error** — the header always renders (it comes from the snapshot already in hand);
  each lazily-fetched section (persona, requests, runs, usage) that fails shows an inline
  "Couldn't load — Retry" row instead of its content. A full-screen error only if the snapshot
  itself is gone (then it's the container-unreachable state, flow 04).
- **Unreachable banner** — when the container drops to `polling`/`unreachable`, the standard
  connectivity banner (flow 04) pins under the app bar; all mutating controls (model, auto-wake,
  retire, Converse send) disable with the banner as the explanation.
- **Model-change failure** — snackbar (Android) / toast banner (iOS): "Couldn't change model
  (500) · Retry". The row reverts to the previous model — optimistic UI, reconciled exactly like
  the portal does.
- **Auto-wake change failure** — same snackbar/toast pattern; toggle snaps back.
- **Empty roster** — state layout: "No agents yet — create agents from the portal's onboarding."

## 4. Behavior

### Agents list (tab root)

- **Data:** the agents slice of `GET /api/snapshot/{cid}`; `SSE /api/containers/{cid}/events`
  flips statuses live (a card's pill can go `idle → working` without a refetch). Pull-to-refresh
  forces a snapshot refetch.
- **Card anatomy (AI):** square `.avatar` with initial · name (`titleSm`) · role line (one line,
  ellipsis) · status pill right-aligned (`pulse` class only when `working`) · when working, a
  current-task line ("▸ *task title*") under the role · meta row with `.tag.model` mono chip +
  last-heartbeat ago ("2m ago", from `last_active`, re-rendered each minute).
- **Sort:** working first, then awaiting_human / blocked / awaiting_request, then idle;
  terminated agents sink to the bottom, grayed. Stable within groups (registration order).
- **Humans:** separate "Humans" section below the AI roster — round `.avatar.human`, name, role
  line ("Human authority"), a `you` tag on the paired human. No status pill, no detail
  controls — tapping a human opens a reduced detail (header + requests summary only).
- **Tap:** pushes Agent detail on the tab's stack. Deep link: `orcha://container/{cid}/agents/{aid}`.

### Agent detail

Ordered top → bottom (single scroll):

1. **Attention banner** (conditional): gate callout parity — "Plan awaiting your approval" /
   "Task awaiting verification" for any task owned by this agent, deep-linking to flow 08.
2. **Header:** `.avatar.lg`, name, role, status pill (pulsing when working), `.tag.model` chip,
   heartbeat ago. Overflow (ellipsis / ⋮) menu: Rename (`PATCH /api/agents/{aid}`), Details
   (agent id, origin, kind), **Retire** (destructive, at the bottom).
3. **Converse** — full-width primary button, the one promoted action → flow 10.
4. **Now** — only when there is something live: the current task row (title + status pill,
   tap → Task detail) and the current run row (wake kind + "streaming" live dot + elapsed,
   tap → run log, flow 06). Sourced from the snapshot (current task) +
   `GET /api/agents/{aid}/runs` / `/resident-runs` (whichever holds the `running` entry).
   When idle: the section collapses to "Nothing running · All tasks →".
5. **Controls** (human-only — the phone always acts as the paired human, so always enabled while
   reachable): **Model** row (current model, tap → picker sheet, frame A2); **Auto-wake** row
   (toggle + cadence label, e.g. "Every 15m"; the scheduled next-wake time renders as a sub-label
   when on; tapping the row opens a cadence picker — Off / 5m / 15m / 1h presets, plus the live
   non-preset value as an extra chip, exactly like the portal); **Wake (daemon)** read-only badge
   (`wake_enabled`).
6. **Persona** — collapsible; collapsed shows the snapshot's `prompt_preview` (2 lines).
   Expanding fetches `GET /api/agents/{aid}/persona` once (cached per agent) and renders the full
   `system_prompt` in mono, matching the portal.
7. **Memory** — collapsible digest (current focus highlighted, then decisions / learnings / open
   threads, capped with "Show more").
8. **Requests** — two summary rows: *Incoming* (open count + newest payload preview) and
   *Outgoing* (open/answered counts), from `GET /api/agents/{aid}/inbox` and `/outbox`.
   Tap → Requests tab pre-filtered to this agent.
9. **Recent runs** — last 5 runs merged from `/runs` + `/resident-runs`, newest first: status
   word (running/finished/failed/killed), wake kind tag (`headless` / `resident` / `live tab`),
   started → ended clock times. Tap → run log (flow 06 — streaming, auto-scroll, stop-run all
   spec'd there). "All runs →" when more exist.
10. **Usage** — token + turn stat tiles from `GET /api/containers/{cid}/token-usage`, filtered to
    this agent. Rendered only if the endpoint answers and has rows for the agent (graceful absence
    — the section simply doesn't exist otherwise).

### Model change (frame A2)

- Picker lists `GET /api/models` grouped by runtime (Claude / Codex), friendly name + mono id per
  row, radio selection, current model pre-selected and tagged "current".
- Confirm-on-change: the primary button stays disabled until a *different* model is selected, then
  reads "Change to *{name}*". On tap → `POST /api/agents/{aid}/model {model}` (curated ids only,
  as the portal enforces). Success: sheet dismisses, snackbar/toast "Model → *{name}*", the header
  chip updates. Failure: sheet stays open, error snackbar/toast, selection preserved for retry.
- The change applies at the agent's **next wake** — the sheet's sub-line says so, so a user
  watching a live run isn't confused when nothing visibly changes.

### Auto-wake

- `PATCH /api/agents/{aid}/auto-wake {actor_agent_id, interval_secs}` — `null` = off. Optimistic
  toggle, revert + snackbar/toast on failure (portal parity). Backend floor is 60s; presets only.

### Retire (double confirm)

- Entry is deliberately buried: overflow menu → "Retire agent…" (destructive tint) — never a
  visible button on the detail. Step 2 is the platform destructive confirm (frame I3): framed as
  **"Retire Dana — they stop waking."** with the consequence copy: tasks stay assigned, history
  stays visible, this can't be undone from the app.
- Confirm → `POST /api/agents/{aid}/retire`. Success: pop back to the list, where the agent now
  renders terminated. Failure: error snackbar/toast, nothing changes.

### Terminated treatment (frame A3)

- List: card grayed (55% opacity on avatar/name/role), `s-danger` `terminated` pill, no
  current-task line, sorted to the bottom.
- Detail: danger banner ("Retired *3d ago* — this agent no longer wakes."), header grayed,
  Converse disabled, every control row disabled (model/auto-wake rows non-interactive, retire
  absent from the overflow). History sections (persona, memory, requests, runs, usage) stay
  readable — retirement freezes the agent, it doesn't erase them.

## 5. Platform notes

- **Android:** list is the Agents destination of the M3 navigation bar; detail pushes with
  predictive back. Model + cadence pickers are **modal bottom sheets** (drag handle, radio rows).
  Retire confirm is an **M3 AlertDialog** (destructive confirm per doc 02), *not* a sheet.
  Failures use **snackbars**. No FAB on this tab.
- **iOS:** list under a large-title `NavigationStack` inside the tab; detail pushes with
  swipe-back. Model picker is a **sheet with a medium/large detent**; retire confirm is a
  **confirmationDialog** (action sheet) with a destructive role button. Failures use the top
  **toast banner**. Overflow is the trailing ellipsis Menu.
- Both: card anatomy, pill colors, section order are pixel-equivalent (doc 02 §3).

## 6. Status → pill mapping (binding, from doc 01)

| Agent status | Pill class | Word |
|---|---|---|
| idle | `s-idle` | idle |
| working | `s-accent` + `pulse` | working |
| blocked | `s-warn` | blocked |
| awaiting_request | `s-info` | waiting |
| awaiting_human | `s-violet` | needs human |
| terminated | `s-danger` | terminated |

## 7. Endpoints used

| Action | Endpoint | Status |
|---|---|---|
| List + detail header (status, model, current task, heartbeat) | `GET /api/snapshot/{cid}` (agents slice) | exists |
| Live status flips | `SSE GET /api/containers/{cid}/events` | exists |
| Persona / charter (full system prompt) | `GET /api/agents/{aid}/persona` | exists |
| Memory digest | `GET /api/agents/{aid}/digest` | exists (portal parity) |
| Request summaries | `GET /api/agents/{aid}/inbox` · `GET /api/agents/{aid}/outbox` | exists |
| Runs (headless + resident) | `GET /api/agents/{aid}/runs` · `GET /api/agents/{aid}/resident-runs` | exists |
| Run log stream (flow 06) | `SSE GET /api/agents/{aid}/runs/{run_id}/stream` | exists |
| Model picker options | `GET /api/models` | exists |
| Change model | `POST /api/agents/{aid}/model` `{model}` | exists |
| Auto-wake toggle / cadence | `PATCH /api/agents/{aid}/auto-wake` | exists |
| Rename / edits | `PATCH /api/agents/{aid}` | exists |
| Retire | `POST /api/agents/{aid}/retire` | exists |
| Token/turn usage | `GET /api/containers/{cid}/token-usage` | exists (optional section) |
