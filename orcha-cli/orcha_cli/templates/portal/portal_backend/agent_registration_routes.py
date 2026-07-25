"""Agent registration route and optional first-task creation."""

import psycopg
from fastapi import HTTPException

from portal_backend.agent_status import bump_agent, log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container as _require_container
from portal_backend.guards import valid_uuid as _valid_uuid
from portal_backend.model_policy import DEFAULT_MODEL
from portal_backend.schemas import AgentCreate, AgentCreateResponse


def _model_ids():
    return set()


def configure_model_ids(model_ids):
    """Supply the facade-owned model-id getter used by compatibility tests."""
    global _model_ids
    _model_ids = model_ids


@app.post(
    "/api/containers/{cid}/agents",
    response_model=AgentCreateResponse,
    status_code=201,
)
def register_agent(cid: str, body: AgentCreate):
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if body.kind == "ai" and not (body.prompt and body.prompt.strip()):
        raise HTTPException(
            400, "kind='ai' requires a non-empty `prompt` (the system prompt)"
        )
    if body.kind == "human" and body.initial_task is not None:
        raise HTTPException(
            400, "humans don't get an initial_task — they pick work deliberately"
        )
    with db_cursor() as (conn, cur):
        _require_container(cur, cid)
        model = body.model
        if body.kind == "human":
            model = None
        elif not model:
            model = DEFAULT_MODEL
        elif model not in _model_ids():
            raise HTTPException(
                400,
                f"model '{model}' is not a known model; choose one of {sorted(_model_ids())}",
            )
        try:
            cur.execute(
                """INSERT INTO agents (container_id, alias, role, kind, system_prompt, model)
                   VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
                (cid, body.alias, body.role, body.kind, body.prompt, model),
            )
        except psycopg.errors.UniqueViolation:
            raise HTTPException(
                409, f"alias '{body.alias}' already registered in this container"
            )
        aid = str(cur.fetchone()["id"])
        log_event(
            cur,
            cid,
            "human",
            None,
            "agent",
            aid,
            "created",
            {"alias": body.alias, "role": body.role, "kind": body.kind},
        )
        initial = None
        if body.initial_task is not None:
            task = body.initial_task
            cur.execute(
                """INSERT INTO tasks
                     (container_id, title, description, definition_of_done,
                      status, priority, created_by_agent_id, started_at)
                   VALUES (%s, %s, %s, %s, 'in_progress', %s, NULL, now())
                   RETURNING id""",
                (
                    cid,
                    task.title,
                    task.description,
                    task.definition_of_done,
                    task.priority,
                ),
            )
            tid = str(cur.fetchone()["id"])
            cur.execute(
                """INSERT INTO agent_tasks (agent_id, task_id, assignment_status)
                   VALUES (%s, %s, 'working')""",
                (aid, tid),
            )
            bump_agent(cur, aid)
            recompute_agent_status(cur, aid)
            log_event(
                cur,
                cid,
                "human",
                None,
                "task",
                tid,
                "created",
                {"title": task.title, "assigned_to": body.alias},
            )
            log_event(
                cur,
                cid,
                "ai",
                aid,
                "task",
                tid,
                "claimed",
                {"via": "initial_task on register"},
            )
            initial = {"task_id": tid, "title": task.title, "status": "in_progress"}
        conn.commit()
    return AgentCreateResponse(
        agent_id=aid,
        alias=body.alias,
        container_id=cid,
        initial_task=initial,
    )
