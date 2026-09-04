"""Persist human decisions and route their rationale to affected work."""

from fastapi import HTTPException, Request

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.decision_routing import _post_decision_to_thread
from portal_backend.events import publish_event
from portal_backend.guards import require_kind, valid_uuid
from portal_backend.identity_routes import trusted_actor
from portal_backend.schemas.agent_state import DecisionCreate


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
