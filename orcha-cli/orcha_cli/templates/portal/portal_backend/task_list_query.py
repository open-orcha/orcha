"""Build the shared compact task-list query used by portal snapshots."""


# An agent-authored post on task `t` made after decision `d` (the revised plan).
_REVISED_AFTER_D = (
    "(d.decision = 'reject' AND EXISTS (SELECT 1 FROM task_messages rm "
    "JOIN agents ra2 ON ra2.id = rm.author_id WHERE rm.task_id = t.id "
    "AND ra2.kind <> 'human' AND rm.created_at > d.created_at))"
)

# TG-13: the start of the CURRENT plan round for task `t` — the latest plan REJECT that
# the agent has answered with a later post, else -infinity (the opening plan). Shared
# with attention_counts so the Needs-you count and the gate agree.
PLAN_CUTOFF_SQL = (
    "COALESCE((SELECT max(pd.created_at) FROM decisions pd "
    "WHERE pd.subject_type = 'plan_approval' AND pd.subject_id = t.id::text "
    "AND pd.decision = 'reject' AND EXISTS (SELECT 1 FROM task_messages pm "
    "JOIN agents pa ON pa.id = pm.author_id WHERE pm.task_id = t.id "
    "AND pa.kind <> 'human' AND pm.created_at > pd.created_at)), '-infinity'::timestamptz)"
)

# TG-13b: order agent posts inside the current plan round (`pc.c` = PLAN_CUTOFF_SQL):
# the opening round's plan is the EARLIEST agent post; a post-reject round's plan is the
# LATEST (an ack like "revising now" usually precedes the real revision).
PLAN_ROUND_ORDER_SQL = (
    "CASE WHEN pc.c = '-infinity'::timestamptz THEN m.created_at END ASC, "
    "m.created_at DESC"
)

# TG-13: an in-progress task's plan gate is OPEN when no plan decision exists, or the
# latest one is a reject the agent has answered with a revised post.
PLAN_GATE_OPEN_SQL = (
    "(NOT EXISTS (SELECT 1 FROM decisions gd WHERE gd.subject_type = 'plan_approval' "
    "AND gd.subject_id = t.id::text) OR EXISTS (SELECT 1 FROM (SELECT gd.decision, "
    "gd.created_at FROM decisions gd WHERE gd.subject_type = 'plan_approval' "
    "AND gd.subject_id = t.id::text ORDER BY gd.created_at DESC LIMIT 1) lg "
    "WHERE lg.decision = 'reject' AND EXISTS (SELECT 1 FROM task_messages gm "
    "JOIN agents ga ON ga.id = gm.author_id WHERE gm.task_id = t.id "
    "AND ga.kind <> 'human' AND gm.created_at > lg.created_at)))"
)


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
                      -- Collab v1: the owner-assigned human reviewer (NULL = anyone), plus a
                      -- resolved {{agent_id, alias, github_login}} chip so the portal renders
                      -- the reviewer without a lookup. Rides the shared task-list builder →
                      -- surfaces on the snapshot poll AND GET /containers/{{cid}}/tasks.
                      t.reviewer_agent_id,
                      (SELECT json_build_object('agent_id', ra.id, 'alias', ra.alias,
                                                'github_login', ra.github_login)
                         FROM agents ra WHERE ra.id = t.reviewer_agent_id) AS reviewer,
                      -- Mig 057: how the reviewer was chosen ({{routed_via:'reports_to'|
                      -- 'owner'|'fallback'|'manual', ...}}) + the AI manager pre-review record.
                      t.review_routing, t.manager_review,
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
                      -- TG-13: reject -> revise -> approve loop. The latest plan decision is
                      -- CURRENT unless it is a reject that the agent has since answered with a
                      -- new post (the revised plan): then the gate reopens (plan_decision NULL)
                      -- and the reject rides along as previous_plan_decision for context.
                      (SELECT CASE WHEN {_REVISED_AFTER_D} THEN NULL
                                   ELSE json_build_object('decision', d.decision, 'reason', d.reason,
                                          'actor', da.alias, 'at', d.created_at) END
                         FROM decisions d LEFT JOIN agents da ON da.id = d.actor_agent_id
                        WHERE d.subject_type = 'plan_approval' AND d.subject_id = t.id::text
                        ORDER BY d.created_at DESC LIMIT 1) AS plan_decision,
                      (SELECT CASE WHEN {_REVISED_AFTER_D}
                                   THEN json_build_object('decision', d.decision, 'reason', d.reason,
                                          'actor', da.alias, 'at', d.created_at) END
                         FROM decisions d LEFT JOIN agents da ON da.id = d.actor_agent_id
                        WHERE d.subject_type = 'plan_approval' AND d.subject_id = t.id::text
                        ORDER BY d.created_at DESC LIMIT 1) AS previous_plan_decision,
                      -- the agent's OPENING plan = the EARLIEST agent-authored post (ASC), matching
                      -- the established "opening non-human message" plan semantics (B10 + the portal
                      -- planMsgOf consumers) so the approval card renders the plan, not a later note.
                      -- TG-13: after a REJECT the plan under review is the agent's first post
                      -- AFTER that reject (the revision); before any reject it is the opening post.
                      -- TG-13b: in a post-reject round the agent often acks first ("revising
                      -- now") and posts the actual revision after, so that round takes the
                      -- LATEST agent post; the opening round keeps the earliest (ASC).
                      (SELECT json_build_object('body', m.body, 'author_alias', ma.alias, 'at', m.created_at)
                         FROM (SELECT {PLAN_CUTOFF_SQL} AS c) pc
                         CROSS JOIN task_messages m LEFT JOIN agents ma ON ma.id = m.author_id
                        WHERE m.task_id = t.id AND m.author_id IS NOT NULL AND ma.kind <> 'human'
                          AND m.created_at > pc.c
                        ORDER BY {PLAN_ROUND_ORDER_SQL} LIMIT 1) AS plan_message,
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
