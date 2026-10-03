"""Manager review handoff API (mig 057).

GET/PUT /api/containers/{cid}/review-routing — the project setting "Finished work goes to"
(manager chain / project owner / anyone) + "AI managers pre-review before the human
verifies". Reads: any member. Writes: human only, owner-or-``assign_reviewers`` (deciding
who reviews is exactly that grant), audited as ``review_routing_changed``.

POST /api/tasks/{tid}/manager-review — the AI manager's structured pre-review verdict
(approve | send_back). The free-text path is POST /api/requests/{rid}/respond on the
pre-review request ("APPROVE: …" / "SEND BACK: …"). Either way it never verifies.
"""

from fastapi import HTTPException, Request

from portal_backend.agent_status import bump_agent, log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import (
    reject_if_retired,
    require_container,
    require_kind,
    require_task,
    valid_uuid,
)
from portal_backend.identity_routes import (
    enforce_grant,
    require_member_read,
    trusted_actor,
)
from portal_backend.review_routing import apply_manager_review, review_settings
from portal_backend.schemas.review_routing import (
    ManagerReviewDecision,
    ReviewRoutingResponse,
    ReviewRoutingUpdate,
)


def _payload(cur, cid: str) -> dict:
    s = review_settings(cur, cid)
    cur.execute(
        """SELECT count(*) AS n FROM agents
            WHERE container_id=%s AND terminated_at IS NULL
              AND reports_to_agent_id IS NOT NULL""",
        (cid,),
    )
    lines = int(cur.fetchone()["n"])
    cur.execute(
        """SELECT a.id, a.alias, count(t.id) AS n
             FROM tasks t JOIN agents a ON a.id = t.reviewer_agent_id
            WHERE t.container_id=%s AND t.status='needs_verification'
            GROUP BY a.id, a.alias ORDER BY a.alias""",
        (cid,),
    )
    reviewers = [
        {"agent_id": str(r["id"]), "alias": r["alias"], "pending_reviews": int(r["n"])}
        for r in cur.fetchall()
    ]
    return {"container_id": cid, **s, "reporting_lines": lines, "reviewers": reviewers}


@app.get("/api/containers/{cid}/review-routing", response_model=ReviewRoutingResponse)
def get_review_routing(cid: str, request: Request):
    """Where this project's finished work goes for verification."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
        return _payload(cur, cid)


@app.put("/api/containers/{cid}/review-routing", response_model=ReviewRoutingResponse)
def set_review_routing(cid: str, body: ReviewRoutingUpdate, request: Request):
    """Change where finished work goes / whether AI managers pre-review. Human only."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        enforce_grant(cur, request, cid, "assign_reviewers")
        actor = trusted_actor(cur, request, cid, body.actor_agent_id)
        require_kind(cur, actor, ("human",))
        before = review_settings(cur, cid)
        after = {
            "review_route": body.review_route or before["review_route"],
            "ai_manager_prereview": (
                before["ai_manager_prereview"]
                if body.ai_manager_prereview is None
                else body.ai_manager_prereview
            ),
        }
        cur.execute(
            "UPDATE containers SET review_route=%s, ai_manager_prereview=%s WHERE id=%s",
            (after["review_route"], after["ai_manager_prereview"], cid),
        )
        if after != before:
            log_event(cur, cid, "human", actor, "container", cid, "review_routing_changed",
                      {**after, "previous": before})
        out = _payload(cur, cid)
        conn.commit()
    return out


@app.post("/api/tasks/{tid}/manager-review", status_code=200)
def record_manager_review(tid: str, body: ManagerReviewDecision, request: Request):
    """The AI manager's pre-review verdict on a task routed to it. A RECOMMENDATION only:
    approve leaves the task at needs_verification for the human reviewer; send_back returns
    it to the assignee with the reasons. 403 unless the caller is the manager asked; 409
    when no pre-review is pending."""
    if not valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    if not valid_uuid(body.agent_id):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        t = require_task(cur, tid)
        cid = str(t["container_id"])
        actor = trusted_actor(cur, request, cid, body.agent_id)
        reject_if_retired(cur, actor)
        cur.execute(
            "SELECT id, container_id, status, title, manager_review FROM tasks "
            "WHERE id=%s FOR UPDATE",
            (tid,),
        )
        row = cur.fetchone()
        mr = row["manager_review"] or {}
        if str(mr.get("manager_agent_id")) != str(actor):
            raise HTTPException(403, "only the manager this pre-review was sent to may record it")
        if mr.get("status") != "pending" or row["status"] != "needs_verification":
            raise HTTPException(
                409,
                f"no pending manager pre-review (task is '{row['status']}', "
                f"pre-review is '{mr.get('status')}')",
            )
        out = apply_manager_review(cur, row, actor, body.decision, body.reasons)
        bump_agent(cur, actor)
        conn.commit()
    return out
