# Orcha Portal — Complete UI Inventory & Redesign Prompt

> **Purpose of this document:** This is a self-contained brief for a design agent. It inventories
> **every screen** in the Orcha orchestration portal, then specifies each screen's layout, every
> feature, every UI state, and every interaction in enough detail that you can redraw the entire
> product without access to the codebase. Your job: **review the current UI described here and
> generate new, modernized mockup screens for all of them** — same information architecture and
> feature set, dramatically better visual design.
>
> Source of truth: the `main` branch of the Orcha repo (portal at
> `orcha-cli/orcha_cli/templates/portal/` — FastAPI backend + vanilla HTML/CSS/JS, no build step,
> one shared `styles.css`).

---

## 1. What Orcha is (product context)

Orcha is a **human-authoritative multi-agent orchestration portal**. A human operator runs a
workspace ("container") staffed with AI agents (Claude Code or Codex CLI workers). Agents wake as
fresh headless workers, do tasks, stream their work, and **stop at gates**: the human approves
plans, verifies completed work, and answers escalations. The product's governing line, shown in
the UI: **"Nothing ships on an agent's say-so."**

Core vocabulary the UI uses everywhere:

- **Agent** — an AI teammate (alias, role, system prompt/persona, model) or a registered human.
- **Task** — unit of work with a title, description, **definition of done**, priority (lower
  number = more urgent, shown as `P40` chips), assignee, dependencies, status.
- **Request** — an inter-party message needing an answer/decision (agent→agent question,
  agent→human **escalation**, or a **task request**). Can be answered, escalated, converted to a
  task, or closed.
- **Worker run** — one wake of an agent: a live-streaming classified log (9 event types), an
  optional unified code diff, a status (running/exited/killed).
- **Acting human** — the registered human identity (picked top-right) required to perform any
  write action. Everything is "logged to the audit trail."
- **Autonomy** — a container-level dial: **Running/Paused** kill-switch + level
  **Plan-only → Build to PR → Full**.

---

## 2. Complete screen inventory

Six routed screens plus rich client-side sub-views. "Run feed" in the sidebar is a link to
`/agents` (not its own route).

| # | Screen | Route | Major sub-views / overlays |
|---|--------|-------|----------------------------|
| 1 | **Dashboard** | `/` | Workspace context bar · first-run CTA · "Needs your attention" action queue (plan/verify/escalation cards) · Agents-at-a-glance table · Live activity feed · Tasks-by-status kanban strip |
| 2 | **Agents** | `/agents` (`?agent=<alias>`) | Roster panel · Conversation (chat) panel · Live terminal pairing (xterm, dockable + maximizable) · Gate callouts · Persona card · Controls card · Current task + Memory digest · Incoming/Outgoing requests · Worker runs feed · Human-agent variant |
| 3 | **Tasks** | `/tasks` (`?task=<id>`) | Grouped task list · New-task modal · Task detail (header, plan/verify gate, protocol panel, thread + composer with attachments, assignment card, close card) · Runs & diffs (live log + unified diff viewer) |
| 4 | **Requests** | `/requests` (`?req=<id>`) | Filterable request list · Request detail (flow header, chain view, payload/answer/rejection, "Your move" actions) · Answer composer · Convert-to-task modal · Escalate/Close modals |
| 5 | **Settings** | `/settings` | Anthropic API key card (save/test/remove, env-override state) · Universal model selection (per-use-case provider+model pickers) |
| 6 | **Onboarding** | `/onboarding` (`?new=1`, `?step=create-agent`) | Welcome/operator registration · Path fork (AI-proposed vs manual) · AI roster proposal (streaming "thinking", clarify questions, editable roster review) · Create-agent form · Agent-created success · Create-tasks queue |

**Shared overlays across all screens:** modal dialog, toast, notification center dropdown,
pause banner, attachment lightbox.

---

## 3. Current design system (the baseline you're modernizing)

### 3.1 Theming
- Single `data-theme` attribute on `<html>`: `auto | dark | light` (localStorage `orcha:theme`).
  Dark is the default palette; light overrides. The theme toggle (topbar) flips dark↔light.
- **Fonts:** Inter (UI, weights 400–800) + JetBrains Mono (code, diffs, logs, model tags, IDs).
  Base 14px.

### 3.2 Color tokens (dark / light)
- Background `#0a0d12` / `#f3f6fa`, with faint teal + violet radial glows.
- Surfaces: `--surface #111620/#fff`, `--surface-2 #161d29/#f5f8fc`, `--surface-3 #1c2532/#eef3f9`.
- Borders `#232d3d/#e4eaf2`; text `#e8edf6/#0e1722`; muted `#8b98ae/#5a6678`.
- **Brand accent: teal `#1fc7cd` / `#0c9aa0`** — primary actions, focus, links, live/working
  pulses. Never decorative fills.
