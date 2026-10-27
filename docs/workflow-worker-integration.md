# Workflow worker adapter

This change implements worker reservation, activation, stop fencing and continuation
on the approved Workflows execution model. It is a disabled integration checkpoint,
not permission to enable Workflows, deploy, or complete the parent task.

## Shared ownership and transactions

`075_workflows.sql` / SQLite `005_workflows.sql` and `workflow_service.py` come from
ReleaseEngineer's foundation. This change owns `077_workflow_workers.sql` / SQLite
`007_workflow_workers.sql`: scoped hashed runner credentials, hashed one-use permits
and durable stop intents. CodeCleanupAgent owns evidence migration 076/006 and
`workflow_evidence_service.terminalize_workflow_run_with_evidence`.

All worker services run in the caller's database transaction. The order is container
graph guard, workflow, task, execution, then run/permit/token. No provider calls,
process creation or network calls occur under those locks. `reserve_turn` performs
the shared scheduling checks; the runner supplies a run UUID and inserts that run
and its permit in the same transaction. Failed reservation rolls back everything.

## Runner API

The generated OpenAPI exposes:

- `POST /api/agents/{aid}/runs/reserve`
- `POST /api/agents/{aid}/runs/{rid}/activate`
- `POST /api/agents/{aid}/runs/{rid}/abort-launch`
- `POST /api/agents/{aid}/runs/{rid}/confirm-stopped`
- `POST /api/agents/{aid}/runs/{rid}/continue-reserve`
- `GET /api/tasks/{tid}/worker-launch-policy`

Reservation, abort, stop confirmation and continuation take **no launcher token or
credential header**: Orcha is a local tool and its scheduler is the launcher. A header
sent anyway is ignored. What each of these routes still checks, and why:

- **Agent identity** — `aid` must be an active AI teammate (not a person, not retired,
  not in another project) and the task must be in that agent's own project. Without it
  anyone could start work as someone else.
- **Launcher row** — Orcha keeps one bookkeeping row per agent (created on first use,
  `runner_instance = orcha-local`) because permits reference it. A person who sets
  `revoked_at` on it turns launching off for that agent (`runner_revoked`); nothing
  re-creates a revoked row.
- **Permit** — still single use and bound to one reservation, so only the bootstrap
  that was handed the reservation can activate it. It is no longer a caller credential.
- **Scheduler gates** — dependencies, serial order, holds, pause/cancel/stop, completed
  or inactive state, project status, limits/capacity, work and workflow revisions,
  stale generation. These are state-consistency rules and are untouched.

Portal membership and the LAN protections in front of the API are unchanged; this only
removes the extra launcher gate that no local install could ever satisfy (nothing
minted the credentials). The notifier therefore needs no
`ORCHA_WORKFLOW_RUNNER_CREDENTIALS`, and the variable is still stripped from child
environments. When a launch is refused the notifier logs the server's plain-English
reason and posts it, with the fix, to the task thread (at most once per 30 minutes)
instead of only cooling the agent down. The note has no author (a system note): posted
as the assignee it would be the task's earliest assignee message, so it would become the
task's plan and block the real plan's approval.

The bootstrap receives its permit over stdin and executes no model CLI or task
command until activation succeeds. Activation binds the process nonce and PID;
replay by that same bootstrap returns its existing token, while a second bootstrap
is refused. The notifier tracks the preallocated run, even if post-spawn delivery is
uncertain. A timeout is never proof that activation failed.

An unconsumed permit can be aborted safely; an activated or uncertain execution
keeps its turn. Continuation needs positive old-process exit, a current authorized
assignment/work revision, an active project, an active or paused launched workflow,
and no stop intent. It retains the execution turn, increments generation, fences
older writes and leaves historical evidence sets attached to their original runs.

## Coordinator integration hooks

`workflow_worker_auth.bound_next(cur, aid, token)` returns the reserved task
idempotently, or `None` for standalone coordination. `require_current_generation`
checks ownership inside the actual mutation transaction, before existing task
locks. CodeCleanupAgent owns its use in `/next`, `/done`, thread posts and evidence
uploads. Legacy `/runs` now rejects explicit and lazily attributed workflow tasks.

`WorkflowWorkerHooks.request_stop` can be composed with approval/evidence hooks.
The coordinator must install the combined hooks in both workflow human routes and
`workflow_worker_routes.runtime_hooks_factory`. Default availability refuses every
worker admission. Task approval, lane, budget, agent capacity and runtime checks
remain required; this adapter does not supply permissive substitutes.

The stop services call the evidence guard before terminalizing or releasing a
turn. Stop records fence permits and worker tokens immediately. Lost release uses
the same `release_deadline` as the display: the later of first stop and latest
authenticated worker contact, plus 30 minutes. Reissue does not reset it. Accepted,
cancelled and rejected task outcomes survive release. Lost release never writes
`worker_stopped_at` or claims the external process is gone.

The contact middleware commits liveness even when a late worker request is
refused. It is deliberately separate from the route transaction so rejection
cannot roll back the contact. This does **not** replace same-transaction generation
checks on mutation routes. Old-generation contact cannot prolong a successor.

## Supported transport boundary and remaining enablement gates

The existing ephemeral notifier reserves before checkout preparation, uses the
inert bootstrap, and reports positive exits from its tracked process handle. No
second daemon is introduced. The wake candidate carries explicit workflow and
work revisions. Legacy tmux/manual delivery refuses workflow candidates; remote
container launch refuses a workflow permit; the legacy checkpoint respawn refuses
workflow continuation. The safe continuation API exists for their future adapter.

Before enabling the combined feature, integration must finish and test:

- Combined approval/evidence/runtime hooks and every legacy mutation/terminal writer.
- Restart adoption and durable metadata attachment to preallocated runs
  (checkout/log/runtime metadata). Runner credential provisioning is no longer a gate:
  there is no launcher credential on a local install.
- Runner authentication for legacy daemon finish/line telemetry, durable stop
  delivery retries and reconciliation after an API/notifier restart.
- Standalone-launch versus workflow-import races under the common graph guard;
  scan-time membership alone cannot authorize a later legacy launch.
- End-to-end notifier continuation if it is to be supported at release. Until
  then the old replacement path refuses workflow workers.

`WORKFLOWS_INTEGRATED` stays false, and default availability stays denied, while
these gates are outstanding. The parent integration task and independent review
own enabling the capability; passing this adapter's tests does not authorize it.

## Verification

`tests/test_workflow_workers.py` covers the real database and API handshake,
competing activation consumers, cancellation before/after activation, safe abort,
ownership misuse, refused-request liveness, the exact lost-release boundary,
preserved outcomes, evidence-failure rollback, retained review capacity, checkpoint
fencing, and the actual notifier/headless bootstrap boundary. The terminal-evidence
collaborator is substituted in these adapter tests; the combined feature must also
run with CodeCleanupAgent's real evidence guard.

Run isolated SQLite tests with `MIGRATIONS_DIR` explicitly pointing at this
checkout's `templates/migrations/sqlite`; a worker environment may otherwise point
at installed migrations. PostgreSQL tests use a uniquely named disposable test
database and also run `test_schema_parity.py`. No live project database is changed.
