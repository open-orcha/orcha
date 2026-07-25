"""Build the shared compact task-list query used by portal snapshots."""


def _task_list_sql(where: str, order: str) -> str:
    # Same card-facing fields as the snapshot's tasks[], MINUS the heavy `messages` json_agg:
    # a `message_summary` {count, last} replaces the thread, and `plan_message` carries the
    # latest agent-authored note so the approval card renders the plan WITHOUT the thread.
    return f"""SELECT t.id, t.title, t.description, t.definition_of_done, t.status, t.priority,
                      t.is_root, t.created_by_agent_id, t.result,
                      -- SPEC-4: per-task working agreement {{review_chain,handoff_to,autonomy,notes}}
                      -- (NULL when unset). Rides the shared task-list builder so it surfaces on the
                      -- snapshot poll + GET /containers/{{cid}}/tasks with no extra call.
                      t.protocol,
                      t.created_at, t.started_at, t.completed_at,
                      COALESCE((SELECT json_agg(a.alias ORDER BY a.alias)
                                FROM agent_tasks at JOIN agents a ON a.id = at.agent_id
                                WHERE at.task_id = t.id), '[]'::json) AS assignees,
                      json_build_object(
                          'count', (SELECT count(*) FROM task_messages m WHERE m.task_id = t.id),
                          'last', (SELECT json_build_object(
                                       'body', LEFT(m.body, 140),
                                       'created_at', m.created_at,
                                       'is_human', (m.author_id IS NOT NULL AND ma.kind = 'human'),
                                       'author_alias', ma.alias)
                                   FROM task_messages m LEFT JOIN agents ma ON ma.id = m.author_id
                                   WHERE m.task_id = t.id ORDER BY m.created_at DESC LIMIT 1)
                      ) AS message_summary,
                      (SELECT json_build_object('decision', d.decision, 'reason', d.reason,
                                 'actor', da.alias, 'at', d.created_at)
                         FROM decisions d LEFT JOIN agents da ON da.id = d.actor_agent_id
                        WHERE d.subject_type = 'plan_approval' AND d.subject_id = t.id::text
                        ORDER BY d.created_at DESC LIMIT 1) AS plan_decision,
                      -- the agent's OPENING plan = the EARLIEST agent-authored post (ASC), matching
                      -- the established "opening non-human message" plan semantics (B10 + the portal
                      -- planMsgOf consumers) so the approval card renders the plan, not a later note.
                      (SELECT json_build_object('body', m.body, 'author_alias', ma.alias, 'at', m.created_at)
                         FROM task_messages m LEFT JOIN agents ma ON ma.id = m.author_id
                        WHERE m.task_id = t.id AND m.author_id IS NOT NULL AND ma.kind <> 'human'
                        ORDER BY m.created_at ASC LIMIT 1) AS plan_message,
                      -- GH #144: the per-task runs summary counts/reads FEED membership
                      -- (worker_run_tasks — every task a run touched), not the single
                      -- worker_runs.task_id pin, so a run from a multi-task session is counted
                      -- under every task it spanned.
                      json_build_object(
                          'count', (SELECT count(*) FROM worker_run_tasks wrt WHERE wrt.task_id = t.id),
                          'latest', (SELECT json_build_object('status', l.status, 'exit_code', l.exit_code,
                                         'started_at', l.started_at, 'ended_at', l.ended_at)
                                     FROM worker_runs l
                                     JOIN worker_run_tasks wrt ON wrt.run_id = l.run_id
                                     WHERE wrt.task_id = t.id
                                     ORDER BY l.started_at DESC LIMIT 1)
                      ) AS runs
               FROM tasks t WHERE {where} {order} LIMIT %s OFFSET %s"""
