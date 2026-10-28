"""Read wake state and pending work without deciding whether to wake."""

from portal_backend import sql
from portal_backend.stranded_runs import last_activity_expr, turn_owned_expr


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
                      AND wr.lane = 'work' AND NOT {turn_owned_expr()}
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
    cur.execute("SELECT 1 FROM tasks WHERE id=%s AND status NOT IN ('completed','cancelled')", (task_id,))
    return task_id if cur.fetchone() else None


def ready_task_ids(cur, aid: str, cid: str):
    """Return assigned ready tasks in claim order."""
    cur.execute(
        """SELECT t.id FROM tasks t
           JOIN agent_tasks at ON at.task_id = t.id AND at.agent_id = %s
           WHERE t.container_id = %s AND t.status = 'ready'
             AND at.assignment_status <> 'done'
             AND t.is_root = false
           ORDER BY t.priority, t.created_at""",
        (aid, cid),
    )
    return [str(row["id"]) for row in cur.fetchall()]


class WorkflowParking:
    """Decide which Workflow tasks are "parked": waiting for their turn, so no wake can use them.

    A Workflow task whose reserve would be refused (prerequisite, serial turn, hold, a
    worker still running) is parked. A refused reserve ends the whole wake, so a parked
    task must never be the wake's task, and its messages wait until it can start. A task
    whose stopped worker can continue its live turn is not parked: the continue route
    re-checks every gate. Uses the same eligibility the reserve route checks, so nothing
    the reserve would admit is parked. Snapshots are cached per Workflow for one scan.
    """

    def __init__(self, cur, aid: str):
        self.cur = cur
        self.aid = aid
        self._eligibility = {}
        self._parked = {}

    def _choice(self, wid: str, tid: str):
        if wid not in self._eligibility:
            from portal_backend.workflow_integration import IntegratedWorkflowHooks
            from portal_backend.workflow_service import WorkflowService

            try:
                snapshot = WorkflowService(self.cur, IntegratedWorkflowHooks()).snapshot(wid)
                self._eligibility[wid] = {
                    str(t): c for t, c in snapshot["eligibility"].items()
                }
            except Exception:
                self._eligibility[wid] = {}  # unreadable Workflow: the reserve decides
        return self._eligibility[wid].get(tid)

    def parked(self, task_id) -> bool:
        if not task_id:
            return False
        tid = str(task_id)
        if tid not in self._parked:
            self._parked[tid] = self._compute(tid)
        return self._parked[tid]

    def _compute(self, tid: str) -> bool:
        self.cur.execute("SELECT workflow_id, status FROM tasks WHERE id=%s", (tid,))
        task = self.cur.fetchone()
        # Completed/cancelled tasks keep their existing drain rules; only live work parks.
        if not task or not task["workflow_id"] or task["status"] in ("completed", "cancelled"):
            return False
        choice = self._choice(str(task["workflow_id"]), tid)
        if choice is None or (choice["can_start"] and choice["source_kind"] == "worker"):
            return False
        return continuable_run_id(self.cur, tid, self.aid) is None


def continuable_run_id(cur, task_id, aid: str):
    """Return the run of this agent's live turn on the task whose worker has stopped.

    A worker that exited mid-turn keeps the turn (confirm-stopped). A new event for that
    task continues the SAME turn; a fresh reserve would be refused because the turn is
    still live. The continue route re-checks every gate.
    """
    cur.execute(
        """SELECT run_id FROM workflow_executions
           WHERE task_id=%s AND claimant_id=%s AND run_id IS NOT NULL
             AND state IN ('running','recovery_needed')
             AND worker_stopped_at IS NOT NULL AND first_stop_at IS NULL
           ORDER BY generation DESC LIMIT 1""",
        (str(task_id), aid),
    )
    row = cur.fetchone()
    return str(row["run_id"]) if row else None


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
