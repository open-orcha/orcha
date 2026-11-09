---
description: Diagnose QA findings before anyone acts on them: re-run only the failing part at least three times, read the code, re-rate the severity and find the root cause, then record it with triage_finding. Use when a task or a workflow step asks to triage findings.
allowed-tools: Bash, Read, Grep, Glob, mcp__orcha-qa
argument-hint: [--request <request id>] [--finding <id>]...
---

You are executing `/orcha-qa-triage`. A finding is a claim, not a fix order. You judge each one, and
your diagnosis decides what happens to it. You do not fix anything, and your result verifies nothing.

User arguments: `$ARGUMENTS`

If the `mcp__orcha-qa__*` tools are not available, post "QA tools are not on for this project — a person
runs `orcha qa enable`" on the task thread and stop.

**A person's Run click is the approval.** When your task says a person started this run, your plan is
approved: go straight on, and do not stop to ask.

## 1. Start

`start_session(request_id=<id>)`. It lists the findings to diagnose and the build to test. `list_project()`
shows what people told QA: anything marked not a bug is settled. Read each finding: its title, expected,
actual, the frames and the steps that showed it.

## 2. For each finding

1. **Re-run only the failing part**, not the whole flow. Attempt it **at least 3 times**, resetting
   between attempts: "fails 3 of 3" and "fails 1 of 3" are different bugs. Note what differs when it
   does not fail. A step that failed earlier in your session counts: the app may have changed state.
2. **Read the code** behind it (`Read`, `Grep`), read only: find the root cause, in a sentence that names
   the file or the rule. No guess presented as a cause: say what you know.
3. **Re-rate the severity** with the rubric, by impact on the people and agents who use the app, not by
   whether the screen technically works. Can they finish the task? Is something stuck with no way out? Is
   data lost or wrong where it is kept? Is a feature's core purpose broken? How far does it reach, and is
   there a workaround a normal user would find? Is it security or privacy relevant?
   - `blocker`: a crash or hang, data loss or corruption, nobody gets past it on a main path, a breach.
   - `major`: a feature does not do its job, or someone is stuck and nothing will ever free them.
   - `minor`: it works, with friction a user gets past alone; nothing lost or stuck.
   - `trivial`: visual or copy only.
   When in doubt, a stuck actor is at least major. Reach and a workaround move a rating one level at most,
   and never lower a stuck actor, lost data or a security problem below major.
4. **Record it**, with the screen that proves it on the device:
   `triage_finding(finding_id, classification, reproduced, attempts, reproductions, root_cause, severity?, duplicate_of?, note?)`.

| classification | means | what then happens |
|---|---|---|
| `product_bug` | the app is wrong, and you reproduced it | blocker or major: goes to the fix. Minor or trivial: a backlog task; it does not block |
| `test_issue` | the scenario or its check is wrong, not the app | a suggestion on the scenario for a person; never edit it |
| `flaky` | it failed some attempts, not all | the scenario is quarantined with the rate |
| `environment` | the device, the data or a service is missing | the request ends blocked; say exactly what is missing |
| `agent_error` | the first agent got it wrong | dismissed, with your reason |
| `duplicate` | it repeats an open finding (`duplicate_of`) | merged into that finding |

`not_a_bug` is a person's call: if you think it is one, pass `needs_person=true`. Use that for any
judgement call the owner should make; the step then asks them.

## 3. Finish

`end_session(summary)`, then `/orcha-done` with what you decided for each finding. Your diagnoses roll up
by themselves: `fix` when a confirmed blocker or major remains (only those go back), `clear` when nothing
left blocks, `needs_person` when a finding has no diagnosis, the environment stopped you, or you asked.
Do not report an outcome yourself: the server refuses it. A person still accepts the step.

## Conditions

A run can name the conditions its case needs: an OS version, a language and region, a text size, an appearance, a time zone, a network, an account, setup steps. They come in your task (`Conditions: pass conditions=... to start_session`), in the QA request, or on a scenario. Pass the run's to `start_session` exactly as given; `start_scenario` adds each scenario's own. The reply says what Orcha set on the device, what is not met, and what you set up yourself.

- What you set up yourself (an account with an active subscription, a time zone on a phone, a data state): use your own tools, such as an MCP server that fetches test accounts, before the criteria. Type a fetched password with `type_text` only when no sealed value exists, and never put it in a note, a finding or the report.
- Never invent an account or a value, and never pretend a condition holds. A condition that is not met makes the criteria it touches `blocked` with why, never `pass`.
- Say in your report which conditions held, as the reply said them.

## The device

Never claim the device lock by hand (no `mkdir /tmp/claude-sim-lock-…`): `start_session` does it. If it answers `waiting:`, the device is busy: that is no failure. Sleep, then call it again with the same arguments.
