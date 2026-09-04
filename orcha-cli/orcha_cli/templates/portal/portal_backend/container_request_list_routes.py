"""Serve filtered, paginated container request lists."""

from typing import Any, Optional

from fastapi import HTTPException, Query, Request

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.identity_routes import require_member_read
from portal_backend.list_sorting import sort_clause, validate_sort
from portal_backend.request_ownership import _annotate_request_ownership

REQUEST_STATUSES = {
    "open",
    "accepted",
    "rejected",
    "answered",
    "converted_to_task",
    "closed",
}


@app.get("/api/containers/{cid}/requests")
def list_container_requests(
    cid: str,
    request: Request,
    limit: int = 15,
    offset: int = 0,
    agent: Optional[str] = None,
    direction: Optional[str] = None,
    status: Optional[str] = None,
    sort: Optional[str] = None,
    sort_dir: Optional[str] = Query(default=None, alias="dir"),
):
    """ISS-68: paginated request rows for lazy list loading. Status order per Kedar's spec:
    open → answered → closed, then priority, created_at DESC, id (id = stable tiebreaker so
    repeat calls / page boundaries return the SAME window — without it, rows tied on
    (status,priority,created_at) ordered non-deterministically). `agent`+`direction` scopes to the
    agent-detail lists ('in' = addressed to the agent/target; 'out' = raised by it/requester;
    omitted = either side). `status` (optional) filters to one lifecycle state — without it the
    list mixes open+answered+closed, so a caller using this as a census of e.g. open requests
    would silently get closed rows in the window. Same row shape as the snapshot's requests[]
    (drop-in), just paginated + reordered. Returns {requests, total, has_more}."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if agent is not None and not valid_uuid(agent):
        raise HTTPException(400, "agent is not a valid UUID")
    if direction is not None and direction not in ("in", "out"):
        raise HTTPException(400, "direction must be 'in' or 'out'")
    if status is not None and status not in REQUEST_STATUSES:
        raise HTTPException(400, "status is not a recognized request status")
    validate_sort(sort, sort_dir)
    limit = max(1, min(limit, 100))
    offset = max(0, offset)
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        # Access model: reads are project-isolated (trusted non-member 403).
        require_member_read(cur, request, cid)
        where = "container_id = %s"
        params: list[Any] = [cid]
        if agent and direction == "in":
            where += " AND target_id = %s"
            params.append(agent)
        elif agent and direction == "out":
            where += " AND requester_id = %s"
            params.append(agent)
        elif agent:
            where += " AND (target_id = %s OR requester_id = %s)"
            params.extend([agent, agent])
        if status is not None:
            where += " AND status = %s"
            params.append(status)
        cur.execute(f"SELECT count(*) AS n FROM requests WHERE {where}", tuple(params))
        total = cur.fetchone()["n"]
        default_order = (
            "ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END, "
            "priority, created_at DESC, id"
        )
        order = sort_clause(
            sort,
            sort_dir,
            bucket="CASE status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END",
            time_col="created_at",
            prio_col="priority",
            id_col="id",
            default=default_order,
        )
        cur.execute(
            f"""SELECT id, type, status, priority, requester_id, target_id,
                       payload, response, rejection_reason, spawned_task_id,
                       expires_at, created_at, responded_at, closed_at,
                       parent_request_id, chain_depth, detail,
                       (SELECT json_build_object('task_id', st.id, 'title', st.title, 'status', st.status)
                          FROM tasks st WHERE st.id = requests.spawned_task_id) AS task_link,
                       (SELECT a.alias FROM agents a
                          WHERE a.id = CASE requests.status WHEN 'open' THEN requests.target_id
                                                            WHEN 'answered' THEN requests.requester_id END)
                         AS owner_alias
                FROM requests WHERE {where} {order} LIMIT %s OFFSET %s""",
            (*params, limit, offset),
        )
        rows = _annotate_request_ownership(cur.fetchall())
    return {
        "requests": rows,
        "total": total,
        "has_more": offset + len(rows) < total,
    }
