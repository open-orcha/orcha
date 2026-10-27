"""Persist human decisions and route their rationale to affected work."""

from fastapi import HTTPException, Request

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.decision_routing import _post_decision_to_thread
from portal_backend.events import publish_event
from portal_backend.guards import require_kind, require_task, valid_uuid
from portal_backend.identity_routes import trusted_actor
from portal_backend.schemas.agent_state import DecisionCreate
from portal_backend.task_list_query import PLAN_CUTOFF_SQL, PLAN_ROUND_ORDER_SQL, plan_candidate_sql
from portal_backend.task_autonomy_service import record_approval
from portal_backend.task_approval_policy import ApprovalPhase


@app.post("/api/decisions", status_code=201)
def create_decision(body: DecisionCreate, request: Request):
    reason = (body.reason or "").strip()
    if body.decision == "reject" and not reason:
        raise HTTPException(
            422,
            {
                "error": "reason_required",
                "detail": "a reason is required when decision is 'reject'",
            },
        )
    if body.target_agent_id is not None and not valid_uuid(body.target_agent_id):
        raise HTTPException(400, "target_agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        if body.subject_type == "plan_approval":
            if not valid_uuid(body.subject_id):
                raise HTTPException(400, "task_id is not a valid UUID")
            task = require_task(cur, body.subject_id)
            if task["workflow_id"]:
                # Workflow plan approval is a workflow write: use the same hosted
                # or local selected-human lane as every workflow route, then
                # validate live non-viewer membership server-side.
                from portal_backend.workflow_routes import resolve_human_actor

                body.actor_agent_id = resolve_human_actor(
                    cur,
                    request,
                    str(task["container_id"]),
                    claimed_actor_id=body.actor_agent_id,
                ).id
            else:
                body.actor_agent_id = trusted_actor(
                    cur, request, str(task["container_id"]), body.actor_agent_id
                )
            require_kind(cur, body.actor_agent_id, ("human",))
            cur.execute("SELECT container_id FROM agents WHERE id=%s", (body.actor_agent_id,))
            if str(cur.fetchone()["container_id"]) != str(task["container_id"]):
                raise HTTPException(403, "plan decision actor must belong to the task's container")
            # Resolve the SAME current plan shown by the task card. Older clients may
            # still send the coordinator's id (or omit a target entirely).
            cur.execute(
                f"""SELECT m.author_id,m.body FROM tasks t
                    CROSS JOIN (SELECT {PLAN_CUTOFF_SQL} AS c FROM tasks t WHERE t.id=%s) pc
                    JOIN task_messages m ON m.task_id=t.id
                    JOIN agents ma ON ma.id=m.author_id
                    WHERE t.id=%s AND ma.kind <> 'human' AND {plan_candidate_sql('m')}
                      AND m.created_at > pc.c
                    ORDER BY {PLAN_ROUND_ORDER_SQL} LIMIT 1""",
                (body.subject_id, body.subject_id),
            )
            plan = cur.fetchone()
            if plan:
                body.target_agent_id = str(plan["author_id"])
            else:
                # Existing API callers can decide before posting a plan. Route to
                # the responsible assignee rather than an arbitrary client target.
                cur.execute(
                    "SELECT a.id FROM agent_tasks at JOIN agents a ON a.id=at.agent_id "
                    "WHERE at.task_id=%s AND a.kind <> 'human' ORDER BY a.alias LIMIT 1",
                    (body.subject_id,),
                )
                owner = cur.fetchone()
                body.target_agent_id = str(owner["id"]) if owner else None
        # The decision lands in the TARGET's container when a target is named, else the
        # actor's. Resolve that container FIRST so the per-project identity rule binds
        # the actor against the project actually affected (403 for a non-member).
        target = None
        if body.target_agent_id is not None:
            cur.execute(
                "SELECT container_id FROM agents WHERE id=%s",
                (body.target_agent_id,),
            )
            target = cur.fetchone()
            if not target:
                raise HTTPException(
                    404, f"target agent {body.target_agent_id} not found"
                )
        if target is not None:
            gate_cid = target["container_id"]
        else:
            require_kind(cur, body.actor_agent_id, ("human",))
            cur.execute(
                "SELECT container_id FROM agents WHERE id=%s", (body.actor_agent_id,)
            )
            gate_cid = cur.fetchone()["container_id"]
        body.actor_agent_id = trusted_actor(
            cur, request, str(gate_cid), body.actor_agent_id
        )
        require_kind(cur, body.actor_agent_id, ("human",))
        cur.execute(
            "SELECT container_id FROM agents WHERE id=%s", (body.actor_agent_id,)
        )
        container_id = cur.fetchone()["container_id"]
        if target is not None:
            container_id = target["container_id"]
        cur.execute(
            """INSERT INTO decisions
                 (container_id, subject_type, subject_id, decision, reason,
                  actor_agent_id, target_agent_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s)
               RETURNING id, created_at""",
            (
                container_id,
                body.subject_type,
                body.subject_id,
                body.decision,
                reason or None,
                body.actor_agent_id,
                body.target_agent_id,
            ),
        )
        row = cur.fetchone()
        decision_id = str(row["id"])
        if (
            body.subject_type == "plan_approval"
            and body.decision == "approve"
            and plan
        ):
            record_approval(
                cur,
                task,
                body.actor_agent_id,
                ApprovalPhase.PLAN,
                plan["body"],
                human_review_authorized=True,
                permission_source="human_plan_decision",
            )
        if body.target_agent_id is not None:
            publish_event(
                cur,
                str(container_id) if container_id else None,
                str(body.target_agent_id),
                "decision_made",
                {
                    "decision_id": decision_id,
                    "subject_type": body.subject_type,
                    "subject_id": body.subject_id,
                    "decision": body.decision,
                    "reason": reason or None,
                },
            )
        _post_decision_to_thread(
            cur,
            body.subject_type,
            body.subject_id,
            body.decision,
            reason or None,
            body.actor_agent_id,
        )
    return {
        "decision_id": decision_id,
        "decision": body.decision,
        "reason": reason or None,
        "subject_type": body.subject_type,
        "subject_id": body.subject_id,
        "target_agent_id": body.target_agent_id,
        "created_at": row["created_at"].isoformat(),
    }


@app.get("/api/decisions/{did}")
def get_decision(did: str):
    if not valid_uuid(did):
        raise HTTPException(400, "decision_id is not a valid UUID")
    with db_cursor() as (_, cur):
        cur.execute(
            """SELECT id, container_id, subject_type, subject_id, decision, reason,
                      actor_agent_id, target_agent_id, created_at
               FROM decisions WHERE id=%s""",
            (did,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, f"decision {did} not found")
    return {
        "decision_id": str(row["id"]),
        "container_id": str(row["container_id"]) if row["container_id"] else None,
        "subject_type": row["subject_type"],
        "subject_id": row["subject_id"],
        "decision": row["decision"],
        "reason": row["reason"],
        "actor_agent_id": str(row["actor_agent_id"]),
        "target_agent_id": (
            str(row["target_agent_id"]) if row["target_agent_id"] else None
        ),
        "created_at": row["created_at"].isoformat(),
    }
