"""Update the coordination protocol attached to a task."""

import json

from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import (
    reject_if_retired as _reject_if_retired,
    require_container_active as _require_container_active,
    require_kind as _require_kind,
    require_task as _require_task,
    valid_uuid as _valid_uuid,
)
from portal_backend.identity_routes import trusted_actor as _trusted_actor
from portal_backend.schemas import ProtocolUpdate


@app.patch("/api/tasks/{tid}/protocol", status_code=200)
def update_task_protocol(tid: str, body: ProtocolUpdate, request: Request):
    """SPEC-4: set/clear the per-task working agreement (review_chain, handoff_to, autonomy,
    notes). Audit-logged. Actor: a human OR a dispatching AI orchestrator (#327) — an AI may
    edit review_chain/handoff_to/notes (the coordination dials), but `autonomy` STAYS human-only:
    it's the human's risk dial, so an AI editing it would be self-granting privilege (403). PARTIAL
    update — only the keys explicitly sent are merged into the existing protocol; omitted keys are
    preserved; send "" to clear a key. Returns the full merged protocol so the panel re-renders."""
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        t = _require_task(cur, tid)
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        body.actor_agent_id = _trusted_actor(
            cur, request, str(t["container_id"]), body.actor_agent_id
        )
        actor = _require_kind(
            cur, body.actor_agent_id, ("human", "ai")
        )  # Orcha#30 + #327
        _require_container_active(
            cur, str(t["container_id"]), body.actor_agent_id
        )  # GH #24
        _reject_if_retired(cur, body.actor_agent_id)  # ISS-51

        # Only the keys the caller actually sent (exclude_unset) — minus the actor — are applied.
        changed = body.model_dump(exclude_unset=True)
        changed.pop("actor_agent_id", None)
        if not changed:
            raise HTTPException(400, "no protocol fields supplied")
        # #327: autonomy edits stay human-only — autonomy is the human's risk dial, so an AI
        # editing it would be self-granting privilege. AI may freely edit the coordination keys.
        if actor["kind"] != "human" and "autonomy" in changed:
            raise HTTPException(
                403, "autonomy is the human's risk dial — only a human may edit it"
            )

        cur.execute("SELECT protocol FROM tasks WHERE id=%s", (tid,))
        existing = cur.fetchone()["protocol"] or {}
        merged = {
            **existing,
            **changed,
        }  # partial merge; sent keys win, others preserved

        cur.execute(
            "UPDATE tasks SET protocol=%s::jsonb WHERE id=%s", (json.dumps(merged), tid)
        )
        log_event(
            cur,
            t["container_id"],
            actor["kind"],
            body.actor_agent_id,
            "task",
            tid,
            "protocol_updated",
            {"changed_keys": sorted(changed.keys())},
        )
        conn.commit()
    return {"task_id": tid, "protocol": merged}
