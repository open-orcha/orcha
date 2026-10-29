# Review handoffs without accepting unfinished work

The review handoff is an explicit worker API operation for prepared tasks in the same
workflow. It does not change their descriptions, definitions of done, dependencies,
autonomy, holds, or approval records. Reviewers must be independently assigned.

Outside a repeat group, use a review task with no dependency on acceptance of the draft
it must review. An ordinary acceptance dependency is never waived by a handoff.

Inside a repeat group, the group's review step must be downstream of its members. A
captured handoff from the member that is the review step's **sole in-group direct
prerequisite** is the round's explicit hand-over: it satisfies only that
source-to-review prerequisite for the current round. It does not accept either task.
An earlier member in a longer chain such as A -> B -> Review still follows normal
acceptance before B starts; B may then hand off to Review. Holds, outside prerequisites
and every other admission gate remain in force. Existing serial scheduling still
admits just one turn.

## Worker sequence

1. The designer/implementer obtains the normal workflow reservation and approved plan.
   From that active work token, POST
   `/api/agents/{agent}/runs/{run}/review-handoff` with `review_task_id`,
   `expected_work_revision`, and `result` describing the exact submitted draft.
   The result is captured as evidence; the source task remains unfinished.
   Handoff capture permits a summary-only submission and does not enforce changed
   files. Include the actual review artifacts in the submission; reviewers and the
   human verifier must assess them against the task’s full requirements.
2. Exit the worker. Only the runner's positive `confirm-stopped` observation, with
   saved evidence, releases the slot. A quiet heartbeat, expired lease, or handoff
   request alone never frees capacity. The reviewer then uses ordinary reservation,
   activation, and plan approval. Holds and other prerequisites still block it.
3. Read `/api/workflows/{workflow}/review-handoffs` for the current round, source
   result, and immutable evidence references. Review those exact artifacts.
4. For a repeat-group review, first report the review step's configured outcome and
   findings with `POST /api/tasks/{task}/outcome`. Then POST
   `/api/agents/{reviewer}/runs/{run}/review-verdict` with `handoff_id`, `verdict`
   (`changes_requested` or `clean`), and the substantive `result`; then exit.
   `changes_requested` must use a configured `return`, `ask_owner` or `stop` outcome.
   `clean` must use the group's exit outcome. Outside a repeat group, the outcome call
   is not required.
5. After confirmed reviewer exit, a repeat-group route goes through the normal loop
   engine. A return starts the next round, carries findings into the worker prompt and
   preserves the round limit, stall and owner-decision rules. If the task requirements
   did not change, the human-approved plan carries into the next round; the final work
   still requires human verification. A non-group `changes_requested` verdict returns
   the turn to the original task directly. Each handoff and group round is retained.
6. CLEAN plus confirmed reviewer exit puts both exact results at
   `needs_verification`. Neither task is accepted automatically, even if task autonomy
   is on. A human uses the normal evidence-bound acceptance flow. Workflow Finish and
   PR merge remain human decisions.

Handoff and verdict retries from the same active worker return the recorded receipt;
changing a previously submitted result is refused. A new source generation creates a
new round. Old run credentials never authorize a new round. Cancellation suppresses
pending routing and never restarts cancelled tasks. Owner Stop, lost-worker release,
or cancellation of either participant ends the active round and puts surviving unfinished
tasks into the existing owner-decision state. The owner can Retry each surviving task;
an unconfirmed worker still occupies its slot until confirmed exit or the existing
owner-only lost-worker release. Cancelled participants remain cancelled unless the owner
explicitly retries them. A new prepared review task may be used instead.

Interrupted rounds remain evidence of the required review: Retry does not waive CLEAN,
and `/done` refuses before publishing any new evidence files. A new complete review
round is required before human verification. Historical handoffs intentionally continue
to suppress automatic acceptance: this task's explicit review and human gates survive
interruption. Missing evidence and human rejection retain the existing owner recovery
gates; the handoff API is not a recovery shortcut. A human who rejects a CLEAN result can Retry the source and supply a fresh
prepared review task; the previous round remains history.

The API exposes the handoff operations; this change does not add a portal editor for
starting them. The existing portal still shows and accepts the final saved results.

## Obsolete wake events and bounded recovery

Wake selection ignores messages/assignments for terminal tasks and request-created
notifications whose request is no longer open for that recipient. Filtering happens before prompt and notification limits. Active blocked workflow
messages remain parked and unacknowledged. Answers linked to terminal tasks remain
informational intake, with no terminal launch context. Human prompts are never
classified as obsolete by this repair.

System refusal notes use `system_notice: true` on the task-message API. They are
anonymous, deduplicated in the database, visible in thread history, and non-waking.
Terminal tasks suppress new refusal notes entirely. Ordinary terminal-thread messages
remain readable without notifying historical workers. Replaced historical assignments receive no new task-message notifications. The exact
submitter of a legacy task awaiting human verification still receives feedback even
though `/done` has marked that assignment done. Repeated identical system notices are
deduplicated against the latest anonymous notice; A → B → A remains visible as three
status episodes without generating worker notifications.

After deployment, each active daemon scan automatically reconciles at most 200 obsolete
events per agent using the same current-state locks and audit as the explicit endpoint.
Browser previews perform no reconciliation. The operation adds exact acknowledgements,
never a delivery-cursor jump; normal contiguous acknowledgement can subsequently move
past them without skipping live requests, active parked messages or human prompts.
This also handles late obsolete events and notifier restarts. Installing this behavior
still requires the separate approved rollout; it does not authorize pre-deployment
incident recovery.

For a separately approved recovery, POST
`/api/agents/{agent}/events/reconcile-stale` with an explicit `event_ids` list of at
most 200 IDs. `dry_run` defaults to true. Review the returned `obsolete` reasons and
`preserved_event_ids`; then submit the same bounded list with `dry_run: false` only
with the required live authorization. Apply checks current task/request state under
locks again. Changed or unknown records are preserved. Each applied batch is audited
as `stale_events_reconciled`; event and message history remain intact, and neither the
global delivery cursor nor workflow state changes. Repeating the same batch is safe.

The initial incident preview is a point-in-time proposal, not approval. Before applying,
check that the selected tasks remain cancelled and the intended request is still owed.
If the originating work is now cancelled, leave its open request for the owner to decide.
Never create a replacement request or resurrect work as part of notification cleanup.
