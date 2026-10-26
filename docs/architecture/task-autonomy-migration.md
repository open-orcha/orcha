# Task autonomy migration and compatibility

Task autonomy is the only approval authority. It has two values: `off` and `on`.
New tasks default to `off`, and the migration gives every existing task that same
safe value. Completed work is not re-approved or rewritten; the new value affects
future actions only.

## Stored data

- `tasks.autonomy` and `tasks.autonomy_revision` are authoritative.
- `task_approval_records` stores plan and completion approval separately, bound to
  the exact work version, requirement and submission hashes, actor, actor kind,
  task autonomy value/revision, permission source and time.
- `workflow_task_acceptances` stores the exact accepted work version, actor name
  and kind, authority at acceptance, evidence set, immutable file versions and
  hashes. A later autonomy change does not alter this record.
- `legacy_autonomy_history` captures the former project setting and every explicit
  per-agent override during migration. These rows are history only.

The old container and agent columns remain during the compatibility window so an
older reader or configuration-history view does not fail on a mixed-version
installation. They are never consulted for approval, start or completion
authority. Their write endpoints return HTTP 410 with `task_autonomy_only`, and
current portal, desktop, iOS and Android controls do not offer those writes.

## Upgrade behavior

Run the normal backup and migration process before starting the updated service.
For native projects, current `orcha backup` writes a verified database, attachment
snapshot and hash manifest as one named set; `orcha restore` preserves the replaced
database and attachment tree, then audits every current or accepted evidence file.
A legacy database-only restore remains supported but records missing evidence as
`missing_after_restore` and leaves acceptance blocked. PostgreSQL and SQLite
migrations provide the same defaults, named checks, history capture and approval
tables. Populated-upgrade tests preserve unfinished work, completed/accepted work,
legacy authority history and exact evidence on both engines. After upgrade:

1. Existing unfinished tasks require human plan and result approval until their
   project owner explicitly switches that task ON.
2. Existing holds, dependencies, scheduling state, stop instructions and workflow
   history are unchanged.
3. Switching a task affects only later plan/completion decisions. Earlier approval
   records retain the authority that was valid when they were made.
4. A mixed-version client may still display old values, but attempts to change
   them fail closed. Upgrade clients to restore write availability.
5. `orcha up` and `orcha upgrade` replace only the retired autonomy section in an
   older generated project rulebook. Merge targets and operator house rules are
   preserved, so existing agents no longer receive unsafe Full-autonomy guidance.

Do not remove the legacy columns or history table in the same release. Their later
removal requires a separately reviewed migration after supported clients no longer
read them.
