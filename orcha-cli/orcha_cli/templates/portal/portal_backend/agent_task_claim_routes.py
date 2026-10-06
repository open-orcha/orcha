"""Agent route for atomically claiming assigned ready work."""

from typing import Optional

from fastapi import Header, HTTPException, Request

from portal_backend.agent_status import bump_agent, log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend import sql
from portal_backend.autonomy import effective_autonomy
from portal_backend.budget_routes import agent_budget_block
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
    request: Request,
    x_orcha_run_token: Optional[str] = Header(default=None, alias="X-Orcha-Run-Token"),
):
    """Atomically claim the highest-priority READY task in this agent's container."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        agent = _require_agent(cur, aid)
        _require_work_lane(cur, aid, x_orcha_run_token, request)
        _require_kind(cur, aid, ("ai",))
        _reject_if_retired(cur, aid)
        cid = str(agent["container_id"])
        _require_container_active(cur, cid, aid)
        # Budget hard stop (KG-1): a budget-paused agent claims NO new task. A task it is
        # already working stays untouched (in-flight work is never stopped). A human-opened
        # live terminal (token kind 'live') is exempt, matching wake-claim.
        cur.execute(
            "SELECT kind FROM embodiment_tokens WHERE run_token=%s", (x_orcha_run_token,)
        )
        tok = cur.fetchone()
        if not (tok and tok["kind"] == "live"):
            budget_reason = agent_budget_block(cur, cid, aid)
            if budget_reason:
                conn.commit()
                return {
                    "task": None,
                    "message": "budget: " + budget_reason,
                    "budget_paused": True,
                }
        # GH #258 S4: the claim is ONE statement, so picking the task and flipping it to
        # in_progress can never interleave with another claimer. On SQLite the scope's
        # BEGIN IMMEDIATE serialises writers; on Postgres the sub-select's row lock (SKIP
        # LOCKED) sends a concurrent claimer on to the next ready task instead of the same one.
        # `status='ready'` is re-checked on the outer row as a belt-and-braces guard.
        cur.execute(
            f"""UPDATE tasks SET status='in_progress', started_at = COALESCE(started_at, now())
                WHERE status='ready' AND id = (
                  SELECT t.id FROM tasks t
                  JOIN agent_tasks at ON at.task_id = t.id AND at.agent_id = %s
                   AND at.assignment_status IN ('assigned','accepted','working')
                  WHERE t.container_id=%s AND t.status='ready' AND t.is_root = false
                  ORDER BY t.priority, t.created_at
                  LIMIT 1{sql.for_update(skip_locked=True)})
                RETURNING id, title, description, definition_of_done, priority, protocol""",
            (aid, cid),
        )
        task = cur.fetchone()
        if not task:
            conn.commit()
            return {"task": None, "message": "no ready tasks available"}
        tid = str(task["id"])
        cur.execute(
            """INSERT INTO agent_tasks (agent_id, task_id, assignment_status)
               VALUES (%s, %s, 'working')
               ON CONFLICT (agent_id, task_id) DO UPDATE SET assignment_status='working'""",
            (aid, tid),
        )
        _ack_events_handled(cur, aid, "task_assigned", "task_id", tid)
        _ack_events_handled(cur, aid, "task_ready", "task_id", tid)
        # #298 + mig 043: expose BOTH the container level+enforced flag AND this claiming agent's
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
