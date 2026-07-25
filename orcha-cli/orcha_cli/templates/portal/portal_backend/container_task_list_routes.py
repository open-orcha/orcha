"""Serve filtered, paginated container task lists."""

from typing import Any, Optional

from fastapi import HTTPException, Query

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.list_sorting import sort_clause, validate_sort
from portal_backend.task_list_query import _task_list_sql


@app.get("/api/containers/{cid}/tasks")
def list_container_tasks(
    cid: str,
    limit: int = 10,
    offset: int = 0,
    agent: Optional[str] = None,
    status: Optional[str] = None,
    unassigned: Optional[bool] = None,
    sort: Optional[str] = None,
    sort_dir: Optional[str] = Query(default=None, alias="dir"),
):
    """ISS-68: paginated TRIMMED task rows for lazy list loading. Default order per Kedar's
    spec: waiting (needs_verification) → in_progress → the rest, then priority, created_at.
    `agent` (uuid) scopes to that agent's assigned tasks (agent-detail current-tasks list).
    Returns {tasks, total, has_more} — `total` lets the UI gate the 'load more' affordance.

    #326 (B1): additive filters make this a first-class READY-QUEUE view so the orchestrator reads
    its live queue in ONE cheap query instead of pulling the whole list and filtering client-side:
      `status`     — exact status filter (e.g. 'ready'); a 'not_ready' held task is naturally absent.
      `unassigned` — true → only tasks with NO active assignee (owner==null).
      `sort=priority` — order strictly by priority, created_at (drops the status-bucket ordering).
    The canonical queue read is `?status=ready&unassigned=true&sort=priority`.

    ISS-331: optional `sort=priority|time` + `dir=asc|desc`. `sort=time` re-orders the SORTABLE key
    within the (unchanged) status bucket; `sort=priority` keeps #326's bucket-free strict-priority
    queue ordering and additionally honors `dir`. All optional and back-compatible: omit them and the
    legacy bucket ordering is unchanged, byte-identical."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if agent is not None and not valid_uuid(agent):
        raise HTTPException(400, "agent is not a valid UUID")
    validate_sort(sort, sort_dir)
    limit = max(1, min(limit, 100))
    offset = max(0, offset)
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        where = "t.container_id = %s"
        params: list[Any] = [cid]
        if agent:
            where += " AND EXISTS (SELECT 1 FROM agent_tasks at WHERE at.task_id = t.id AND at.agent_id = %s)"
            params.append(agent)
        if status:
            where += " AND t.status = %s"
            params.append(status)
        if unassigned:
            where += (
                " AND t.is_root = false"
                " AND NOT EXISTS (SELECT 1 FROM agent_tasks at WHERE at.task_id = t.id "
                "AND at.assignment_status IN ('assigned','accepted','working'))"
            )
        cur.execute(f"SELECT count(*) AS n FROM tasks t WHERE {where}", tuple(params))
        total = cur.fetchone()["n"]
        default_order = (
            "ORDER BY CASE t.status WHEN 'needs_verification' THEN 0 "
            "WHEN 'in_progress' THEN 1 ELSE 2 END, t.priority, t.created_at"
        )
        if sort == "priority":
            direction = "DESC" if sort_dir == "desc" else "ASC"
            order = f"ORDER BY t.priority {direction}, t.created_at"
        else:
            order = sort_clause(
                sort,
                sort_dir,
                bucket="CASE t.status WHEN 'needs_verification' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END",
                time_col="t.created_at",
                prio_col="t.priority",
                id_col="t.id",
                default=default_order,
            )
        cur.execute(_task_list_sql(where, order), (*params, limit, offset))
        tasks = cur.fetchall()
    return {
        "tasks": tasks,
        "total": total,
        "has_more": offset + len(tasks) < total,
    }