- **Maker accent: amber `#f2a83c`** — reserved for the Quantal Labs footer mark and the
  human identity (human avatar ring, human kind badge, human chat bubbles).
- Semantic set (each with fg / soft-bg / border variants): `--ok` green `#38d39a` (success/done),
  `--info` blue `#5aa6ff` (ready/info/Build-to-PR), `--warn` amber `#f5b13d` (needs-attention/
  Plan-only/"Needs you"), `--danger` red `#f6757e` (failure/paused/destructive), `--violet`
  `#b08cff` (completed/converted/root/sub-agent), `--idle` gray `#6b788e`.
- Diff colors: add green, del red, hunk blue (fg + tinted line backgrounds).

### 3.3 Component vocabulary (reused on every screen)
- **Buttons:** primary (accent fill), `.ghost`, `.subtle`, `.approve` (green), `.danger` (red),
  `.stop` (danger-soft with square glyph), `.sm` size.
- **Status pills** — glyph + label, one system for agents/tasks/requests:
  Working/In progress (accent, **pulsing dot**), Idle/Pending/Cancelled/Closed (gray),
  Ready/Accepted (blue, play glyph), Blocked/Failed/Terminated/Rejected/Escalated (red, ✕),
  Waiting/Needs human/Open (amber, warning triangle), **Needs verify** (amber),
  Completed (violet, check), Converted (violet), Answered (green).
- **Priority chips** `P<n>`: `P≤20` red, `P≤40` amber, else faint.
- **Kind badges:** `AI` (accent, spark icon) vs `Human` (amber, person icon) — "never
  second-classing either."
- **Avatars:** deterministic gradient from alias + first initial. **AI = squircle (10px radius);
  human = circle with amber double-ring.** Sizes 24/32/48.
- **Cards** (radius 15px, subtle shadow), card headers with title + count + "see all" link.
- **Tables** (dense, uppercase 10.5px headers), **list rows** (hover + `.sel` accent state),
  **kanban cards** (hover lift), **tags** (`root` violet, `model` mono, `wake-on/off`),
  **deep-link chips** (avatar + name), **id pills** (mono + copy button).
- **Empty states:** dashed-border box, centered faint text, optional large emoji/glyph.
- **Live indicator:** pulsing dot + "live" label. **Skeleton shimmer** for loading.
- **Thread bubbles:** avatar + name + relative time + bubble (surface-2; amber-tinted for human;
  dashed transparent for system). Safe inline-markdown rendering (bold/italic/code/blocks/
  tables/headings/bullets), URL linkify, bare task-ids auto-link as `[task name]` chips.
- **Gate surface** (the signature pattern): amber-bordered card with amber gradient, badge
  header, content fields, action row, and a hidden-until-revealed required-reason textarea.
- **Diff viewer:** mono, sticky stat bar (`+adds −dels · unified diff`), colored add/del/hunk
  lines, "No net change (empty diff)." empty state.
- **Run cards + classified live log:** status chip, wake-kind tag, Stop button, mono log with
  9 color-coded event types (lifecycle green, narration, thinking italic-gray, tool-call blue,
  tool-result gray, sub-agent violet, decision amber, error red, complete green), collapsible
  section dividers, new lines animate in.
- **Modals:** 560px, title + desc + body + Cancel/primary footer; Escape/backdrop dismiss.
- **Toasts:** bottom-right, 2.6s, colored left border (accent/ok/danger).
- **Segmented controls:** autonomy switch, Time/Priority sort control (persisted per surface),
  provider/model pickers, first-task mode tabs.

### 3.4 Responsive behavior (current)
- App grid: 246px sidebar + fluid main. **≤940px: sidebar disappears entirely** (no hamburger —
  a known gap). Two-column splits collapse to one. Dashboard grid collapses ≤1080px; kanban
  5→2 columns ≤1180px.

---

## 4. Shared app shell (identical on every screen)

### 4.1 Sidebar (246px, sticky)
1. **Brand:** 38px rounded tile with an orca SVG mark on a dark-teal radial gradient +
   wordmark "**Orcha**" over "orchestration portal" (uppercase micro-label).
2. **Nav — "Control room":** Dashboard · Agents (badge = agent count) · Tasks (badge = count of
   tasks needing verification, amber when >0) · Requests (badge = open requests) · Settings.
   Active item: accent-soft fill + accent border.
