"""Agent route for atomically claiming assigned ready work."""

from typing import Optional

from fastapi import Header, HTTPException

from portal_backend.agent_status import bump_agent, log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.autonomy import effective_autonomy
from portal_backend.database import db_cursor
from portal_backend.event_acknowledgement import _ack_events_handled
from portal_backend.guards import reject_if_retired as _reject_if_retired
from portal_backend.guards import require_agent as _require_agent
from portal_backend.guards import require_container_active as _require_container_active
from portal_backend.guards import require_kind as _require_kind
from portal_backend.guards import valid_uuid as _valid_uuid
from portal_backend.worker_auth import require_work_lane as _require_work_lane


@app.post("/api/agents/{aid}/next")
def agent_next(
    aid: str,
    x_orcha_run_token: Optional[str] = Header(default=None, alias="X-Orcha-Run-Token"),
):
    """Atomically claim the highest-priority READY task in this agent's container."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        agent = _require_agent(cur, aid)
        _require_work_lane(cur, aid, x_orcha_run_token)
        _require_kind(cur, aid, ("ai",))
        _reject_if_retired(cur, aid)
        cid = str(agent["container_id"])
        _require_container_active(cur, cid, aid)
        cur.execute(
            """SELECT t.id, t.title, t.description, t.definition_of_done, t.priority, t.protocol
               FROM tasks t
               JOIN agent_tasks at ON at.task_id = t.id AND at.agent_id = %s
                 AND at.assignment_status IN ('assigned','accepted','working')
               WHERE t.container_id=%s AND t.status='ready' AND t.is_root = false
               ORDER BY t.priority, t.created_at
               FOR UPDATE SKIP LOCKED
               LIMIT 1""",
            (aid, cid),
        )
        task = cur.fetchone()
        if not task:
            conn.commit()
            return {"task": None, "message": "no ready tasks available"}
        tid = str(task["id"])
        cur.execute(
            "UPDATE tasks SET status='in_progress', started_at = COALESCE(started_at, now()) "
            "WHERE id=%s",
            (tid,),
        )
        cur.execute(
            """INSERT INTO agent_tasks (agent_id, task_id, assignment_status)
               VALUES (%s, %s, 'working')
               ON CONFLICT (agent_id, task_id) DO UPDATE SET assignment_status='working'""",
            (aid, tid),
        )
        _ack_events_handled(cur, aid, "task_assigned", "task_id", tid)
        _ack_events_handled(cur, aid, "task_ready", "task_id", tid)
        # #298 + mig 034: expose BOTH the container level+enforced flag AND this claiming agent's
        # EFFECTIVE level (additive — `autonomy_level` keeps its container-level meaning so no
        # existing consumer breaks). The worker keys its advisory gh/git behavior off
        # effective_autonomy — its own override (or the container level when enforced/inherit).
        cur.execute(
            "SELECT autonomy_level, autonomy_enforced FROM containers WHERE id=%s", (cid,)
        )
        c = cur.fetchone()
        autonomy_level = c["autonomy_level"]
        autonomy_enforced = c["autonomy_enforced"]
        cur.execute("SELECT autonomy_override FROM agents WHERE id=%s", (aid,))
        effective_level = effective_autonomy(
            autonomy_level, autonomy_enforced, cur.fetchone()["autonomy_override"]
        )
        bump_agent(cur, aid)
        recompute_agent_status(cur, aid)
        log_event(cur, cid, "ai", aid, "task", tid, "claimed", {"title": task["title"]})
        conn.commit()
    return {
        "task": {
            "id": tid,
            "title": task["title"],
            "description": task["description"],
            "definition_of_done": task["definition_of_done"],
            "priority": task["priority"],
            "protocol": task["protocol"],
        },
        "autonomy_level": autonomy_level,
        "autonomy_enforced": autonomy_enforced,
        "effective_autonomy": effective_level,
    }
