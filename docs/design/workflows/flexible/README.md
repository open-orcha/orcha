# Flexible workflows — UX design (loops, outcomes, approvals, recovery)

**Design spec for the product requirements in [issue #355](https://github.com/open-orcha/orcha/issues/355)** (Informer's requirements document, version 1, step 4 of the "Make workflows better" workflow). Dana, 2026-10-28; requested by Kedar. Published as [issue #362](https://github.com/open-orcha/orcha/issues/362). This folder extends the Workflow UI redesign in `../redesign/` ([issue #350](https://github.com/open-orcha/orcha/issues/350)); that folder and that issue are unchanged. Architecture belongs to CodeCleanupAgent (step 3), implementation and tests to ReleaseEngineer (step 2). Mobile stays parked in #348: the requirements say no new mobile workflow screens in the first release.

| File | What it is |
|---|---|
| `flexible.html` | Static mockup gallery built on the portal's real `v2-tokens.css`, `v2-primitives.css`, `v2-shell.css` and the live shell chrome, exactly like `../redesign/redesign.html`. Open in a browser; `?theme=light`, `?frame=x03`, `?notes=off`. Sample data is a fictional Recipe App team (Kedar, Priya; agents Writer, Reviewer, Planner, Builder, Tester). Not an app. |
| `renders/x*-dark.png`, `renders/x*-light.png` | One PNG per frame per theme, 1440 × 900. |
| `walkthroughs/wt-A.gif` … `wt-H.gif`, `wt-*.mp4` | One animated walkthrough per use case A–H (dark theme): a title card, then the cursor visits every spec callout of the frame while a caption bar explains it; multi-frame use cases crossfade between frames. GIF (960 wide, for the issue) and MP4 (1440 × 900, sharper). |
| `render.mjs` | Re-renders every frame (`PUPPETEER_DIR=<dir with puppeteer-core> node render.mjs`). |
| `record.mjs` | Re-records the walkthroughs from the gallery (`PUPPETEER_DIR=<dir> node record.mjs [--only A,C] [--theme light]`; needs ffmpeg). The captions are the script's step list, so the GIF text and this spec share one source. |

Status legend used below: **existing** = behaviour PR #340 already has; **proposed** = needs the API additions in §7. Everything "proposed" is drawn as unavailable on a server that does not report the capability, the same rule the redesign uses for Hide.

## 1. What changes and why

The approved requirements add five ideas the current Workflow pages cannot show: **declared outcomes with "what happens next" rules**, **bounded repeat groups** (rounds, limit, escalation), **feedback carried into each new round**, **reusable human approval policies** with gates that are separate from task acceptance, and **recovery that never repeats a public action**. The redesign in #350 keeps every control it had; this spec adds the surfaces for those five ideas and changes ten screens. Nothing here replaces prerequisites, the three-prerequisite rule, human-only Start and Finish, evidence or acceptance records.

Principles carried over from #350 plus three new ones:

1. **Explain in words first.** Every loop, branch and gate has a sentence ("Round 2 of 5 · exits when Review reports Passed · then asks Kedar"); the diagram is never the only explanation.
2. **Outcome ≠ permission.** A reviewer's "Passed" is shown as an outcome; a person's approval is shown as a decision with what it permits and which version it covers. They never share a control.
3. **Show the path not taken.** Unselected branches, stale work and overridden decisions stay visible with the rule or person that decided.
4. **Limits are visible before Start and at the limit.** The Start review lists routes, limits, approvers and anything incomplete; a reached limit or stall is an owner decision, never a silent round 6.

## 2. Use cases and walkthroughs

Each row is one recording in `walkthroughs/` (`wt-A.gif` and `wt-A.mp4` for row A, and so on). The frames column names the still renders the recording is made of.

| | Walkthrough | Frames | What the viewer sees |
|---|---|---|---|
| A | Set up a two-step loop | x01, x01b, x02 | Create workflow: outcomes per step, route rules, a Repeat group (steps, review point, exit outcome, limit 5, escalation owner), an approval-gate step with a named policy; the Start review lists the route, limits and approvers. |
| B | Watch the loop run | x03 | Round 1 returned Changes requested; round 2 shows the round counter, the exact draft version and the three findings the writer received, why the step runs and what it waits on. |
| C | Loop limit and stalled loop | x04, x05 | Round 5 still asks for changes: no round 6; the owner chooses more rounds (used count kept), reassign, accept as-is (override recorded beside the original), or stop. A stall pauses with rounds 2 and 3 side by side. |
| D | Feedback across several steps | x06 | Test reports Requirements defect; the preview lists what repeats, what becomes stale and which acceptance needs renewing before the report is sent. |
| E | Branch on outcome | x07 | Only the selected path runs; the other is Not selected with the deciding outcome; a missing outcome asks the owner instead of guessing. |
| F | Reusable approval policy | x08, x09 | Approval gate sheet: policy, version being approved, what approval permits, Approve / Request changes / Decline; a changed draft invalidates the earlier approval; the policies surface. |
| G | Recovery | x10 | Restart mid-route makes one next attempt; a publish with no receipt is "uncertain" and asks before retrying; a live worker is reconciled, not duplicated. |
| H | Status and finish | x11 | Every step shows who, which round, which version and why it waits; Finish blocked by an unresolved loop or worker with a plain reason. |

## 3. Screens that change against #350

| # | Screen (#350 frame) | Change |
|---|---|---|
| 1 | Create workflow (f07) | "Outcomes this step can report" chips and a "What happens next" rule list per step; Repeat group card; Approval gate step type with a policy picker; the checked-draft card refuses missing destinations, unbounded groups, ineligible reporters. Frames x01, x01b. |
| 2 | Start review dialog (f04) | Expected route, loops, gates and stop conditions; limits (rounds, agent turns, estimated cost as an estimate); incomplete settings with links; Start disabled until none remain. Frame x02. |
| 3 | Workflow detail list and graph (f02, f08) | Repeat groups drawn as a bracket with round dots and the exit rule; gate rows; Not selected rows; a Route tab that shows selected and unselected paths. Frames x03, x04, x07. |
| 4 | Task inspector (f03) | Round and attempt, why it runs (the rule), what it received this round (exact versions and findings), waiting reason, next permitted actions. Frame x03. |
| 5 | Result review / outcome report (f05) | The reporter declares one outcome from the step's list; findings as a list; a "this sends work to…" preview. Frame x06. |
| 6 | Owner decision sheets (new) | Limit reached, stalled loop, missing outcome: options with their consequences and a reason field; the original outcome is kept beside any override. Frames x04, x05, x07. |
| 7 | Approval gate sheet (new) | Policy and version named in the header; what approval permits; the exact artifact version with its review; Approve / Approve with edits (conditional, routes to a new round and reopens the gate for the changed version) / Decline (closes the round, takes the declared path); stale-approval and unrelated-"approved" notes. Frame x08. |
| 8 | Activity and Review history (f09, f09b) | Rounds as cards with inputs, outputs and the deciding rule; stall pauses; recovery entries. Frames x05 (comparison), x10 (recovery entries with worker reconciliation and uncertain publish). |
| 9 | Finish checklist (f06) | Unresolved loop, live worker and unreached gate block Finish with a line each; Not selected steps never appear; scope changes need owner review. Frame x11. |
| 10 | Approval policies (new settings surface) and Needs-your-input strip (f14) | Named, versioned policies: approvers (people only), one-of or all, no self-review, deadline with reminder and escalation, what approval permits, lost-access rule, where used (with the version each run holds); saving makes a new version that applies to new runs only. Gate approvals join the Needs-your-input strip. Frame x09. |

## 4. Frame callouts

- **x01 Create workflow.** 1 stepper: "Steps" replaces "Tasks" only as a label; a step is still a task. 2 assignee and outcome chips; the review step says which assignee may report the review outcome. 3 second step. 4 route rules: every outcome has one destination or "ask the owner"; the arrow glyph ↺ marks a return inside a group.
- **x01b (same page, scrolled).** Repeat group card: steps, review point, exit outcome, most rounds (required, default 5), what happens at the limit, and a note that each round receives the last draft, findings and reason. Gate step: name, policy (with its summary: approvers, one-of, no self-review, reminder, escalation), what approval permits.
- **x02 Start review.** 1 expected route with Loop, Gate and Stops-and-asks badges. 2 limits: rounds, agent turns, estimated cost labelled as an estimate. 3 incomplete settings, with the refused-start example in the caption.
- **x03 Loop running.** 1 group bracket: name, Round 2 of 5, round dots, exit rule, escalation. 2 the running step's sub-line names the round and what it received. 3 the gate row sits outside the bracket. 4 inspector: round, attempt, why it runs, waiting on. 5 "Received this round": exact draft version and findings, original words kept.
- **x04 Limit reached.** 1 owner bar in words. 2 what is still open after the last round. 3 options: more rounds show the new maximum and the used count; accept-as-is records an override; 4 stop keeps everything.
- **x05 Stalled loop.** 1 paused bar names the two rounds. 2 side-by-side comparison on finding ids and file versions (wording similarity is only a warning). 3 options with the remaining-rounds count.
- **x06 Multi-step return.** 1 outcome choice with its route. 2 findings, and the reminder that reporting cannot change success criteria. 3 preview: repeats, stale, renew, kept. 4 rounds remaining.
- **x08 Approval gate.** 1 header names the policy version, the eligible approvers and what the decision permits; the reviewer's Passed is called a result. 2 the exact version being approved and its review. 3 the stale-approval note: a v4 needs a fresh decision; chat "approved" does not open the gate. 4 three decisions with consequences; approve-with-edits routes to a new round. 5 edits field and the sentence that says where the work goes.
- **x09 Approval policies.** 1 Needs-your-input strip counts gate approvals. 2 policy list with version and usage. 3 the policy form: people only, one-of or all, self-review rule, deadline that never approves, permitted action, lost-access rule. 4 where used, with the version each run holds; saving creates version 3 for new runs only.
- **x10 Recovery.** 1 restart bar in words: history was picked up, nothing retried automatically. 2 Activity shows the route saved before the step started (so only one attempt), the live worker kept, the unanswered publisher. 3 what Orcha checked: action id, worker, approved version. 4 options: check again, confirm published with a link, retry with the same action id, stop.
- **x11 Status and finish.** 1 group bracket with round and exit rule; the header shows agent turns used of the allowance. 2 every step sub-line: round, who, version, what it waits for, attempt and failure reason. 3 checklist lines that block Finish, each with its reason; Finish stays disabled. 4 Not selected steps never appear; scope changes need owner review.
- **x07 Branch.** 1 deciding step and its outcome. 2 Not selected node (dotted route, strike-through title, not failed). 3 selected node (solid route). 4 the missing-outcome case. 5 "Why this path" panel.

## 5. States, permissions, keyboard

- Loading, empty, forbidden, unreachable, stale and unsupported-server states follow #350 §5 unchanged. On a server without the capability, outcome, loop, gate and policy controls are hidden from Create and the Start review says "This server runs simple workflows"; existing runs render exactly as #350.
- Only the step's assigned reviewer can report a review outcome; the producer's report form offers only its own outcomes. Only the workflow owner (or a human with the owner role) sees limit, stall, override and missing-outcome decisions. Agents never see approval controls.
- Everything is reachable by keyboard; status is never colour-only (badge text, round numbers and glyphs carry the meaning). Dialogs trap focus and return it to the opening control, as the primitives already do.

## 6. Decisions taken in this design

- Loops are drawn as a bracket around consecutive list rows, not as a back-edge in the graph; the Route tab shows return arrows separately from prerequisites.
- Outcome reporting reuses the Result review dialog (#350 frame 05) with an outcome selector instead of a second "report" surface.
- Owner decisions at a limit, stall or missing outcome are sheets with options and consequences, not free-text chat.
- Gate approval is its own sheet, separate from task acceptance, with the version and the permitted action named.

## 7. API asks (for the architecture step)

The current contract (`/openapi.json`, checked 2026-10-28) has no outcomes, routes, repeat groups, rounds, allowances, stall records, approval policies or gate decisions. The frames therefore need, in the order the walkthroughs use them:

1. **Step outcomes and routes** on the workflow definition: per step, a list of outcome names and, per outcome, one destination (step, "ask owner" or "exit group"); validation errors returned by the preview and start-check routes.
2. **Repeat groups**: name, member steps, review step, exit outcome, max rounds, escalation owner; run state with current round, rounds used, and per-round inputs (artifact versions, findings, reason).
3. **Outcome report** on a task: declared outcome, findings list, free text; only the assigned reporter may post it; the server returns the routing preview before commit.
4. **Owner decisions**: raise limit (new max, used count), reassign-and-continue, accept-with-override, stop; stall resume with a note; pick outcome for a missing one. Each stored with the reason and the original outcome.
5. **Approval policies** (named, versioned) and **gate decisions** (approve, request changes, decline) bound to an artifact version.
6. **Recovery records**: uncertain external actions with receipts, worker reconciliation state.

Nothing in this folder changes production code.

## 8. Validation and status

- Rendered both themes with the portal's own stylesheets; all 12 frames checked visually. The eight walkthroughs (24 to 50 s each) were recorded with `record.mjs` and spot-checked frame by frame (A, B, F, G as contact sheets: title card, every callout visited, captions and crossfades in place). Every raw link in the issue resolves on this branch.
- Published as [issue #362](https://github.com/open-orcha/orcha/issues/362) (structure follows #350). Review by CodeCleanupAgent and Code Reviewer: requested. Kedar's approval: requested on the workflow task.