3. **Nav — "Live":** Run feed → `/agents`.
4. **"Needs you" attention card** (bottom, warn-tinted): bell + "Needs you", a large count,
   "`N` to verify · `M` escalation(s)", link "**Open action queue →**" → `/#needs`.
5. **Maker footer:** "Developed by" + Quantal Labs logo (ring + amber dot) + "AI" mono pill.

### 4.2 Topbar (sticky, blurred translucent)
Left→right: **page title** + context sub-crumb (e.g. "3 tasks · Harden the payments module") ·
**global search** (placeholder "Search agents, tasks, requests…", `/` shortcut chip, focus
expands width) · **"Needs you" bell pill** with count (opens the notification center dropdown) ·
**autonomy switch** (see below) · **"acting as" identity chip** (human avatar + alias, or
"no human registered") · **theme toggle** (sun/moon).

### 4.3 Autonomy switch (the most important global control)
A 4-segment pill, lowest→highest authority:
- **Rung 0 — Running/Paused** (binary kill-switch): green "Running" or red pulsing "Paused".
  Clicking toggles via confirm modals: "Pause autonomy?" ("All agents stop waking immediately.
  In-flight work finishes; nothing new starts. Humans & live terminals still work." — danger
  primary "Pause all wakes") / "Resume autonomy?".
- **Rungs 1–3 — level:** **Plan-only** (warn) · **Build to PR** (info) · **Full** (accent). Each
  change confirms with impact copy (Plan-only: "Agents resume and propose plans, but you approve
  every plan before any execution." · Build to PR: "Agents execute approved plans up to an open
  PR. You still merge." · Full: "Agents may carry approved work to completion without further
  gates." — danger-styled primary).
- Requires an acting human (locked + warn toast otherwise). When paused, a **danger banner**
  appears under the topbar: "⏸ Autonomy paused — no agent wakes. Humans & live terminals still
  work." with a "Resume ↩" pill; the topbar gets a red top border.

### 4.4 Notification center (bell-pill dropdown)
Panel with header "Notifications" + "Mark all read". Two zones:
- **NEEDS YOU (N)** — live from the snapshot: Plan approval rows (shield, warn), Verify task rows
  (check, warn), Escalation rows (flag, danger, "{from} → you"). Empty: "✓ You're all caught up."
- **Earlier** — the acting human's paginated informational feed (task verified/assigned/ready/
  update, request answered/closed, decision made). Unread rows get an accent left border.
  "… Load earlier" pagination. The badge count reflects NEEDS YOU only.

### 4.5 Global behaviors
- **Live data:** 3-second snapshot poll + SSE push for sub-second escalation updates. Repaints
  preserve scroll, text selection, and focused inputs (never clobber typing).
- Every write requires the **acting human**; missing → toast "Pick an acting human (top-right)
  first." Success/failure always toasts.

---

## 5. Screen: Dashboard (`/`)

**Purpose:** command-center triage. Answers: what needs me now, what are agents doing, what just
happened, where do tasks stand.

**Layout:** single column of sections; the middle region is a 2-col grid (fluid main + 372px
right rail; collapses ≤1080px).

### 5.1 Workspace context bar
Horizontal card: status pill ("active" displays as **Working**) · workspace name + description ·
stat cells separated by hairlines: **AGENTS** count, **TASKS** count, **OPEN REQ** count,
**AUTONOMY** ("Running" green / "Paused" red).

### 5.2 First-run CTA (only when zero AI agents exist)
Accent-gradient banner: spark icon tile, "**Get started — set up your workspace**", "No AI
agents yet. Create your first agent (or capture tasks) in the guided first-run flow.", button
"Get started" → `/onboarding`.

### 5.3 "Needs your attention" — the action queue
Header: title + amber count badge + subtitle "Plans to approve and tasks to verify — one click
from acting. Nothing ships on an agent's say-so."
Responsive card grid (min 330px). Three card types, each with a **3px colored left spine**:

- **Plan approval** (amber spine, shield): task title · author agent link + model tag ·
  scrollable panel "Proposed plan — full text" (complete plan, linkified) · actions
  **Approve plan** (green) / **Reject…** (red) / **Open task** (ghost).
- **Verify task** (orange spine, check): task title · assignee + model + relative time · panel
  "**Definition of done**" · actions **Accept** / **Reject…** / **Open task**.
- **Escalation** (red spine, flag): request payload (96 chars) · "{agent} → you" + time · panel
  "Blocks: {linked task}" · actions **Resolve** / **Open request** (both link to `/requests`).

