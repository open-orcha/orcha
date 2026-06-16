# Orcha Portal — Design Brief for Claude (v1)

> Paste this whole document to Claude (with Design/Artifacts). Goal: **hi-fi, production-leaning
> HTML/CSS mockups** of the Orcha portal that we can lift into a static-HTML + vanilla-JS frontend.
> Scope is **v1 only** — ignore anything marked post-v1/deferred.

---

## 0. Your job
You are designing the operator console for **Orcha**. Produce **hi-fi HTML/CSS mockups** (self-contained
files, one per screen, sharing a common stylesheet) for the screens in §5. Aesthetic: a **dense, fast-scan
operational dashboard** (think Linear / Vercel dashboard / Datadog — not a marketing site). Full **light +
dark theming** via CSS custom properties. Honor the **Quantal Labs / Orcha brand** in §7 (assets provided
there; a greenfield fallback is given if they're blank). Ask me anything ambiguous before diving in.

## 1. What Orcha is (the mental model — design to this)
Orcha is a **human-authoritative, multi-agent orchestration platform**. A human operator runs a team of
**agents** (each agent is a Claude session) that collaborate on **tasks** and exchange **requests**, all
coordinated through a shared database that acts as the message bus. The human is always in command: agents
**never self-certify** — their work stops at `needs_verification` and a human approves it.

Two ideas the UI must make legible:
- **Episodic agents.** An agent isn't a long-running process. It is woken on demand as a short-lived
  headless worker; each wake is a fresh process that rehydrates from a **memory digest** + DB state. So
  "one agent" = many discrete **runs** over time. The UI shows the *continuity* (who the agent is, where it
  left off) and the *episodes* (individual runs, with live output + diffs).
- **Async human-authority gates.** Instead of synchronous "allow this tool?" prompts, the human governs
  through deliberate, async decisions: **approve/reject a plan**, **verify** a finished task, answer/close a
  request. These gates are the product's spine — they deserve a first-class, unmissable surface.

## 2. Who uses it
- **The operator (primary).** A technical person watching several agents at once: dispatching work,
  watching progress live, approving plans, verifying results, unblocking. Wants density, fast scanning, and
  a clear "what needs *me* right now" queue. Will keep the portal open for hours.
- **Agents are also represented as users.** Humans and AI are **both first-class agents** (a human teammate
  is an agent too). The UI must distinguish human vs AI agents clearly but treat both as participants.

## 3. Core objects & states (the vocabulary the UI renders)
Design real components for each. These are the live entities:

- **Agent** — `alias`, `role`, system prompt/persona, `kind` (human | ai), **status** (idle · working ·
  needs_verification · blocked), **model** (Opus 4.8 / Sonnet 4.6 / Haiku 4.5), **wake-enabled** flag,
  current task, **memory digest** ("where you left off": focus, recent decisions, open threads), and its
  history of **runs**.
- **Task** — `title`, `description`, `definition_of_done`, **status** (ready · in_progress/working ·
  needs_verification · completed · blocked · cancelled), `priority`, **assignee** (an agent), a **thread**
  of messages, an optional **plan-approval card** (the agent's proposed plan awaiting human approve/reject),
  and **runs** (with code **diffs**).
- **Request** (agent → agent) — `type` (info | task), `priority`, **status** (open · answered · closed),
  a `payload`, optional **chain link** (`in_service_of` another request), and actions: **answer**, **close**,
  **escalate to human**, **convert to task**.
- **Decision** (the human-authority record) — subject (a plan / a task / a request), **verdict**
  (approve | reject), and a **reason that is REQUIRED on reject**.
- **Run** (one wake/episode of an agent) — **status** (running · exited · killed · timeout_killed),
  `started/ended`, duration, a **live output stream**, and a **git diff** of what it changed.
- **Live event stream** — a run's output, streamed line-by-line (sub-second) and **classified into ~9
  types**: boot/lifecycle · agent narration · thinking · tool call · tool result · sub-agent · decision/
  approval · error/rate-limit · run-complete. Each type gets its own visual treatment; the stream is
  collapsible by section.

## 4. Job-to-be-done & design principles
1. **"What needs me right now?" is the hero.** Pending approvals + tasks at `needs_verification` form the
   operator's action queue — it must be impossible to miss from anywhere.
2. **Everything is cross-linked — no dead-ends.** From a task you reach its agent, its runs, its requests;
   from an agent you reach its tasks and requests; from a request you reach both agents and any spawned
   task. Bidirectional deeplinks everywhere.
3. **Status is everywhere, accurate, and never color-only.** A status pill (text + icon + color) on every
   agent and task, in lists and detail. Status must be derivable at a glance and must not lie (an agent
   that is working must never read "idle").
4. **Watch work happen.** Live run output streams in real time; lists auto-refresh **without losing scroll
   position or collapsing open sections**.
5. **Approval/verify is deliberate, with full context.** When approving a plan or verifying a task, the
   human sees the plan, the DoD, and the diff together; rejecting requires a reason.
6. **Dense but calm.** High information density, but strong hierarchy and whitespace discipline so it scans
   without feeling noisy.

## 5. Screens & requirements (v1)

### 5.1 Dashboard / Home — the control room
- Top: a **"Needs your attention" action queue** — plans awaiting approval + tasks at needs_verification,
  each one click from acting.
- **Agents at a glance**: every agent with status pill, current task, model, wake-enabled, human/AI badge.
- **Tasks by status**: grouped (needs_verification → working → ready → done), counts, quick filters.
- **Live activity**: a real-time strip of what agents are doing right now (latest run events), linking into
  the full live feed.

### 5.2 Agents — list + detail (an *activity hub*)
- **List**: status pill, role, current task, model, wake-enabled, human vs AI, last-active. Sort/filter by
  status. Click → detail.
- **Detail**: persona/role + system prompt; **current task**; **memory digest** ("where it left off");
  **run history** (each run: status, duration, diff summary, link to its live/recorded stream); **requests
  in/out**; **model + wake controls**. This page is where you **watch all activity related to one agent**.
- Fixes to honor: agent **status must be root-caused correctly** (no false "idle" while working), and the
  **approval/verify surfacing must be decoupled from status** (a pending approval shows regardless of the
  agent's status field).

### 5.3 Tasks — list + detail/thread (an *activity hub*)
- **List**: **ordered by status first** (needs_verification → working → ready), **then by time**; a
  **prominent status pill** per row; assignee (with deeplink to the agent); priority. 
- **Detail**: the **message thread**; the **plan-approval card** — **fully readable/scrollable, never a
  dead-end** (always offers approve/reject inline, with required reason on reject); the **DoD**; **runs +
  diffs**; verify action inline. Watch all activity related to one task here.

### 5.4 Requests — list + detail (an *activity hub*)
- Agent→agent **info/task** requests. Show **status** (open/answered/closed), priority, both parties
  (deeplinked to agents), the payload, and **request chains** (`in_service_of` threading).
- Actions: answer, close, **escalate to human**, **convert to task**. Watch all activity related to a
  request (and its chain) here.

### 5.5 Plan-approval & Verify — the human-authority surface
- A focused surface to **approve/reject plans** and **verify needs_verification tasks**.
- Show full context together: the **plan**, the **DoD**, the **diff**. **Reject requires a typed reason**
  (enforced in the UI). Make the act feel deliberate and safe — this is where the human exercises authority.

### 5.6 Live run feed (SSE) — "watch your agent work"
- A run's output **streams line-by-line, sub-second**, classified into the ~9 types (§3), each visually
  distinct, **collapsible by section**. Sections **stay open across refreshes**; switching views cleanly
  tears down the stream. Show run status (running/exited/killed), elapsed time, and the resulting diff when
  it ends. This is the marquee moment — make it feel alive.

### 5.7 Create / register agent (terminal-free)
- A form to create an agent from the portal: alias, role, system prompt, **model**, **wake settings**, and
  an optional **initial task**. The goal is a fully terminal-free workflow.

## 6. Cross-cutting UX requirements (hard-won — please bake in)
- Bidirectional deeplinks: task ↔ agent, request ↔ agent, task ↔ request. Nothing is a dead-end.
- Status pills: consistent component, text+icon+color, used identically in lists and detail.
- Real-time everywhere: live feed via stream; lists poll/refresh **without losing scroll or collapsing
  open sections**.
- The human's **action queue** (approvals + verifications) is reachable from every screen (e.g. a persistent
  header badge with a count).
- Humans-as-agents are first-class: design the human/AI distinction (badge, maybe avatar treatment) without
  second-classing either.
- Empty / loading / error / streaming states for every component.
- Accessibility: contrast in both themes, status never by color alone, keyboard navigable, focus states.

## 7. Visual direction, theme & brand
- **Aesthetic:** dense operational dashboard — Linear / Vercel dashboard / Datadog energy. Compact rows,
  tabular data, status pills, monospace for IDs/diffs/log streams, restrained accent color used for state +
  primary actions only.
- **Theming:** ship **both light and dark** as first-class, driven entirely by **CSS custom properties**
  (a token layer: bg/surface/border/text/muted + semantic state colors success/warn/danger/info + an accent).
  A single `data-theme` switch flips everything.
- **Brand — honor Quantal Labs / Orcha:**
  ```
  [FILL IN — paste the Orcha/Quantal brand here, or leave blank for the greenfield fallback below]
  - Logo / wordmark: …
  - Primary palette (hex): …
  - Accent(s): …
  - Typeface(s): …
  - Tone words: …
  ```
  **Greenfield fallback (if the block above is blank):** a confident, technical identity — near-black
  dark theme (not pure #000), a single vivid accent (electric blue or violet) reserved for primary action +
  "working" state; semantic states green/amber/red/blue; a clean grotesk UI typeface (e.g. Inter) + a
  monospace (e.g. JetBrains Mono) for IDs/diffs/streams; the name "Orcha" set with quiet confidence.

## 8. Technical constraints & output format
- **Output:** hi-fi **HTML + CSS** mockups, **vanilla** — no React/Vue/Tailwind/build step. The real portal
  is **static HTML + vanilla JS hitting a FastAPI backend** and lives as `home.html`, `agents.html`,
  `tasks.html`, `requests.html` (+ detail views). Design so these can be **lifted directly** into that
  structure.
- One **shared stylesheet** (tokens + components: pills, cards, tables, buttons, modals, the log-stream
  block, nav/header with the action-queue badge). Then one HTML file per screen using it.
- Use realistic **placeholder data** (several agents incl. one human; tasks across every status; an
  open + an answered request with a chain; a run mid-stream with mixed event types; a plan awaiting
  approval; a diff). Realistic content sells the density.
- Keep it framework-free and self-contained so each file renders standalone in a browser.

## 9. Deliverables
1. `styles.css` — the token + component system, both themes, with a theme toggle.
2. `home.html` — dashboard / action queue.
3. `agents.html` — agents list **and** an agent-detail layout (activity hub).
4. `tasks.html` — tasks list **and** task-detail/thread with the plan-approval card (activity hub).
5. `requests.html` — requests list + detail with chains (activity hub).
6. `run.html` — the live SSE run feed (the 9-type classified stream).
7. `approve.html` (or a modal pattern) — plan-approval & verify with required-reason-on-reject.
8. `new-agent.html` — create/register-agent form.
9. A short notes section: the design rationale, the token list, and how the pieces compose.

Start by confirming the brand block in §7 (or that you should use the fallback), then propose the token
system + the dashboard, and iterate from there.
