---
description: Check an iOS, Android or web app against the project's approved (validated) QA scenarios with the orcha-qa tools, one verdict per criterion with the screen as evidence. Use when a task asks to run the QA scenarios, regression-test the app, or verify a change on the device.
allowed-tools: Bash, Read, Grep, Glob, mcp__orcha-qa
argument-hint: [ios|android|web] [--scenario <name or id>]... [--tag <tag>] [--request <request id>]
---

You are executing `/orcha-qa-check`. You run approved scenarios on the device and give each
criterion a verdict a person can trust. Your verdicts are evidence on the task; a person still
verifies the task.

User arguments: `$ARGUMENTS`

If the `mcp__orcha-qa__*` tools are not available, post "QA tools are not on for this project — a
person runs `orcha qa enable`" on the task thread and stop.

**A QA request.** When your task names one (`request_id`, or `--request`), pass it to `start_session`:
it links the session, supplies the platform and the task, and lists the scenarios, tags, build to test
and acceptance lines. Test that build. Whoever asked gets your result when you finish.

**A person's Run click is the approval.** When your task says a person started this run, your plan
is approved: go straight on and do not stop to ask. The finished work still waits for a person.

## 1. Pick the scenarios

`list_project(platform)` lists the scenarios with their status, those shared by every platform
included, and what people told QA: obey it, and never report a behaviour they marked not a bug. What
runs:

- **Named** (`--scenario`, by id or name): exactly those, drafts and paused ones too: a person picked
  them. Retired ones never run.
- Otherwise the **validated** ones: those tagged (`--tag`), else the ones the task's definition of
  done points to, else all of them for the platform. A quarantined one is validated: it runs. A
  paused one is skipped. One marked `suspicious` is skipped until a person keeps it. Say what you
  skipped, and why, in your summary.

`get_scenario(id)` gives each one's criteria (0-based), checks, data, needs, how it runs and the known
path a walk recorded, if any. Follow that path unless the app has moved on; the criteria still decide.

## 2. Run each scenario

1. `start_session(platform, kind="check")` once (with a request:
   `start_session(request_id=<id>)`), then `start_scenario(id)` before
   **each** scenario: it stops the app, clears its data unless the scenario keeps it (`fresh`) or
   restores a `session`, grants the app's permissions unless the scenario tests the prompt
   (`permissions: ask`), and opens the app. Read its reply: when it says the data was not cleared,
   give every criterion `blocked` with that reason. An Examples table runs once per row:
   `start_scenario(id, example_row=<n>)` for each row, its values filling the `{{column}}` names; a
   sealed value is typed with `type_secret(target, id, column)`, never read. `Seed:` lines run first
   and `Cleanup:` lines after the scenario, whatever its outcome, by whatever means the app offers;
   a seed you cannot run blocks the scenario.
2. Work out the steps yourself: the criteria are outcomes, not a script. Use the scenario's data
   values; a `{{name}}` from `## Data` gets one realistic value for this run, the same everywhere in
   it.
3. Bring the app to each criterion's moment, then `verdict(scenario_id, criterion_index, verdict,
   note)`:
   - `pass`: the screen shows the outcome **and** every `Check:` line of that criterion holds on it
     exactly (role, label, state). A check that fails is a fail, even if the outcome looks close
     enough.
   - `fail`: the app is wrong — also `capture_evidence` with the expected and actual.
   - `blocked`: you could not get there (sign-in, missing data, an earlier step broke); say why.
   - `inconclusive`: the screen cannot tell.
   A `[warning]` criterion that fails is reported `fail` but does not fail the scenario.
   A shared scenario whose words this platform cannot judge: `inconclusive`, with a note that starts
   `criteria don't fit:` and says which words this platform lacks.
   The outcome held but a `Check:` line is wrong, not the app: give the verdict the screen earned and
   send `check_fix` with the line, why and the corrected line. Never edit the check yourself: a
   person accepts it. A check you judged in a corrected form goes in `check_repairs`.
   With a request, also give each acceptance line a verdict: add `acceptance_line=<n>` to the verdict
   whose criterion proves it, or `verdict(verdict, note, acceptance_line=<n>)` alone when no scenario
   covers it. A line's verdict is the proof on the source task, with the current frame as its
   screenshot, so bring the screen to the line's moment first. Never guess a line: leave it if you
   did not see it.
4. A `Saved:` line is checked by reading the record back where it says (its detail screen after a
   relaunch); say what you read in the note.

The decision rules of `/orcha-qa-explore` §3 hold throughout.

## 3. Finish

`end_session(summary)` (a check session has no time budget to spend). On the task: per scenario,
pass / fail / blocked with the failing criteria and why; then `/orcha-done` with that summary. With
a request, finishing is what sends the result back: your verdicts roll up to passed, failed or blocked,
and that goes to whoever asked. In a **QA step** of a workflow do not report an outcome: the result
reports `pass` or `fail` for you, with your findings, and the server refuses yours. In any other
workflow step whose outcome routes on the result, report `failure` when any scenario failed, else
`success`. Either way a result is evidence: who finishes the task is the project's call, never yours. A quarantined scenario that failed is reported, marked as quarantined, and does not
count as a failure: it leaves quarantine on its own after clean passes, or when a person releases it.

## Conditions

A run can name the conditions its case needs: an OS version, a language and region, a text size, an appearance, a time zone, a network, an account, setup steps. They come in your task (`Conditions: pass conditions=... to start_session`), in the QA request, or on a scenario. Pass the run's to `start_session` exactly as given; `start_scenario` adds each scenario's own. The reply says what Orcha set on the device, what is not met, and what you set up yourself.

- What you set up yourself (an account with an active subscription, a time zone on a phone, a data state): use your own tools, such as an MCP server that fetches test accounts, before the criteria. Type a fetched password with `type_text` only when no sealed value exists, and never put it in a note, a finding or the report.
- Never invent an account or a value, and never pretend a condition holds. A condition that is not met makes the criteria it touches `blocked` with why, never `pass`.
- Say in your report which conditions held, as the reply said them.

## The device

When the task names a device (`--device <name>`, or `Device:` in a QA step), pass it as `device=` to `start_session`, exactly as written, and use no other. It may be a simulator, an emulator or a physical phone. If it answers that a phone is locked, not connected or not trusted, post that line on the task and stop: a person has to do it, and it is no finding. If the app is not on a physical iPhone, the answer says how to build and install it: do that, then start again.

Never claim the device lock by hand (no `mkdir /tmp/claude-sim-lock-…`, and never remove one): `start_session` does it, and lets it go when the session ends. When the device is held by another run, `start_session` waits in line. If it answers `waiting:` it says which device and who has it: that is no failure and no finding, and no budget has gone. Call `start_session` again at once with the same arguments, until it starts.

Build before `start_session`, or use the installed build, and say which in your report. The device is yours from `start_session` to `end_session`: a build inside the session (`orcha job`) spends the budget and keeps every other run off the device.