Autonomy gating: plan cards only at Plan-only level; verify cards hidden at Full; escalations
always shown. Approve/Reject open confirm modals (approve = optional guidance textarea; reject =
**required** reason, "A reason is required to reject."). Acted-on cards optimistically disappear.
Empty state: "✓ Nothing needs you right now."

### 5.4 Agents at a glance (left card)
Header: "Agents at a glance (N)" + links "+ New agent" (→ `/onboarding?new=1`) and "All agents ↗".
Table columns **Agent | Status | Activity | Model | Wake | Active**. Row: avatar + alias + role ·
status pill · live activity (task title, or an italic wake-event label like "In conversation" /
"Auto-wake check" / "Checking in", else "—") · model tag · wake `on`/`off` tag (— for humans) ·
relative last-active. Whole row clicks through to the agent.

### 5.5 Live activity (right rail, sticky)
Header "Live activity" + pulsing "live". Up to 14 newest events synthesized from task posts and
requests. Row: actor avatar + name + type chip (**post** neutral / **decision** amber /
**request** blue / **answer** green) + relative time + truncated body; row links to the source
task/request. Empty: "No activity yet."

### 5.6 Tasks by status (kanban strip)
Section header + "Open tasks ↗". Five fixed columns: **Needs verify / In progress / Ready /
Blocked / Done**, each with status glyph, label, count chip. Cards: title + assignee avatar/alias
(or "unassigned") + priority chip; click → task. Empty column: "None".

---

## 6. Screen: Agents (`/agents?agent=<alias>`)

**Purpose:** roster + full detail for one selected agent: chat, live terminal, persona, controls,
memory, tasks, requests, run feed.

**Layout:** sticky left roster (360px, independently scrollable) + right detail column with three
stacked regions (conversation / detail cards / worker runs) — the conversation and runs live
outside the 3s repaint so typing and live streams survive.

### 6.1 Roster panel
Header "Roster · N" + "+ New" (→ `/onboarding?new=1`). Rows: avatar (AI squircle / human circle),
alias, role (2-line clamp), status glyph, and — when the agent holds its embodiment lease — a
pulsing **lease badge**: teal `live` ("In a live terminal…"), violet `in convo`, amber `task`.
Selected row: accent-soft + accent border.

### 6.2 Conversation card (AI agents only; top of detail column)
- **Header:** avatar + name/role · **presence chip** (working pulsing-accent / replied green /
  waking-waiting amber / busy amber / offline faint / idle) · **"Pair in terminal"** button
  (becomes solid "Terminal paired") · **maximize** button (full-viewport overlay, Esc restores).
- **Message list** (460px, scrolls; "Load earlier · X of Y" reveals older turns): human turns
  right-aligned amber bubbles ("you"), agent turns left with avatar; markdown rendering;
  image attachments as zoomable thumbnails (full-screen lightbox) and file download chips; agent
  turns tagged with a run get a collapsible "work log · <id>" that live-streams the worker log.
  **Permission-request cards** (shield header + tool name + pretty-printed input) and
  **ask-human cards** render read-only with the note "Allow / deny lands with E4."
