# Orcha Mobile — Workflows (iOS + Android)

**Design spec for the phone equivalent of the web Workflows pages**: everything PR #340 shipped on `main` (spec: `docs/design/workflows/redesign/README.md` on branch `design/workflow-ui-redesign`, issue #350) plus the flexible-loops behaviour of PR #368 (spec: `docs/design/workflows/flexible/README.md` on `design/workflow-flexible-ux`, issue #362). Dana, 2026-10-29; requested by Kedar (task "Create UX designs that match the functionality that we have on web", workflow "Workflows on mobile apps", step 4). Part of the mobile epic #30; supersedes the deferred plan in #348. Andrew (Android, Compose) and Ethan (iOS, SwiftUI) build from this; nothing here changes production code.

| File | What it is |
|---|---|
| `README.md` | This spec: navigation, every screen × state × platform × endpoint, the iOS-vs-Android table, API check, build notes. |
| `workflows.html` | Static mockup gallery, 26 frames (iOS and Android, light and dark), built on the shared kit `../mockups/mobile.css` and the tokens in `../tokens/orcha-mobile-tokens.json`. Open in a browser. Controls illustrate states; it is not an app. |
| `renders/gallery-full.png` | One rendered contact sheet of the gallery (the image embedded in the GitHub issue). |

**Direction from Kedar (2026-10-29, on the task thread), followed over the earlier defaults in #348 and in my plan:**

1. **Build on PR #368.** Rounds, repeat groups, loop limits, outcome reports and owner decisions are part of the base design, drawn on every screen they touch, not an addendum. Where the live contract has no route yet (approval policies and gates, see §7), the phone hides the control and says so, exactly as the web spec does.
2. **Workflows is a main tab.** The Tasks tab is removed from the bottom bar. The bar is **Home · Workflows · Requests · Agents · Search** on both platforms. The task list moves *under* the Workflows tab as its second segment, so nothing from the old Tasks tab is lost (§2). #348 recommended a Tasks-tab segment and no new tab; that recommendation is withdrawn.

Choices confirmed by the plan approval: creating a workflow on the phone is **in** v1 (the workflow goal asks for it); this is a **new** issue in the format of #128, and #348 closes as superseded once this is verified; design branch only, no PR.

