"""Read wake state and pending work without deciding whether to wake."""

from portal_backend import sql
from portal_backend.stranded_runs import last_activity_expr


def list_wake_agents(cur, cid: str, cooldown: float):
    """Return active AI agents with both wake-lane liveness projections."""
    cur.execute(
        f"""SELECT a.id, a.alias, a.model, a.reasoning_effort, a.last_heartbeat_at,
                  a.turns_used, a.turn_budget, a.auto_wake_interval_secs,
                  a.autonomy_override,
                  COALESCE(r.wake_enabled, true) AS wake_enabled,
                  r.tmux_target, r.headless_cwd, r.headless_flags,
                  COALESCE(w.delivered_ts, 0) AS delivered_ts,
                  w.last_woken_at, w.work_last_heartbeat_at,
                  {sql.age_secs("w.work_last_heartbeat_at")}
                    AS work_idle_seconds,
                  {sql.age_secs("a.last_heartbeat_at")} AS idle_seconds,
                  {sql.age_secs("w.last_woken_at")} AS secs_since_woken,
                  (w.last_woken_at IS NOT NULL
                   AND {sql.age_secs("w.last_woken_at")} < %s)
                    AS in_cooldown,
                  (w.wake_lease_until IS NOT NULL
                   AND w.wake_lease_until > now()) AS lease_active,
                  CASE WHEN w.wake_lease_until IS NOT NULL
                              AND w.wake_lease_until > now()
                       THEN w.lease_kind ELSE NULL END AS lease_kind,
                  w.conv_lease_until, w.conv_delivered_ts, w.conv_last_woken_at,
                  (w.conv_lease_until IS NOT NULL
                   AND w.conv_lease_until > now()) AS conv_lease_active,
                  EXISTS (
                    SELECT 1 FROM worker_runs wr
                    WHERE wr.agent_id = a.id AND wr.status = 'running'
                      AND wr.lane = 'work'
                  ) AS embodiment_running,
                  -- how long the newest running work row (and its lane) has been silent;
                  -- lets the wake reason say when a stranded run will be reconciled
                  (SELECT {sql.age_secs(last_activity_expr("work"))}
                     FROM worker_runs wr
                    WHERE wr.agent_id = a.id AND wr.status = 'running'
                      AND wr.lane = 'work'
                    ORDER BY wr.started_at DESC LIMIT 1
                  ) AS embodiment_silent_seconds,
                  EXISTS (
                    SELECT 1 FROM worker_runs wr
                    WHERE wr.agent_id = a.id AND wr.status = 'running'
                      AND wr.lane = 'conversation'
                  ) AS conv_embodiment_running
           FROM agents a
           LEFT JOIN agent_reachability r ON r.agent_id = a.id
           LEFT JOIN agent_wake_state w ON w.agent_id = a.id
           WHERE a.container_id = %s AND a.kind = 'ai'
             AND a.terminated_at IS NULL
           ORDER BY a.created_at""",
        (cooldown, cid),
    )
    return cur.fetchall()


def pending_event_summary(cur, aid: str, delivered_ts, non_waking_events):
    """Return count, ceiling, newest event name, and newest payload."""
    excluded = sql.list_param(non_waking_events)
    cur.execute(
        f"""SELECT count(*) FILTER (
                    WHERE {sql.not_in_list('e.event_name')}
                      AND NOT EXISTS (
                        SELECT 1 FROM agent_event_acks a
                        WHERE a.agent_id = %s AND a.event_id = e.id
                      )
                  ) AS n,
                  max(e.ts) AS max_ts
           FROM agent_events e
           WHERE e.event_key = %s AND e.ts > %s""",
        (excluded, aid, aid, delivered_ts),
    )
    event = cur.fetchone()
    pending = event["n"] or 0
    latest = None
    latest_payload = None
    if pending:
        cur.execute(
            f"""SELECT e.event_name, e.payload FROM agent_events e
               WHERE e.event_key = %s AND e.ts > %s
                 AND {sql.not_in_list('e.event_name')}
                 AND NOT EXISTS (
                   SELECT 1 FROM agent_event_acks a
                   WHERE a.agent_id = %s AND a.event_id = e.id
                 )
               ORDER BY e.ts DESC, e.id DESC LIMIT 1""",
            (aid, delivered_ts, excluded, aid),
        )
        latest_row = cur.fetchone()
        latest = latest_row["event_name"]
        latest_payload = latest_row["payload"]
    return pending, event["max_ts"], latest, latest_payload