- **Pending-reply indicator:** three blinking "thinking…" dots (working/waking), or an amber
  "queued" notice when the agent is busy ("<name> is busy with another task — your message is
  queued…").
- **Lock banner** when a live terminal holds the agent: "<alias> is in a live terminal —
  conversation paused." — composer dims and disables.
- **Composer:** paperclip attach (png/jpg/gif/webp/pdf/txt/md/csv/log/json; staged chips show
  uploading…/failed/size), autosizing textarea "Message <alias> — type / for skills…" (draft
  persisted per agent), green **Send**. Enter sends, Shift+Enter newline. Typing `/` opens a
  **slash-skills palette** (orcha-status, -task-new, -post, -done, -ask, -inbox, -respond,
  -escalate, -convert, …) with keyboard navigation.
- **Helper caption:** "Turn-based: <alias> wakes, works, and replies. Live token streaming +
  Stop + permission cards arrive with E4." (Replies arrive as whole turns on a 3s poll.)

### 6.3 Terminal pairing (docks beside the chat; 2-col ≤ becomes 1-col <1180px)
Pairing an idle agent opens directly; a resident/ephemeral lease first confirms
("Hand off the live conversation?" / "Preempt the running task?" — progress is snapshotted).
A preflight probe blocks with an install modal if the CLI is missing ("Claude Code isn't
installed" + copyable hint like `ORCHA_CLAUDE_EXEC=/path`), failing open when the probe is down.
**Terminal panel:** macOS traffic-light dots, mono title "<alias>@orcha — pair session", a status
tag cycling `connecting… / starting bridge… (n/N) / live · paired as <alias> / saving… /
handing off… / busy / denied / down`, maximize + close (close = snapshot & release). Dark xterm
body (teal cursor, 5000 scrollback). Rich error overlays with retry CTAs for busy/denied/
not-installed/auth-required/usage-limit/bridge-down. Navigating away detaches without killing
the session; returning re-attaches with scrollback intact.

### 6.4 Detail cards (in order)
1. **Identity:** large avatar, name + AI/Human badge, role, large status pill; meta grid
   **Model / Last active / Origin ("Human-created" or "Human authority") / Agent ID** (mono).
2. **Gate callout** (shown regardless of agent status): "Plan awaiting your approval" →
   "Review plan →"; or decided note ("Plan approved/rejected · by <actor> · <time>"); or
   "**Task awaiting verification**" → "Verify →" (links to the Tasks gate — one authoritative
   approval surface).
3. **Persona** (AI) / **Role** (human): 160-char prompt preview + "Expand full prompt" (lazy
   loads full system prompt in mono).
4. **Controls** (AI only; header notes "human-only"): **Provider** segmented Claude/Codex
   (filters the model list) · **Model** picker grid (posts immediately, toast "Model → <name>") ·
   **Wake** read-only Enabled/Disabled badge · **Auto-wake** presets Off/5m/15m/1h (+honest chip
   for API-set values). Humans instead see "This is you — the human authority. No wake controls."
   *(No pause/archive/delete exists anywhere — a redesign gap to consider.)*
5. **Current task** (collapsible, sorted): in-progress/needs-verify rows with root tag, title,
   DoD preview, status pill; "All tasks · N" chip cloud with load-more. Empty: "No task in
   progress."
6. **Memory digest** (collapsible, "where it left off"): accent **Current focus** highlight +
   grouped **Recent decisions / Learnings / Open threads** (warn bullets), load-more. Empty:
   "No digest yet — this agent hasn't snapshotted." Humans: "Humans don't rehydrate — no digest."
7. **Incoming / Outgoing requests** (two collapsible cards): mini-rows with status pill, type
   tag, from/to, chain-depth tag, relative time, truncated payload, green answer preview.
8. **Worker runs:** header + "● live stream" badge or run count; intro "Each wake is a fresh
   headless worker — classified into 9 event types… <alias> is one continuous agent across all
   of them."; run cards with live tails (see §3.3). Empty: "No worker runs yet."

---

## 7. Screen: Tasks (`/tasks?task=<id>`)

**Purpose:** the task board + the human-authority gates.

**Layout:** sticky left list panel (360px) + scrolling detail column.

### 7.1 Task list panel
- Header: "**Tasks · grouped by status**" (currently wraps awkwardly — fix) + **Time/Priority
  sort control** with ↑/↓ (persisted) + green "**+ New**" button (disabled without acting human).
- **Status groups**, fixed order, empty groups omitted: Needs verification · In progress ·
  Ready · Pending (blocked on deps) · Blocked · Failed · Done · Cancelled (+ catch-all Other).
  Group header = uppercase label + hairline + count.
- **Rows:** status glyph · (violet `root` tag) title · assignee avatar + alias or "unassigned" ·
  right-aligned priority chip. Hover/selected states. Renders top 10 with
  "Load more · 10 of 27".

### 7.2 New-task modal
"New task" / "Created by <alias> (you) and logged to the audit trail." Fields: **Title*** ·
Description · **Definition of done*** · Priority (number, default 100, "Lower = higher
priority") · Assignee (— Unassigned — + AI agents) · **Depends on** multi-select of non-terminal
tasks. Inline validation errors; primary "Create task" → "Creating…"; success toast may append
"— starts when dependencies clear" or "· assigned to <alias>".

### 7.3 Task detail
1. **Header card:** (root tag) title H1 · large status pill · "Priority <n>" chip · assignee
   deep-link · Description block · **Definition of done** block (accent left rule) · **Result**
   block. **Known defect:** structured results currently render as `[object Object]` — the
   redesign should show a proper result summary + linked artifacts.
2. **Gate card** (amber, the centerpiece):
   - **Plan kind:** badge "Plan awaiting your approval" + right note "acting as <alias> · logged
     to the audit trail"; full plan text (scrollable) + Definition of done; actions **Approve
     plan** / **Request changes…** + note "Approving lets <assignee> execute."
   - **Verify kind:** badge "Awaiting verification"; "**Result claimed by <assignee>**" +
     Definition of done; actions **Accept** / **Reject…** + note "Rejecting returns the task to
     <assignee>."
   - Reject reveals a **required-reason** panel: textarea "Why are you rejecting? Required —
     <assignee> sees this verbatim on the next wake.", danger hint, Submit rejection (disabled
     until typed) + Cancel. Approve confirms via modal (plan approval includes an optional
     guidance textarea).
   - Decided plans collapse to a quiet note ("Plan approved · by <actor> · <time> — <reason>").
3. **Protocol panel** (collapsible): per-task hand-off rules — **Review chain** (mono `a → b → c`),
   **Hand-off to** ("— return here first"), **Autonomy**, **Notes**. Summary chips when
   collapsed; Edit mode with Cancel/Save. Empty: "No protocol set — using container defaults."
4. **Thread card:** "Thread (N) · append-only · agents + you". Messages with avatars, AI/Human
   badges, system messages (dashed bubbles), attachments (thumbnails → lightbox, file chips).
   **Reply composer:** attach button + "Add a comment… (drag, paste or attach files)" + Post;
   staged upload tray; drag-over highlight.
5. **Assignment card** (hidden for root/terminal tasks): "Assign this task to an agent and wake
   them to start." + agent select + **Assign & wake**; 409 race handled with a "Reassign & wake"
   confirm.
6. **Close task card** (danger): reason textarea + "Close task…" with confirm modal
   ("Force-closes the task and unblocks anything waiting on it. Logged with your identity.").
7. **Runs & diffs card:** live indicator or run count; per-run cards — status chip (`running` /
   `exited · exit 0` / `killed ■ stopped` / `⚠ watchdog-killed`), wake-kind tag (`live tab` for
   tmux), **Stop run** → "Stop requested", mono start→end times; collapsible **code diff**
   (stat bar `+23 −3 · unified diff`, colored lines) and **log** (9 classified event types,
   live-streaming with section collapse). Empty: "No runs yet — appears when a worker wakes for
   this task." *(Desired addition: bind the approval to the exact diff, e.g. "reviewable diff —
   your approval is bound to exactly this (sha256:…)".)*

Notable gaps for the redesign: no explicit dependency/subtask visualization, no in-place
reprioritize, no delete (Close is terminal).

---

## 8. Screen: Requests (`/requests?req=<id>`)

**Purpose:** arbitrate agent questions, escalations, and task requests.

**Layout:** sticky left list (filterable) + detail column.

### 8.1 List panel
Header "Requests · N open" + Time/Priority sort. **Filter chips:** All · Open · Answered ·
Escalations · Task reqs. Rows: flow line "[avatar] from → [avatar] to" ("you" when targeted at
the human) · payload preview (84 chars) · status pill (**escalated** red for open escalations) ·
type tag · optional `↳ chain` tag · right-aligned priority chip. Open requests always sort
first. "Load more · X of Y". Empty: "No requests match this filter."

### 8.2 Detail
1. **Header card:** large from→to flow with agent links · large status pill · meta: "{type}
   request · Priority N · opened <time> · in service of <task link>" · red "escalated to you"
   flag when applicable.
2. **Request chain card** (when depth ≥2): vertical rail of linked chain nodes (status pill,
   "{from} → {to}", payload preview, `depth n`/`root` tag; current node highlighted).
3. **Body card:** **Payload** (linkified) · **Answer · from {to}** (green left-bordered, when
   answered) · **Rejected — reason** (red, when present) · "**Your move**" action row.
4. **Actions (role-gated to the acting human):** **Answer** (target only, opens inline composer:
   "Type your answer — {from} sees it verbatim on the next wake." + Send answer/Cancel) ·
   **Convert to task** (requester, answered only — modal with prefilled title, required
   definition of done, assignee select) · **Escalate to human** (requester — confirm modal) ·
   **Close** (always; reason required to close another agent's request). Terminal states show
   "This request is closed/converted to task. Spawned <task link>." Acting note: "Arbitrating as
   {alias} — answer (if it's yours), convert, escalate, or close. Every action is logged."
   No acting human → "Pick an acting human (top-right) to arbitrate this request."

---

## 9. Screen: Settings (`/settings`)

**Purpose:** workspace-level configuration for the universal LLM client (direct-API calls behind
guided onboarding and wake triage — separate from each agent's own model).

Intro: H1 "Settings" + explainer paragraph. Two cards:

### 9.1 Anthropic API key card
Helper copy: "Stored encrypted on this workspace… The `ORCHA_LLM_API_KEY` environment variable
takes precedence…". Three data states:
- **None:** warn banner "**No Anthropic API key configured.** Universal-model features (guided
  onboarding, wake triage) are off until you add one." + masked input `sk-ant-…` with reveal
  eye + soft-format hint + **Save key** / **Test** buttons.
- **Stored (db):** green banner "Anthropic API key configured — stored encrypted on this
  workspace" + masked chip `sk-…1234`; input placeholder "Paste a new key to replace…";
  **Replace key** / **Test** / **Remove** (danger, confirm modal).
- **Env-override:** green shield banner "Using `ORCHA_LLM_API_KEY` from the environment — it
  takes precedence…; read-only here." + only "Test stored key" + hint to relaunch with
  `orcha up`.
Test renders an inline result: green "Key is valid — Anthropic accepted it." or red server
detail. Loading / load-error (+Retry) states exist.

### 9.2 Universal model selection card
Data-driven rows, one per use-case (e.g. wake triage, onboarding proposal, image-to-text, digest
curation): use-case title + purpose sentence · **Provider** select (unavailable ones "(coming
soon)", disabled) · **Model** select (missing catalog entries injected as "(unavailable)") ·
faint "default: <model>" · foot row with a filled/hollow state dot + "set to <model>" / "using
shipped default" + **Reset to default**. A save bar: **Save changes** (enabled when dirty) ·
**Discard** · "✓ all saved" or red "Couldn't save — retry (your edits are kept)."

---

## 10. Screen: Onboarding (`/onboarding`)

**Purpose:** first-run setup of an empty workspace — register the operator, then staff it (AI-
guided or by hand). Renders inside the normal shell. `?new=1` deep-links straight to
create-agent for adding later agents.

**Progress rail** (hidden on welcome): 3 pill-steps with connectors — ① Name yourself ②
Choose a path ③ Create (done = green check, current = accent) + right link "Skip to
dashboard →". A page refresh resumes the persisted step.

### 10.1 Welcome — claim the human authority
Centered: big orca mark · eyebrow "Orcha · orchestration portal" · H1 "**Run a team of agents,
with you in command.**" · lede ("…Agents do the work and stream it to you live — but nothing
ships on their say-so…") · 3-up value props (**You hold authority / Episodic agents / Async
gates**) · **name card**: "Claim the human authority", input "Your name — e.g. Dario" +
"→ Enter" button, footnote "You can hand specific tasks to AI agents later — authority stays
with you." Empty name = red border.

### 10.2 The fork — choose a path
H1 "Welcome, {name}. Your workspace is empty — let's change that."
- **Path G · Recommended (featured, accent gradient):** "**Help me set this up**" — "Describe
  your project in a sentence. An AI proposes a starting roster… You stay in command; nothing
  exists until you approve it." → **"✦ Propose my roster →"**.
- Divider "or set it up by hand".
- **Path A: Create your first agent** ("Best first move: create a concierge agent and brainstorm
  the whole plan with it." · pill "✦ Recommended for a blank slate") · **Path B: Add tasks
  first** ("…each with a clear definition of done…" · pill "Good if the plan is clear").
- Merge note: "Either way you'll end up with agents + tasks…"

### 10.3 Path G — AI roster proposal
1. **Goal step:** "Tell me what you're building" + 4-row textarea (placeholder e.g. "Improve my
   app's onboarding…") + note "I propose; you decide." → **Propose my roster**.
2. **Streaming step:** "Designing your roster…" + italic goal echo + a **Thinking** box (mono,
   animated 3-dot pulse, streamed reasoning text) + Stop. May yield a **clarify turn** ("A
   couple of quick questions", ≤3 inputs, "Skip — just propose" / Continue) or a typed **error
   turn** (no API key → points to Settings; model error/rate-limit → Retry; also "Edit goal" /
   "Set up by hand instead").
3. **Roster review:** "Your proposed roster" + AI rationale banner. **Editable agent cards**
   (avatar, name, role, mono charter textarea, compact model picker, remove) + "+ Add agent";
   **editable task rows** (title, DoD, assignee select, "First task (kickoff)" checkbox —
   one per agent, depends-on chips, remove) + "+ Add task". → **"✓ Looks good — create the
   team"** — walks each agent through the create form (nothing committed until each Create).

### 10.4 Create agent (Path A / walk / `?new=1`)
Form card: **Agent name*** ("e.g. Atlas, Forge, Vault" — "A short, memorable alias…") ·
**Role*** ("e.g. Concierge · planning & orchestration") · **System prompt*** (9-row mono; first
agent pre-seeds a full concierge template + "✦ Use the concierge template" chip; hint "the
agent's standing persona — rehydrated on every wake") · **Model*** segmented picker (from
`/api/models`) · **First task (optional)** with 3 tabs: **Pick existing task** (radio list of
ready unassigned tasks) / **Describe a task** (textarea → becomes the initial task) / **Not
yet**. Footer: Back · "You're the authority — creating an agent doesn't wake it." · **✓ Create
agent**. During a roster walk a banner shows "Agent 2 of 3 from your proposed roster…".

### 10.5 Agent created (success)
Green check seal · "Agent created" · H1 "{alias} is ready." · agent identity card (avatar, AI
badge, role, status pill, model tag) · accent **brainstorm CTA**: "Brainstorm the plan with
{alias}" → "Open conversation with {alias} →". Walk progress block ("2 of 3 agents created —
keep going" → next agent; "All agents created, N tasks left" → add tasks; "Your proposed roster
is live" → dashboard). Secondary links: + Create another agent · Add tasks · Go to dashboard.

### 10.6 Create tasks (Path B)
"Add your first tasks" + queued-task list (numbered violet badges, title, accent-ruled DoD,
delete) · "+ New task" form (**Title***, **Definition of done*** — "The unambiguous finish
line…", Cmd/Ctrl+Enter adds) · footer: Back · "N task(s) queued" · "Continue — create an
agent →" (partial failures stay queued for retry).

---

## 11. Cross-cutting interaction patterns (preserve these)

1. **Human gating everywhere** — actions disabled or warn-toasted without an acting human;
   every decision records identity ("logged to the audit trail").
2. **Required reasons for negative actions** (reject plan/verify, close another agent's
   request); optional guidance on approvals.
3. **Optimistic UI + reconcile** — acted cards disappear immediately; failures revert + toast.
4. **Live-but-stable rendering** — 3s poll + SSE; scroll/selection/typing always preserved;
   deep-links (`?task= ?agent= ?req=`) kept in sync via replaceState.
5. **Master/detail with sticky lists** on Agents/Tasks/Requests; sort controls persisted;
   client-side "Load more" paging.
6. **One approval surface** — agent-page gates link to the Tasks gate rather than duplicating
   live buttons.
7. **Deep-link chips** for every agent/task/request mention; bare task-ids auto-link.
8. **Honest states** — every panel has explicit loading/empty/error copy (no silent failures);
   unavailable models/providers shown disabled rather than hidden.

---

## 12. Known defects & rough edges (fix in the redesign)

1. Task **Result** renders `[object Object]` for structured results — design a proper result
   presentation (summary, artifacts, links).
2. "Tasks · grouped by status" list header wraps awkwardly in the 360px panel.
3. Action-queue buttons truncate ("Reject…" ellipsized at some widths).
4. Requests empty/default state shows "Request not found." — reads like an error.
5. **≤940px the sidebar vanishes with no mobile nav** — design a responsive nav (drawer/rail).
6. No pause/archive/delete lifecycle controls for agents; no reprioritize/dependency
   visualization for tasks — decide whether to design these affordances now.
7. Settings page is sparse (two cards, lots of dead space at desktop widths).
8. Search field exists but result presentation is minimal/per-page — design a proper global
   search/command-palette experience.
9. Dashboard right rail fixes at 372px; long content areas rely on nested scrollbars.

---

## 13. What to produce (deliverables)

Generate modernized high-fidelity mockups — **light and dark theme for each** — covering every
screen and its key states:

1. **Dashboard:** populated; empty first-run (CTA visible); with all three action-card types;
   paused-autonomy banner variant.
2. **Agents:** AI agent selected — idle chat; awaiting-reply (thinking + queued variants);
   permission-request card; terminal paired (side-by-side) + terminal error overlay; maximized
   conversation; human agent selected; empty roster.
3. **Tasks:** list + detail with **verify gate** open (incl. reject-reason revealed); **plan
   gate**; new-task modal; runs & diffs with live log + expanded unified diff; done task;
   empty state.
4. **Requests:** list with filters; open escalation detail with chain view; answer composer;
   convert-to-task modal; empty state.
5. **Settings:** key-not-configured; key-stored; env-override; model rows with a dirty save
   bar.
6. **Onboarding:** welcome; fork; goal + streaming (thinking box) + clarify; roster review;
   create-agent form; agent-created success; create-tasks queue.
7. **Shared:** notification center open; autonomy confirm modal; toast set; mobile/narrow
   layout with a proper nav pattern.

**Design directives:** keep the teal-accent identity, the amber-human/teal-AI distinction, the
status-pill semantics, and the "control room" density — but modernize typography scale, spacing
rhythm, card/border treatment, and motion. Every state listed above must remain representable.
Preserve all copy semantics (labels can be polished, meanings must not change).
