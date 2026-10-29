# Flexible workflows: feedback loops

What PR 368 adds to Workflows and how it behaves. Design sources: research issue #354,
product requirements (task d8dbff6f attachment), UX issue #362 and architecture issue #363.
The API contract is `/openapi.json` (snapshot in `docs/design/workflows/workflows-openapi.json`).

## Switch and versions

- On by default. Set `WORKFLOWS_FLEXIBLE=0` (also `false`, `off`, `no`) in the portal's
  environment (for the background service, the project's `.orcha/.env`) to turn it off. While
  it is on, `GET /api/containers/{cid}/workflows/capability` reports `flexible_workflows: true`
  and `semantics_versions_supported: [1, 2]`.
- Every workflow has a `semantics_version`. Existing workflows stay version 1 and behave
  exactly as before. With the switch on, new workflows are version 2 unless the draft asks
  for 1. A draft that uses outcomes, rules or loops needs version 2 (`flexible_disabled`).
- Switching off again does not change stored workflows. Version-2 workflows stop scheduling
  with the blocker `flexible_unsupported` until the switch is back on.

## What a version-2 workflow can say

- **Outcomes** (optional, at most 8 per step): the results a step may report, each with a
  kind (`success`, `changes`, `failure`, `custom`). A step without outcomes behaves like a
  version-1 step.
- **Rules** (one per outcome): `next` (dependents proceed), `step` (branch to one direct
  dependent; the step's other branch targets are not needed), `return` (the loop's review
  step sends work back to an earlier step in its loop: a new round), `exit_group` (the loop
  ends), `ask_owner` (the owner decides), `stop` (later steps that depend on it are not needed).
- **Repeat groups** (feedback loops, at most 5): 2-10 steps that repeat, a review step, the
  outcome that ends the loop, the most rounds (1-20) and a stall rule
  (`findings_and_artifact` or `off`).
- **Turn allowance** (default 40): worker turns this workflow may use. At the limit, workers
  wait with `allowance_exhausted`. The owner raises it with `PATCH /api/workflows/{wid}`.

`workflow_graph.validate_flow` is the single flow check for preview, create, flow edits and
Start. Prerequisites stay acyclic; a loop is a repeat group, never a cycle in the graph.

## How a round runs

1. The step's worker (or a person) reports an outcome while the step runs or awaits review:
   `POST /api/tasks/{tid}/outcome` with `outcome`, up to 50 `findings` (`{"text": ...}`), a
   `note`, and the usual fences: `expected_revision`, `expected_work_revision` and a fresh
   `idempotency_key`. A worker reads the two revisions from
   `GET /api/tasks/{tid}/round-context` (`workflow_revision`, `work_revision`) just before
   reporting, and on `revision_conflict` reads them again and retries with a new key. Only the
   step's current worker or a person can report; a report for an older work revision is
   refused. A new report replaces an unapplied one.
2. `POST /api/tasks/{tid}/outcome/preview` shows, read-only, what that outcome would do:
   which steps run again, which later steps would need redoing, which branch steps are not
   needed, and whether the round limit stops it.
3. Normally the rule is applied only when the result is **accepted** under the step's
   own approval rule (autonomy ON or OFF), in the same transaction, once. The exception
   is an explicit same-group review handoff: after the reviewer reports the configured
   outcome and matching handoff verdict, confirmed reviewer exit applies that route
   without accepting either unfinished task.
4. `return` ends the round and starts the next one: the repeat set (the destination and the
   loop steps between it and the review step) gets a new work revision, like Retry, and the
   new round carries the findings, note and who sent it back.
5. At the round limit the loop waits for the owner (`limit_reached`). If the same findings
   come back on unchanged work, it waits as `stalled`. For handoff-driven rounds, unchanged
   work means the captured evidence SHA-256 values match; two empty evidence sets never
   count as unchanged. An accepted step with outcomes but no report waits as
   `missing_outcome`. `ask_owner` waits as `ask_owner`. Both unfinished handoff tasks stay
   held while the owner decides; the source never becomes ready by accident. Steps waiting
   on a decision do not count as satisfied prerequisites, and Finish is blocked meanwhile.
6. `clean` with the configured exit outcome puts the exact source and review results at
   `needs_verification`. A human verifies them once after agent review. A return outcome
   starts the next round without another plan approval when the task requirements digest
   is unchanged; changed requirements still require a new plan approval.

## Owner decisions

`POST /api/workflows/{wid}/decisions` with `kind` and `task_id`:
`raise_limit` (`new_max_rounds`), `reassign_continue` (`assignee_id`, one more round),
`accept_override` (the loop ends; the reported outcome is kept beside the override),
`resume_stalled` (`note` goes to the next round), `pick_outcome` (`outcome`, for
`missing_outcome` and `ask_owner`), and `stop`. Each one is recorded with the outcome that
caused it and written to the audit log.

For a handoff-driven loop, continuing decisions (`raise_limit`, `reassign_continue`,
`resume_stalled`, and a return chosen with `pick_outcome`) start the next round from the
captured findings. Ending decisions (`accept_override`, `stop`, or an exit chosen with
`pick_outcome`) retain both exact results for final human verification. They never accept
the draft implicitly.

## Editing after Start

`PUT /api/workflows/{wid}/flow` replaces outcomes, rules and repeat groups. Before Start
anything goes. After Start each step freezes once it has started: its outcomes and rules,
and any loop that contains it, cannot change (`step_started`, naming what is frozen).
Not-started steps can still be added, re-pointed and given rules. Every structural change
after Start writes a new definition version; Start writes version 1.

## What the worker sees

The prompt for a version-2 step lists the outcomes to report with the report URL, and for
a loop member its round of the limit, the rule that ends the loop, what this round must
address and the earlier rounds (trimmed oldest-first to 64 KB). A member is told to use a
review handoff only when it is the sole in-group direct prerequisite of the group's
review step. The reviewer is told to report the loop outcome and findings before the
matching verdict. The same view is `GET /api/tasks/{tid}/round-context`.

## Portal

- Create: an Outcomes and next steps section on each step card and a Feedback loops card,
  shown only when the server reports `flexible_workflows`.
- Task rows: "Round N of M", "Decision needed", and dimmed "Not selected" steps.
- Task inspector: a Round section (round context above) and, for the owner, the decision
  sheet when a loop or outcome waits.
- Result review: the reported outcome, a choice to confirm or change it with findings, and
  a preview of what happens next before Confirm.

## Data

Migration `082_workflow_flexible_loops.sql` (SQLite `012`): `workflows.semantics_version`,
`definition_version`, `turn_allowance`, `turns_used`; `tasks.route_state`,
`awaiting_loop_decision`; tables for step outcomes, routes, repeat groups and members,
group rounds, step instances, outcome reports, route decisions, owner decisions and
definition versions.

## Not in this PR

Named reusable approval policies and gates, action receipts, and continuation past the
20-minute run cap are planned as a follow-up PR.

## Tests

`tests/test_workflow_flexible.py` (engine, routes, rounds, limit, stall, owner decisions,
fences, flow edits, prompt) plus the existing `-k workflow` suite, on SQLite and Postgres.
Portal: `npx vitest run src/pages/workflows` from `orcha-cli/orcha_cli/templates/portal/frontend`.