def newest_answer_task_id(cur, aid: str, delivered_ts):
    """Return the newest pending answered request's still-existing task id."""
    cur.execute(
        """SELECT e.payload FROM agent_events e
           WHERE e.event_key=%s AND e.ts > %s
             AND e.event_name='request_answered'
             AND e.payload->>'originating_task_id' IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM agent_event_acks a
               WHERE a.agent_id = %s AND a.event_id = e.id
             )
           ORDER BY e.ts DESC, e.id DESC LIMIT 1""",
        (aid, delivered_ts, aid),
    )
    answer = cur.fetchone()
    task_id = (answer["payload"] or {}).get("originating_task_id") if answer else None
    if not task_id:
        return None
    cur.execute("SELECT 1 FROM tasks WHERE id=%s", (task_id,))
    return task_id if cur.fetchone() else None


def ready_task_ids(cur, aid: str, cid: str):
    """Return assigned ready tasks in claim order."""
    cur.execute(
        """SELECT t.id FROM tasks t
           JOIN agent_tasks at ON at.task_id = t.id AND at.agent_id = %s
           WHERE t.container_id = %s AND t.status = 'ready'
             AND t.is_root = false
           ORDER BY t.priority, t.created_at""",
        (aid, cid),
    )
    return [str(row["id"]) for row in cur.fetchall()]


def startable_task_ids(cur, task_ids):
    """Drop ready Workflow tasks the Workflow would refuse to start right now.

    A Workflow task waiting on a prerequisite or another task's turn is 'ready' but
    its reserve is refused, and a refused reserve ends the whole wake. Left in the
    list it would become the launch task and swallow the agent's other work (a
    review request, an answer) until the Workflow moved on. Uses the same
    eligibility the reserve route checks, so nothing it would admit is dropped.
    """
    if not task_ids:
        return task_ids
    cur.execute(
        "SELECT id, workflow_id FROM tasks WHERE id IN ("
        + ",".join(["%s"] * len(task_ids))
        + ")",
        tuple(task_ids),
    )
    workflow_of = {str(r["id"]): r["workflow_id"] for r in cur.fetchall()}
    if not any(workflow_of.values()):
        return task_ids
    from portal_backend.workflow_integration import IntegratedWorkflowHooks
    from portal_backend.workflow_service import WorkflowService

    service = WorkflowService(cur, IntegratedWorkflowHooks())
    eligibility = {}
    for wid in {w for w in workflow_of.values() if w}:
        try:
            for tid, choice in service.snapshot(str(wid))["eligibility"].items():
                eligibility[str(tid)] = choice
        except Exception:
            pass  # unreadable Workflow: keep its tasks; the reserve decides
    kept = []
    for tid in task_ids:
        choice = eligibility.get(tid)
        if workflow_of.get(tid) and choice is not None and not (
            choice["can_start"] and choice["source_kind"] == "worker"
        ):
            continue
        kept.append(tid)
    return kept


def has_pending_task_request(cur, aid: str) -> bool:
    """Return whether the agent owes an accept or reject decision."""
    cur.execute(
        """SELECT EXISTS (
             SELECT 1 FROM requests
             WHERE target_id=%s AND type='task' AND status='open'
           ) AS h""",
        (aid,),
    )
    return bool(cur.fetchone()["h"])


def request_answer(cur, latest: str | None, latest_payload: dict | None):
    """Return the full answer used to classify a single pending event."""
    request_id = (latest_payload or {}).get("request_id")
    if latest != "request_answered" or not request_id:
        return None
    cur.execute("SELECT response FROM requests WHERE id=%s", (request_id,))
    row = cur.fetchone()
    return row["response"] if row else None
