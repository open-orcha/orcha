# Flow 08 — Approvals (plan approval · task verification)

Mockups: [`../mockups/08-approvals.html`](../mockups/08-approvals.html) · Screens S11/S12 in
[doc 02](../02-ia-navigation.md).

> **Status: buildable against the existing API.** Plan decisions post to `POST /api/decisions`
> (portal ground truth: `home.html` `doPlan()`), verification to `POST /api/tasks/{tid}/verify`
> (`doVerify()`). Both sheets read their body text from the task thread
> (`GET /api/tasks/{tid}/messages`).

## 1. Story

Two moments in Orcha are irreducibly human: **approving an agent's plan** before it burns turns,
and **verifying finished work** before it counts as done ("never self-certify" is a standing
container rule — agent work stops at `needs_verification`). On the portal these live in the Home
action queue; on the phone they are the app's whole reason to exist — the "approve from the couch"
moments. Both are modal sheets over whatever screen surfaced them, so the human keeps context and
the decision is one thumb-reach away.

## 2. Plan-approval sheet

**Entry points:** Home tab "Needs you" card (primary), and a banner on Task detail whenever the
task is `in_progress`, has a plan message in its thread, and no `plan_decision` yet.

**Content (top → bottom):**
1. Kicker "Plan approval" + **task title** + author row (agent avatar, alias, model tag).
2. **The agent's plan — full text**, scrollable inside the sheet. Sourced from the task's
   `plan_message` (thread fallback: first non-human message via `GET /api/tasks/{tid}/messages`).
   Never truncated to a summary: the human must be able to read the whole proposal before
   approving (portal B10 invariant).
3. Pinned buttons: **Approve** (primary) · **Request changes** (tonal).

**Request changes** = a plan *reject* with **REQUIRED feedback**: tapping it expands the sheet
(iOS `.medium → .large`; Android sheet grows over the IME) revealing a feedback textarea; the
confirm button stays disabled until the text is non-empty. The feedback is routed to the agent's
next wake and posted to the task thread — say so under the field, because it sets expectations
for what happens next ("Dana sees this on her next wake").

*Note:* the portal additionally allows optional guidance on **approve** (ISS-59). Mobile v1 keeps
Approve one-tap; guidance can be added afterwards via the task thread. Parity item logged in doc 13.

**Endpoint:** `POST /api/decisions {subject_type:"plan_approval", subject_id:<taskId>,
decision:"approve"|"reject", reason?, actor_agent_id, target_agent_id?}` — reason required by the
app when rejecting. (`home.html:271` is ground truth for this contract.)

## 3. Task-completion (verify) sheet

**Entry points:** Home "Needs you" card and Task detail banner for any `needs_verification` task.

**Content (top → bottom):**
1. Kicker "Verify task" + **task title** + agent row.
2. **Definition-of-done card** — the checklist the human is verifying against
   (`definition_of_done`), visually distinct (bordered, ok-tinted header).
3. **Agent's completion summary** — the last thread message (`GET /api/tasks/{tid}/messages`),
   quoted with author + timestamp.
4. **Attachments row** — horizontally scrolling chips for any artifacts referenced in the summary
   (links open in-app browser). Hidden when none.
5. Pinned buttons: **Approve & complete** (ok-toned, styled as the primary) · **Send back with
   feedback** (neutral).

**Send back** expands the sheet with a REQUIRED feedback textarea (same mechanics as Request
changes). On submit the task returns to `in_progress`, the feedback posts to the thread, and the
agent is woken with it.

**Endpoint:** `POST /api/tasks/{tid}/verify {approve, feedback?, actor_agent_id}` — `feedback`
required by the app when `approve:false`.

## 4. Decision receipt

Both decisions produce the same feedback loop, and the app must show it:
1. A **system bubble** appears in the task thread ("kedar approved the plan" / "kedar sent the
   task back: …feedback…") — arrives via the thread, no client-side fabrication.
2. The task's **status pill flips** everywhere it renders: verify-approve →
   `completed` (s-ok); send-back → `in_progress` (s-accent); plan approve keeps `in_progress`
   but the "plan pending" banner disappears.
3. **Optimistic UI:** on 2xx the card leaves the Home "Needs you" queue instantly and the badge
   decrements; the local mutation reconciles on the next snapshot/SSE event (mirrors the portal's
   `d2Acted` suppress-then-reconcile set — suppression is scoped to the stale window, never
   permanent, so a reject→rework cycle resurfaces the same task id).

## 5. States

| State | Treatment |
|---|---|
| **Decision-post failure** | sheet STAYS OPEN; danger banner inside the sheet ("Couldn't record your decision — openorcha didn't answer") with **Retry** action; typed feedback preserved; buttons re-enabled (frame D1) |
| **Stale decision** (someone else decided first — portal race) | on 4xx-conflict or a snapshot arriving mid-sheet that shows the decision landed: buttons are replaced by an info banner "Already approved by kedar on the portal", and the sheet auto-dismisses after ~2s (frame D2) |
| **Unreachable** | both buttons render disabled + the shared connectivity banner (flows/04); the sheet can still be read and dismissed |
| **Loading** | sheet opens instantly with title from the card; plan/summary area shows text-line skeletons until the thread fetch lands |

## 6. Platform notes

- **Android:** M3 **modal bottom sheet** — drag handle, sheet scrolls the plan/DoD/summary
  content, buttons pinned at the bottom edge (elevated over content), IME pushes the sheet up
  when the feedback field focuses. Back gesture with typed feedback → "Discard feedback?" dialog.
- **iOS:** sheet with **`.medium` → `.large` detents** — opens medium (title + start of content),
  grabber visible; scrolling the plan or focusing feedback promotes to large. Swipe-down with
  typed feedback asks via confirmationDialog. Buttons sit in a pinned bottom bar inside the sheet.
- Both: the sheet dims the underlying tab (scrim) and never navigates away from it — after the
  decision the human lands exactly where they were, with the queue card gone.

## 7. Endpoints used

| Action | Endpoint | Status |
|---|---|---|
| Plan approve / request changes | `POST /api/decisions {subject_type:"plan_approval", subject_id, decision, reason?, actor_agent_id}` | exists (`home.html:271`) |
| Verify approve / send back | `POST /api/tasks/{tid}/verify {approve, feedback?, actor_agent_id}` | exists |
| Plan text + completion summary | `GET /api/tasks/{tid}/messages` | exists |
| Queue source (which tasks need me) | `GET /api/snapshot/{cid}` / `GET /api/containers/{cid}/tasks` | exists |
| Live reconcile | `GET /api/containers/{cid}/events` (SSE) | exists |
