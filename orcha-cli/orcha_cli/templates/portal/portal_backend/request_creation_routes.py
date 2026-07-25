"""Create information or delegated-work requests and publish their wake event."""

import json
from typing import Optional

from fastapi import HTTPException

from portal_backend.agent_status import bump_agent, log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import (
    agent_participates_in_task as _agent_participates_in_task,
    pick_human as _pick_human,
    reject_if_retired as _reject_if_retired,
    require_agent as _require_agent,
    require_container_active as _require_container_active,
    resolve_alias as _resolve_alias,
    valid_uuid as _valid_uuid,
)
from portal_backend.limits import MAX_DOD_LEN, MAX_NAME_LEN
from portal_backend.request_classification import classify_request_type
from portal_backend.schemas.requests import RequestCreate, TaskRequestPayload


@app.post("/api/containers/{cid}/requests", status_code=201)
def create_request(cid: str, body: RequestCreate):
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not _valid_uuid(body.requester_agent_id):
        raise HTTPException(400, "requester_agent_id is not a valid UUID")

    with db_cursor() as (conn, cur):
        _require_container_active(
            cur, cid, body.requester_agent_id
        )  # GH #24 (was _require_container)
        req_ag = _require_agent(cur, body.requester_agent_id)
        _reject_if_retired(cur, body.requester_agent_id)  # ISS-51 [P1]
        if str(req_ag["container_id"]) != cid:
            raise HTTPException(
                400, "requester_agent_id belongs to a different container"
            )

        target_id: Optional[str] = None
        target_alias: Optional[str] = None
        if body.target_agent_id and body.target_alias:
            raise HTTPException(
                400, "specify target_agent_id OR target_alias, not both"
            )
        if body.target_agent_id:
            if not _valid_uuid(body.target_agent_id):
                raise HTTPException(400, "target_agent_id is not a valid UUID")
            tg = _require_agent(cur, body.target_agent_id)
            if str(tg["container_id"]) != cid:
                raise HTTPException(400, "target agent in a different container")
            target_id = body.target_agent_id
            target_alias = tg["alias"]
        elif body.target_alias:
            target_id = _resolve_alias(cur, cid, body.target_alias)
            target_alias = body.target_alias
        else:
            # Orcha#30: no target specified == escalate-to-human at birth.
            # We never write NULL into requests.target_id anymore; pick the human row.
            target_id = _pick_human(cur, cid)

        # parent_request_id handling (Orcha#1: request chains)
        parent_request_id: Optional[str] = None
        chain_depth: int = 0
        if body.parent_request_id:
            if not _valid_uuid(body.parent_request_id):
                raise HTTPException(400, "parent_request_id is not a valid UUID")
            cur.execute(
                "SELECT container_id, chain_depth, status, target_id "
                "FROM requests WHERE id=%s",
                (body.parent_request_id,),
            )
            parent = cur.fetchone()
            if not parent:
                raise HTTPException(
                    404, f"parent request {body.parent_request_id} not found"
                )
            if str(parent["container_id"]) != cid:
                raise HTTPException(
                    400, "parent request belongs to a different container"
                )
            # parent should ideally be open or answered — closed parents make the chain meaningless
            if parent["status"] in ("closed", "rejected"):
                raise HTTPException(
                    409,
                    f"parent request is '{parent['status']}' — no point chaining off a finished request",
                )
            parent_request_id = body.parent_request_id
            chain_depth = (parent["chain_depth"] or 0) + 1

        # GH #56 (Point 3, FLAG 2b): validate a SUPPLIED originating_task_id before storing.
        # Null always passes untouched (conversation / taskless asks). When present it must be a
        # real task in THIS container that the requester participates in — a typo or an id pasted
        # from another project would otherwise route the answer's wake to nothing or the wrong
        # task, silently. Uses the looser participant check (not exact-one-in-progress).
        originating_task_id: Optional[str] = None
        if body.originating_task_id is not None:
            if not _valid_uuid(body.originating_task_id):
                raise HTTPException(400, "originating_task_id is not a valid UUID")
            if not _agent_participates_in_task(
                cur, cid, body.requester_agent_id, body.originating_task_id
            ):
                raise HTTPException(
                    400,
                    "originating_task_id must be a task in this container that the requester "
                    "participates in (owns/assignee/creator/collaborator)",
                )
            originating_task_id = body.originating_task_id

        # GH #71: AUTO-PROMOTE info-that-is-really-work to a task BEFORE the type branch,
        # so we never insert a task-type row with task=None (the 400 contract below is kept
        # for genuine caller errors). Only runs when the caller sent the DEFAULT type='info'
        # with NO task object — an explicit type='task' honors the caller and SKIPS the
        # classifier (binding answer #4). On a "task" verdict we synthesize a minimal
        # TaskRequestPayload (title = first line of payload truncated; dod = the payload;
        # priority = the request priority) and route it through the SAME task-detail build
        # path below, then stamp the audit fields onto `detail`.
        effective_type = body.type
        effective_task = body.task
        promoted_verb: Optional[str] = None
        if body.type == "info" and body.task is None:
            verdict, matched_verb = classify_request_type(body.payload)
            if verdict == "task":
                effective_type = "task"
                promoted_verb = matched_verb
                first_line = body.payload.strip().splitlines()[0].strip()
                synth_title = (
                    first_line[:MAX_NAME_LEN] if first_line else "(promoted request)"
                )
                effective_task = TaskRequestPayload(
                    title=synth_title,
                    definition_of_done=body.payload[:MAX_DOD_LEN],
                    priority=body.priority,
                )

        # Phase 3 (Orcha#5): type='task' carries a TaskRequestPayload in body.task
        # which gets stuffed into the JSONB `detail` column. The task itself is
        # only created on /accept-task.
        detail: Optional[dict] = None
        if effective_type == "task":
            if effective_task is None:
                raise HTTPException(
                    400,
                    "type='task' requires a `task` object (title, definition_of_done, priority)",
                )
            detail = {
                "title": effective_task.title,
                "description": effective_task.description,
                "definition_of_done": effective_task.definition_of_done,
                "priority": effective_task.priority,
            }
            # GH #55: carry the optional protocol through the request so the spawned task
            # inherits its loop rules on accept (only the keys actually set are stored).
            if effective_task.protocol is not None:
                proto_fields = effective_task.protocol.model_dump(exclude_none=True)
                if proto_fields:
                    detail["protocol"] = proto_fields
            # GH #71: audit stamp on a promoted request so the provenance is visible in `detail`.
            if promoted_verb is not None:
                detail["promoted_from_info"] = True
                detail["matched_verb"] = promoted_verb
        elif effective_task is not None:
            raise HTTPException(400, "`task` field is only valid with type='task'")

        cur.execute(
            """INSERT INTO requests
                 (container_id, type, requester_id, target_id, priority, status,
                  payload, expires_at, parent_request_id, chain_depth, detail,
                  originating_task_id)
               VALUES (%s, %s, %s, %s, %s, 'open', %s,
                       now() + (%s || ' minutes')::interval, %s, %s, %s::jsonb, %s)
               RETURNING id, expires_at""",
            (
                cid,
                effective_type,
                body.requester_agent_id,
                target_id,
                body.priority,
                body.payload,
                str(body.expires_minutes),
                parent_request_id,
                chain_depth,
                json.dumps(detail) if detail is not None else None,
                originating_task_id,
            ),
        )
        row = cur.fetchone()
        rid = str(row["id"])
        bump_agent(cur, body.requester_agent_id)
        recompute_agent_status(cur, body.requester_agent_id)  # → awaiting_request
        log_event(
            cur,
            cid,
            "ai",
            body.requester_agent_id,
            "request",
            rid,
            "created",
            {
                "type": effective_type,
                "target_alias": target_alias,
                "priority": body.priority,
                "preview": body.payload[:120],
                "parent_request_id": parent_request_id,
                "chain_depth": chain_depth,
                "task_title": detail["title"] if detail else None,
                "promoted_from_info": promoted_verb is not None,
            },
        )  # GH #71
        _publish_event(
            cur,
            cid,
            target_id,
            "request_created",
            {
                "request_id": rid,
                "type": effective_type,
                "from_agent_id": body.requester_agent_id,
                "preview": body.payload[:120],
            },
        )
        conn.commit()

    return {
        "request_id": rid,
        "type": effective_type,  # GH #71: reflects auto-promotion (info → task) when it fired
        "status": "open",
        "target_alias": target_alias,  # null when the request was born already targeting the human (Orcha#30)
        "expires_at": row["expires_at"].isoformat(),
        "parent_request_id": parent_request_id,
        "chain_depth": chain_depth,
        "originating_task_id": originating_task_id,  # GH #56: task the answer's wake will attach to (or null)
        "task": detail,  # null for info; full task body for type='task'
    }