Status legend: **existing** = the route is in the live `/openapi.json` (checked 2026-10-29 against the portal running PR #368); **proposed** = needs an API addition (§7). Proposed controls carry a "Proposed" tag in the frame and render disabled on a server that does not report the capability.

## 1. Principles (carried from #350 and #362, plus three for the phone)

1. **The server's words, never ours.** Status labels are `display_state.label` and `workflowLabel`; disabled actions show the server's reason verbatim; blockers are listed, never summarised away.
2. **Check, see the impact, then confirm.** Every write that has a check route runs it first and shows the impact card before the confirm button enables, with `expected_revision` and one idempotency key. A refusal clears the preview. Same rule as web, same 17 actions.
3. **Explain loops in words first.** "Round 2 of 5 · exits when Review reports Passed · then asks Kedar" is on the screen before any bracket or dot.
4. **One hand, one screen.** Web's three-column detail (list · inspector · rail) becomes a stack: detail → task sheet → action sheet. Nothing needs a hover, a drag or a precise edge tap.
5. **Honest about the laptop.** Drawing the dependency graph and editing outcome routes stay on the laptop in v1; the phone shows a read-only graph and route list and says where to edit them.
6. **Never the legacy path for a workflow member.** Accept and reject go through the workflow routes; the legacy Close and Verify sheets (flows/05, flows/08) are hidden for members and while membership is unknown.

## 2. Navigation (replaces §1 and §3 of `02-ia-navigation.md` for the workspace)

```
Container workspace (tabbed)
├─ Home        — Needs you (plan approvals · finished work · questions) · Workflows card · agents glance · activity
├─ Workflows   — segmented: [ Workflows | Tasks ]
│    ├─ Workflows list (filters · owner · search · load more)  → Workflow detail
│    │     Workflow detail: header · Needs your input strip · segments Tasks | Route | Review | Activity
│    │       ├─ Task sheet (state · actions · prerequisites · acceptance · evidence · discussion) → Task page
│    │       ├─ Action sheets (17, one pattern: inputs · Check · impact · confirm)
│    │       ├─ Result review / outcome report (full-screen sheet)
│    │       ├─ Owner decision sheets (limit reached · stalled · missing outcome · allowance used up · conflicting instructions)
│    │       └─ Finish checklist (full-screen sheet)
│    ├─ Tasks list (the former Tasks tab, unchanged: grouped list → Task detail, flows/05)
│    └─ (+) New workflow (full-screen flow: Goal · Steps · Review and save)
├─ Requests    — unchanged (flows/07)
├─ Agents      — unchanged (flows/09)
└─ Search      — unchanged; results gain a "Workflow" row type that opens the detail
```

- **Segment memory.** The Workflows tab remembers the last segment per container. First launch after the update opens **Workflows**; a container whose server reports no workflow capability opens **Tasks** and shows a one-line note on the Workflows segment ("This Orcha runs an older version without workflows") instead of a dead screen.
- **Create.** Android: the Workflows segment has an extended FAB "New workflow"; the Tasks segment keeps its FAB "New task" (flows/11). iOS: toolbar "+" offers "New workflow" or "New task" via a `Menu` when both segments are available; on a segment, "+" does that segment's create directly.
- **Deep links.** Portal routes map 1:1: `/workflows` → list; `/workflows/{wid}?tab=` → detail on that segment; `#workflow-task-{tid}` → detail with that task's sheet open; `/tasks?task={tid}&workflowReturn=…` → task page with the "Back to {workflow}" crumb. Notifications (flows/08) for a workflow task open the task sheet, not the legacy task detail.
- **Back.** Android: system back closes the open sheet first, then pops detail → list, then the segment root goes to Containers home (predictive back). iOS: swipe-back pops detail → list; sheets dismiss by drag; the "Back to {workflow}" crumb on the task page is a real push target so swipe-back returns to the detail with the same task selected.
- **Home card.** "Workflows" summary card under Needs you: counts for Active, Paused, Ready to finish and "N need your decision" (limit, stall, missing outcome); tap opens the Workflows segment with the matching filter.

## 3. Screens

Frames are numbered W01–W26 in `workflows.html`; each is drawn on both platforms and both themes unless the caption says the platforms are pixel-equivalent. Endpoints are the live routes; "(check)" marks the read that must succeed before the confirm button enables.

### W01 Workflows list

- **Filters** as a horizontal chip row (M3 `FilterChip` single-select; iOS segmented capsules): Open · Preparing · Active · Paused · Ready to finish · Completed · Cancelled · All, each with its count from the loaded pages. Semantics as web (`open` = active or paused; `preparing` = active and not `launch_enabled`; `ready` = active and `completion.can_finish`; the server receives `status=`).
- **Owner filter** behind the filter icon (bottom sheet / `Menu` with avatars); **search** over loaded pages (M3 `SearchBar` / `.searchable`); "N of M loaded" under the search; pull-to-refresh resets the cursor.
- **Card** (56 pt, `.card.tap`): status glyph + server label · title · goal (one line) · chips: mode ("Serial" / "Parallel"), the first completion blocker as a warn chip, **"Round 2 of 5"** when a repeat group is running, **"Limit reached"** / **"Stalled"** / **"Needs your decision"** when an owner decision is pending · progress bar `accepted/total` · owner avatar · age. "No tasks yet" and "Task progress unavailable" render as muted text in place of the bar.
- Grouped by status with sticky headers when **All** is selected; flat otherwise. **Load more** as a tonal button under the last group while `next_cursor` is set.
- **Hidden workflows** entry at the end of the filter row (web §4.14) opens the hidden list with Restore; rendered only when the capability reports hiding.
- Endpoints: `GET /api/containers/{cid}/workflows/capability` · `GET /api/containers/{cid}/workflows?status=&cursor=` · `POST /api/workflows/{wid}/restore`.

### W02 List states

Checking support → skeleton cards (15 s timeout). Unsupported server → neutral state "This Orcha runs an older version without workflows" + "Open tasks" (switches segment). Forbidden (401/403) → danger state + "Choose acting human" (flows/03 identity). Unreachable with nothing loaded → the flows/04 unreachable state with Retry. Failed refresh after data → the stale banner ("Showing the last loaded workflow data. Refresh before making changes." + Retry) above the dimmed list, every write control disabled. Empty → "No workflows yet" + New workflow.

### W03 Workflow detail

- **Header**: title (never clamped) · meta row: status glyph + label, owner avatar + name, mode chip, progress "accepted/total tasks · accepted/total objectives", goal-acceptance chip (warn "Goal needs acceptance" / ok "Goal accepted") · **agent turns used of allowance** (#368, when the detail reports it) · goal as a two-line clamp with "More".
- **Primary action**: ONE button = the first enabled of Review start → Resume workflow → Finish checklist (Finish checklist stays the primary when none is enabled, for readers). **Overflow** (⋯) lists every other action in the web's fixed order: Review start · Pause new starts · Resume workflow | Add new tasks… · Add existing tasks… · Move or remove tasks… · Record review outcome… | Workflow settings… · Transfer ownership… · Hide workflow… | Cancel workflow… (danger). Disabled items keep the server reason as their second line. Android: `DropdownMenu`; iOS: `Menu` on the ellipsis button.
- **Needs your input strip** under the goal (web §4.13): "N need your input · View" → W19. Not a segment.
- **Owner bar** (#368): when the workflow waits on an owner decision, a warn banner in words ("Round 5 of 5 asked for changes again. No round 6 starts until you decide." / "Rounds 2 and 3 reported the same findings on the same draft. Paused for your decision.") with "Decide…" → W20.
- **Segments**: Tasks (count) · Route · Review (rounds used of limit) · Activity. Route replaces web's Dependencies tab and keeps its contents (#362 §6).
- **Operation notice**: sending ("Saving… keep this screen open"), uncertain (warn, "Check saved result" / "Retry same request") and refused banners under the header while an operation from any sheet is unresolved; every action disabled meanwhile.
- Endpoints: `GET /api/workflows/{wid}` · `GET /api/containers/{cid}/workflow-operations/{idempotency_key}` (uncertain-result check).

### W04 Tasks segment with a running loop

- Task rows (two-line `.rowline`): status glyph · title · sub-line = `display_state.label` + first blocker message · chips "Autonomy OFF/ON", warn chip when `list_warning` · assignee avatar(s) (dashed circle = unassigned) · chevron opens W06. Withdrawn tasks dim with "Withdrawn by {name}". "Release lost worker becomes available at {time}" as the sub-line while `release_available_at` is set.
- **Repeat group bracket** (#368): consecutive member rows are wrapped by a left bracket with the group name, "Round 2 of 5", round dots (filled = done, ring = current, empty = remaining), the exit rule sentence and the escalation owner. The running step's sub-line names the round and what it received ("Round 2 · received draft v2 + 3 findings"). Gate rows and Not selected rows sit outside the bracket; Not selected rows are struck through with the deciding outcome, never styled as failed.
- Row long-press (Android) / swipe-leading (iOS) exposes the task's enabled `available_actions` as a quick menu; everything is also in W06.

### W05 Route segment (read-only on the phone)

- **List / Graph** segmented control. List: the same rows with "Depends on · Needed by" sub-line plus outcome routes ("Passed → Publish · Changes requested ↺ Write (round)"). Graph: the saved graph rendered read-only (pinch-zoom, pan, fit), nodes = task rows, solid arrows = prerequisites, dotted return arrows = loop returns, selected node ringed, neighbours full, others dimmed. Tapping a node opens W06.
- **Editing**: "Edit prerequisites" lives in W06 (a list picker, max 3, reasons inline) and saves with `PUT /api/tasks/{tid}/dependencies`. Drawing nodes or editing outcome routes is laptop-only in v1; the segment says so in a muted line with "Open on the laptop" (copies the portal link).
- Endpoints: `GET /api/workflows/{wid}/dependencies` · `GET /api/workflows/{wid}` (flow definition for routes, read-only).

### W06 Task sheet (replaces web's inspector)

Full-height sheet (M3 modal bottom sheet, expanded; iOS `.sheet` large detent) with a close control, the expand icon → task page (W16), and Escape/back closing it and restoring the row.

1. Header: glyph + title (clamps to 3 lines), assignee avatar · autonomy chip · short id.
2. **State**: label right-aligned; every `blockers[].message` as a list; `display_state.warning` as a warn item; the release-available line when set. **Round context** (#368): round and attempt, why it runs (the rule), "Received this round" with the exact draft version and findings (original words), waiting reason.
3. **Actions**: enabled `available_actions` as buttons: Prepare task, Retry task / Let worker start, Release holds, Review result… as tonal; Stop this task / Withdraw from scope as danger-tonal; the rest behind "More". Under them **Not available now**: every disabled action with its server reason, so nothing is hidden. Route missing on this server → "not supported by this portal version yet", same list.
4. **Prerequisites**: Depends on / Needed by as chips (tap → task page with `workflowReturn`); "Edit" opens the picker (W12).
5. **Acceptance record** (compact: accepted by · kind · work revision · time · autonomy at acceptance · supplier lines · same-person note · attribution-unavailable warning · files with storage state and a "Fingerprint" disclosure) and **Saved evidence** cards (Current/Earlier · result and work revision · Saved/Pending/Missing/Superseded · files as version links with the short sha256 · source and phase · submitter · incomplete warning) with Refresh and "Load earlier evidence".
6. **Discussion**: the task thread (flows/05 bubbles), reads `GET /api/tasks/{tid}/messages?limit=`, posts with `author_agent_id` = the paired human; drafts kept on error; duplicate sends disabled.
7. **Task authority** line (ON/OFF and what it means) → task page switch.
- Endpoints: `GET /api/workflows/{wid}` (task view) · `GET /api/tasks/{tid}/round-context` · `GET /api/tasks/{tid}/evidence` · `GET /api/workflows/{wid}/tasks/{tid}/evidence` · `GET/POST /api/tasks/{tid}/messages`.

### W07–W08 Action sheets (one pattern for 17 actions)

Sheet with title = the action, the one-paragraph description, inputs, **Check** (calls the check route; shows "checked N s ago against revision R"), the **impact card** ("What this action will do": one row per task with title · resulting status badge · refusal or blocker lines), then confirm. Confirm is primary, or danger for Stop, Cancel, Withdraw, Withdraw outside result, Release lost worker; disabled until the check matches the current inputs; a refusal clears the preview. The sheet cannot be dismissed while sending or uncertain (drag disabled, back shows "Still saving"). Typed drafts are kept on refusal.

| Action | Inputs | Check (read) | Confirm (write) |
|---|---|---|---|
| Review start (W07) | "Tasks to release" checklist (prepared checkable; drafts disabled "prepare it first"); **expected route, loops, gates, limits and the agent-turn allowance for this run (editable, default 40)** (#368); incomplete settings with links; "Remove unavailable selections" | `GET /api/workflows/{wid}/start-check?task_ids=` | `POST /api/workflows/{wid}/start` |
| Pause new starts / Resume | — | fresh detail | `POST …/pause` / `POST …/resume` |
| Cancel workflow | reason (required) | `GET …/cancellation-check` (counts by state · accepted results kept · workers to stop) | `POST …/cancel` (danger) |
| Finish checklist (W13) | §W13 | `GET …/completion-check` | `POST …/finish` |
| Prepare task | Done when · assignee | fresh detail | `POST /api/tasks/{tid}/prepare` |
| Put on hold | reason | fresh detail | `POST /api/tasks/{tid}/hold` |
| Release holds | hold choices (start · human: reason) | `GET …/release-check?task_ids=&holds=` | `POST …/release` |
| Retry task / Let worker start | reason · reassign (optional) | fresh detail | `POST /api/tasks/{tid}/retry` |
| Stop this task (W08) / Send stop again | reason | fresh detail | `POST /api/tasks/{tid}/stop` / `…/reissue-stop` (danger) |
| Release lost worker | reason · "I understand the worker may still be running" | fresh detail; enabled only when `release_available` | `POST /api/tasks/{tid}/release-lost-worker` (danger) |
| Withdraw from scope | reason | fresh detail | `POST /api/tasks/{tid}/withdraw-from-scope` (danger) |
| Edit prerequisites (W12) | picker, 3 max, reasons inline | fresh detail | `PUT /api/tasks/{tid}/dependencies` |
| Submit outside result | result · produced by · evidence | fresh detail | `POST /api/tasks/{tid}/external-result` |
| Withdraw outside result | reason | fresh detail | `POST …/external-result/{eid}/withdraw` (danger) |
| Replace missing evidence | evidence | only when `evidence_state: missing` | `POST /api/workflows/{wid}/tasks/{tid}/evidence` |
| Add new tasks (W11) | task cards | `POST /api/containers/{cid}/workflows/preview` style review | `POST /api/workflows/{wid}/tasks` (TaskBatch, `client_key`, one idempotency key) |
| Add existing tasks (W11b) | search + impact | `POST …/import-preview` | `POST …/import` |
| Move or remove tasks | choices · destination · reason · "Include the whole group" | fresh source + destination | `POST …/move` |
| Workflow settings | name · goal · mode · task limit · round limit · reason; objectives as disclosures | fresh detail (mode change requires paused + no live turn) | `PATCH /api/workflows/{wid}` · `PATCH …/objectives/{oid}` |
| Transfer ownership | new owner (humans) | fresh detail | `POST …/transfer-owner` |
| Record review outcome | review sequence · review task · reviewed task · evidence pick · outcome · correction + follow-up | fresh detail | `POST …/review-rounds` |
| Resolve findings | reason | fresh detail | `POST …/review-loops/{tid}/resolve` |
| Hide / Restore workflow | — | `GET …/visibility-check` | `POST …/hide` / `POST …/restore` |

### W09 Result review and outcome report

Full-screen sheet for a task in `needs_verification`, opened from "Review result…" (W06, row menu, Home Needs you).

1. Title names the task; description "This decision is about the finished result, separate from its plan approval. Accepting a result never finishes the workflow."
2. **Result**: Done when · work revision and submitter · Saved evidence cards; the current set carries the "Use current saved evidence" checkbox (required for Accept); pending / missing / changed states as the warn banner with the web copy.
3. **Outcome** (#368, when the step declares outcomes): one radio per declared outcome with its route sentence ("Changes requested ↺ Write the launch post, round 3 of 5"); findings as a list (add / remove rows); the reminder that reporting cannot change success criteria. Only the assigned reporter sees this block; others see "Waiting for {reviewer}".
4. **Decision**: Accept result / Request changes with one-line consequences; note field ("What needs to change" for reject).
5. **"Review decision"** re-reads the detail and evidence set and, for an outcome, `POST /api/tasks/{tid}/outcome/preview`: the preview lists what repeats, what becomes stale (including a held, still-running worker: "a late result cannot satisfy the new round"), which acceptance needs renewing, rounds remaining. Confirm (primary for accept, danger for request changes) with the preview sentence; the supplier line shows above the confirm when an outside or owner result is involved.
- Endpoints: `POST /api/tasks/{tid}/accept` · `POST /api/tasks/{tid}/reject` · `POST /api/tasks/{tid}/outcome/preview` · `POST /api/tasks/{tid}/outcome` · `GET /api/tasks/{tid}/evidence`. Never `POST /api/tasks/{tid}/verify` for a member.

### W10 Create workflow (in scope on the phone)

Full-screen flow, three steps with a top stepper and "Draft kept while this app stays open. Nothing starts until you review Start." (in-memory draft scoped by container and person, as web; not persisted across relaunch, said in the stepper line).

1. **Goal**: name · owner (defaults to the paired human) · goal · How work runs as a segmented control (Serial / Parallel) with the explanation line · **Objectives** (0–50) as cards (Title · Done when · Remove).
2. **Steps** (1–200): cards with "Draft · Autonomy OFF" chip, summary, Done when, assignee picker (avatars), the autonomy explanation, **Depends on** chip picker ("Add prerequisite" → list of other draft and selected existing tasks; disabled entries carry `dependencyReason`: 3-max, cycle, self), Instructions behind a disclosure, Remove (disabled "Change dependents first" when depended on). **Outcomes this step can report** chips and **What happens next** rows per outcome (destination: a step · ask the owner · exit group · end of route) (#368); **Repeat group** card (steps, review step, exit outcome, most rounds (default 5), what happens at the limit, escalation owner) (#368). "Add existing tasks…" → W11b. Cards / Graph: the Graph view is read-only on the phone (the laptop draws); a muted line says so.
3. **Review and save**: "Review draft" → the draft problems list or the checked summary card (blockers, import impact, finished-result reviews when existing tasks are included; refused missing destinations, unbounded groups, ineligible reporters; the default agent-turn allowance). "Save workflow" primary, enabled only after a clean review; "Discard draft…" with confirm; after saving, "Workflow saved · Open" and the new detail.
- Endpoints: `GET /api/containers/{cid}/workflows/capability` · `POST /api/containers/{cid}/workflows/preview` · `POST /api/containers/{cid}/workflows` · `PUT /api/workflows/{wid}/flow` (outcomes, routes, repeat groups; #368) · `GET /api/snapshot/{cid}` (assignees).

### W11 / W11b Add new tasks · Add existing tasks

W11: the step cards of W10 step 2 in a sheet, then the `WorkflowChange` review card, "Confirm task addition". W11b: server search (`GET /api/containers/{cid}/workflow-task-search`, 5 matches, 200 ms debounce), selected tasks pinned above results, each row with its glyph and reason/note (already in this/another workflow, project objective, wait for current work, retry first, review its saved result, will stay held); "Review selected tasks" → `POST …/import-preview` → impact card (group size, per-task Draft / Prepared · awaiting release / Cannot be added / Needs result review / Required, hold retained, "Start this task when it is ready" checkboxes once started, "Include the whole group and review again"); **Review finished result** cards for completed tasks (done when · description · saved result · completed at · narrative · "I accept this saved result"). Footer: Keep draft and close / Confirm addition → `POST …/import`.

### W12 Edit prerequisites

Picker list of the workflow's other tasks with checkboxes (3 max counter), disabled rows carrying the reason (self, cycle, withdrawn, limit); each checked row previews "[This task] will wait for [Prerequisite] to be accepted."; Review change → Save dependencies sends the full replacement `depends_on` with both revisions, reason and idempotency key (`PUT /api/tasks/{tid}/dependencies`).

### W13 Finish checklist

Full-screen sheet. **Required tasks**: one row per task with acceptance glyph, who accepted, work revision, file count, "Evidence" expands the record inline. **Objectives**: Accepted / Needs acceptance rows; an unaccepted objective expands the acceptance form (narrative · evidence picks per task · Review · Confirm → `POST …/objectives/{oid}/accept`). **Goal**: same form when `goal_accepted_revision !== goal_revision` (`POST …/goal/accept`). "N exact file versions will be recorded" and "Objective and goal acceptance are separate recorded steps before Finish". **Still blocking Finish**: `completion.blockers` with task links; **an unresolved loop, a live worker and an unreached gate each as one line with its reason** (#368); same-person acceptances, attribution-unavailable and evidence-capability-unavailable notices as warn items; the header shows agent turns used of the allowance. Footer: Close / Finish workflow, enabled only when `can_finish` and evidence capability is available; the first blocker as the disabled hint. `GET …/completion-check` → `POST …/finish`.

### W14 Review segment · W15 Activity segment

Review: intro "Round limit N · used M"; one card per round (outcome badge, review task + report revision, reviewed task + revision, reviewed evidence files as chips, correction and follow-up tasks, "Resolved by owner decision: reason" or the "Resolve findings by owner decision" disclosure with reason + Review/Confirm); **rounds as cards with inputs, outputs and the deciding rule; stall pauses and recovery entries** (#368); "Record review outcome" in the segment toolbar; "Limit reached — no new starts" warn banner; "Review history is unavailable on this server version" empty state. `GET /api/workflows/{wid}` (review_rounds) · `GET …/review-handoffs`.

Activity: timeline rows (actor avatar · actor · event label · task link · relative time, absolute on long-press / tooltip); reason, warning, supplier and same-person lines as the body; **route-saved-before-start, worker kept (not duplicated), uncertain publish** entries (#368); "Load earlier activity"; error + Retry and "Showing previously loaded activity" as the stale banner. `GET /api/workflows/{wid}/activity?cursor=`.

### W16 Task page delta (flows/05 task detail)

- Workflow members show the glyph + server label and workflow title as the sub-line and a "Workflow" chip in lists; the **"Back to {workflow}"** crumb above the title.
- **Workflow** section: workflow link · state (glyph + label, "(last loaded)" when stale) · blockers · warning · release-available time · acceptance summary · **"Open task controls"** → W06. Membership loading / error as a muted line and the stale banner; the section's refresh icon re-reads. Non-members get "Workflow membership…" in the task ⋯ menu (list of "Add to {workflow}" rows with reasons and "Create workflow with this task").
- **Task authority**: Autonomy as a labelled switch with the one-line meaning; flipping shows the confirmation card (Keep / Save; "applies to future actions"); owner only, not for root or finished tasks, membership checked first; "Check current setting" after an uncertain save; "Read approval history" lists plan and finished-work approvals as timeline rows with the permission source and fingerprints behind a disclosure. `PUT /api/tasks/{tid}/autonomy` · `GET /api/tasks/{tid}/approvals`.
- Legacy Close, Verify, Reassign and run Stop hidden for members and while membership is unknown. The execution-controls sheet keeps only the wake switch with PR #340's copy.

### W17 Home: Needs you delta · W18 Plan approval sheet delta

Home's Needs you list: plan approvals only for tasks with autonomy OFF (`planAwaitsHuman`), every `needs_verification` task, **owner decisions** (limit reached, stalled, missing outcome, allowance used up, conflicting instructions) and **approval gates** (proposed). Workflow results open W09; owner decisions open W20; plan approvals open the flows/08 sheet with one added line: "Autonomy OFF · this agent needs your approval before it acts" and the task's workflow. `POST /api/decisions` (subject `plan_approval`, rejection requires a reason).

### W19 Needs your input (inside the workflow)

Opening the strip replaces the segment content with a decision list and a Back control: rows typed Plan approval / Finished work / Question / Owner decision / Gate, readable title, requesting agent, intended person, age; "Assigned to someone else" rows stay visible with the person's name. Selecting a row opens its surface (W18, W09, W20, or the question form: question, requester, task link, 4000-char answer box, "Send answer" → `POST /api/requests/{rid}/respond`; only the target can answer; others see "Waiting for {person}"). Completeness rules as web §4.13.6: "At least N need input" while partial, "Some questions could not be checked" + Retry on failure; **questions scoped to this workflow are proposed** (no `originating_task_id` on the request reads) — until then the strip shows plan/result/owner items plus "Workflow questions are not available on this server" and a link to Requests.

### W20 Owner decision sheets (#368)

One sheet pattern, five cases, opened from the owner bar, Home or the strip. Header in words; "what is still open after the last round"; options as radio cards each with its consequence; reason field; Confirm. The original outcome is kept beside any override.

| Case | Options |
|---|---|
| Limit reached | More rounds (new maximum, used count kept) · Reassign and continue · Accept as-is (override recorded) · Stop (keeps everything) |
| Stalled loop | the two rounds side by side (finding ids, file versions, "identical to v2"); Resume with guidance · Reassign · Accept as-is · Stop; remaining rounds shown |
| Missing outcome | pick the outcome for the step (its route sentence shown) · Stop |
| Allowance used up | Raise the allowance (used count kept) · Reassign · Change scope through owner review · Stop; "no new attempt starts meanwhile" |
| Conflicting instructions | both instructions quoted with who gave each and when; pick one or write a merged instruction; both stay in history |

Endpoint: `POST /api/workflows/{wid}/decisions` (live). The sheet reads the case from the workflow detail.

### W21 Approval gate sheet (proposed)

Header names the policy and version, who may decide on this run (self-review exclusion applied), what approval permits; the exact artifact version with its review; stale-approval note; Approve / Request changes / Decline with their declared destinations; edits field; "this sends work to…" sentence. Gate states (waiting · partly approved · approved · changes requested · declined · expired · out of date) in the header. Drawn with the "Proposed" tag; hidden on servers without the capability (§7 ask).

### W22 Workflow settings · W23 Transfer ownership · W24 Move or remove · W25 Record review outcome / Resolve findings · W26 Hide workflow

Sheets following the W07 pattern with the inputs in the table above. W22 includes the mode change rule (paused + no live turn) and the round limit; objectives editors as disclosures showing current vs proposed. W26 shows name, task count and the effects sentence from web §4.14; for active or paused work it shows the blocker plus "Review cancellation…"; success returns to the list with "Workflow hidden" and Restore (snackbar on Android, inline banner on iOS); the hidden list has name, previous status, hidden-by/time, Restore.

## 4. States (every screen)

| State | What the person sees |
|---|---|
| Checking support | skeleton rows / cards, 15 s timeout, then unsupported or unreachable |
| Unsupported server | neutral state, "Open tasks"; loop, outcome, gate controls hidden ("This server runs simple workflows") |
| Forbidden | danger state, "Choose acting human" |
| Unreachable, nothing loaded | flows/04 unreachable state, Retry |
| Stale after a failed refresh | stale banner, dimmed content, writes disabled |
| Empty | neutral state with the create action |
| Sending | banner "Saving… keep this screen open", sheet undismissable, actions disabled |
| Uncertain | warn banner "We did not get a reply. Check saved result / Retry same request" (same idempotency key) |
| Refused | danger banner with the server message; drafts kept |
| Owner decision pending | warn owner bar, "Decide…" |
| Capability missing for a control | control disabled with the exact reason; "Proposed" tag in the gallery |

Identity and connectivity: the phone acts as the paired human (`actor_agent_id` in bodies, or the `X-Orcha-Local-Actor` header on loopback/LAN; hosted deployments keep the device bearer token, flows/03). Membership and write permission are re-checked per write; `workflowWriteReason` renders as the capability banner. No writes are queued offline (02-ia §4).

## 5. iOS vs Android

| Concern | Android (Material 3 / Compose) | iOS (HIG / SwiftUI) |
|---|---|---|
| Bottom bar | `NavigationBar`, 5 destinations, badge on Home | `TabView`, 5 tabs, SF Symbols (`point.3.connected.trianglepath.dotted` for Workflows) |
| Workflows / Tasks segment | `PrimaryTabRow` under the top app bar | segmented `Picker` in the nav bar (`.principal`) |
| Create | extended FAB per segment | toolbar "+" (`Menu` when both creates apply) |
| Filters | `FilterChip` row, `SearchBar` | segmented capsules, `.searchable` |
| Task sheet | `ModalBottomSheet` expanded, drag handle | `.sheet` with `.large` detent, grabber |
| Action sheets | `ModalBottomSheet`; danger confirm as `AlertDialog` second step for Cancel / Stop / Withdraw / Release lost worker | `.sheet` `.medium`/`.large`; danger confirm as `confirmationDialog` |
| Owner decision | `ModalBottomSheet` with radio cards | `.sheet` with a `List` of selectable rows |
| Overflow | `DropdownMenu` with two-line disabled items | `Menu` with `.disabled` items and a footnote line for the reason |
| Feedback | `Snackbar` ("Workflow hidden" + Restore) | inline top banner, auto-dismiss, Restore link |
| Back | system / predictive back closes sheet → detail → list | swipe-back; sheets drag to dismiss; crumb is a push target |
| Long-press / swipe | row long-press opens quick actions | leading swipe opens quick actions |
| Graph | `Canvas` with transform gestures, read-only | `Canvas` + `MagnifyGesture`, read-only |

Card anatomy, chips, bracket, round dots, badges, banners and copy are pixel-equivalent.

## 6. Components added to `12-component-inventory.md`

Workflow card · status glyph set (the web `StatusIcon` mapping in #350 §3) · mode chip · progress bar with counts · completion-blocker chip · **loop bracket with round dots** · **outcome chip** and **route sentence** · owner bar · Needs-your-input strip · action sheet (inputs · Check · impact card · confirm) · impact card row · evidence card · acceptance record · round-context block · decision option card · gate state header (proposed) · capability banner · stale banner · operation notice (sending / uncertain / refused).

## 7. API check (live `/openapi.json`, portal running PR #368, 2026-10-29)

Every route named in §3 exists on the live server, including the #368 additions: `PUT /api/workflows/{wid}/flow`, `POST /api/workflows/{wid}/decisions`, `POST /api/tasks/{tid}/outcome` and `/outcome/preview`, `GET /api/tasks/{tid}/round-context`, `PUT /api/tasks/{tid}/reviewer`, `GET /api/workflows/{wid}/review-handoffs`, `POST /api/workflows/{wid}/hide` / `/restore` / `GET …/visibility-check`. Field names on the phone follow the schemas exactly; the gallery captions name the route under each frame.

**Asks (proposed, drawn as unavailable until they exist):**

1. **Approval policies and gate decisions** (W21, Home gate rows): no policy, gate or gate-decision route is in the live contract (#362 §7 ask 5). The phone hides gate controls and shows "Approval gates are not available on this server".
2. **Workflow-scoped questions** (W19): request reads expose no `originating_task_id`; until the additive link in #350 §7.1 exists, the strip shows plan, result and owner items only.
3. **Phone pairing auth** stays the existing ask in `13-api-asks.md` (A1); nothing new.

## 8. Build notes

**Both (shared model, do not drift):** one `WorkflowsRepository` per container behind the same reachability states as tasks; every write carries `expected_revision` (workflow) and `expected_work_revision` (task) plus one idempotency key generated when the sheet opens and reused on retry; an uncertain reply reads `GET /api/containers/{cid}/workflow-operations/{key}` before offering Retry. Capability is read once per container session and on every stale recovery. All user-visible labels come from the server (`display_state.label`, `workflowLabel`, `available_actions[].reason`); the client never invents a status. Members never call `verify`, `cancel` or `assign`.

**Andrew (Compose):** `WorkspaceScreen.kt` bottom bar: replace the Tasks destination with Workflows; `WorkflowsRoute` hosts a `PrimaryTabRow` (Workflows | Tasks) and the existing task list composable moves under it unchanged. `LazyColumn` with `stickyHeader` groups; the loop bracket as a `Box` drawing a left border with `drawBehind` around the grouped items; `ModalBottomSheet` for W06–W26 with `sheetState.hide()` blocked while `sending`; danger confirms as `AlertDialog`; `DropdownMenu` items use a two-line `Text` for the reason.

**Ethan (SwiftUI):** `WorkspaceScreen.swift` `TabView`: replace Tasks with Workflows; `WorkflowsView` holds a `Picker(.segmented)` in `.principal` and embeds the existing `TasksListView` unchanged. `List` with section headers for groups; the bracket as a `VStack` overlay with a leading `Capsule`; W06–W26 as `.sheet` with `.presentationDetents` and `.interactiveDismissDisabled(sending)`; danger confirms as `confirmationDialog`; `Menu` items disabled with the reason in a trailing footnote; `NavigationStack` path carries `workflowReturn` so swipe-back restores selection.

## 9. What changed against #348 and the approved plan

- Entry point: main Workflows tab, Tasks moved under it (Kedar, 2026-10-29). #348 §2 flow 1 and plan choice (d) withdrawn.
- #368 is the base, not an addendum: W03, W04, W05, W06, W07, W09, W10, W13, W14, W15, W17, W19, W20 carry loop, outcome and decision content.
- Creating a workflow on the phone is in v1 (W10, W11); the graph is read-only and outcome routes are edited by list, drawing stays on the laptop.
- Hide/restore moved from "proposed" to live (routes exist on the running server).
