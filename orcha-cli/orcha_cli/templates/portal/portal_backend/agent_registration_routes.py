"""Agent registration route and optional first-task creation."""

import psycopg
from fastapi import HTTPException, Request

from portal_backend.agent_status import bump_agent, log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container as _require_container
from portal_backend.guards import valid_uuid as _valid_uuid
from portal_backend.identity_routes import enforce_grant as _enforce_grant
from portal_backend.identity_routes import trusted_actor as _trusted_actor
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
def register_agent(cid: str, body: AgentCreate, request: Request):
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
        # Per-project identity: once this container has a mapped member, only members
        # may create agents through the trusted browser lane (403 otherwise). The
        # fresh-container bootstrap (no mapped human yet — `orcha init` / onboarding)
        # passes through, mirroring the binding rule's NOT-EXISTS guard.
        _trusted_actor(cur, request, cid, None)
        # Access model: registering agents is owner-or-manage_agents (trusted lane;
        # the CLI's headerless `orcha init` registration is untouched).
        _enforce_grant(cur, request, cid, "manage_agents")
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
        # PR attribution (docs/agent-prs.md): a human may register with their GitHub
        # handle + preferred git author email so agent-opened PRs on their tasks can
        # @mention them and carry a Co-authored-by trailer. Humans only — an AI row
        # carrying a handle would masquerade as a person in the attribution chain.
        github_login = body.github_login if body.kind == "human" else None
        git_email = body.git_email if body.kind == "human" else None
        try:
            # Collab v1: a container's FIRST live human is its owner (the same invariant
            # migration 036 backfills for pre-existing rows) — otherwise a fresh container
            # would have nobody who can pass the owner gates (members, reviewer). Later
            # humans join as plain members; owners promote them deliberately.
            cur.execute(
                """INSERT INTO agents (container_id, alias, role, kind, system_prompt, model,
                                       github_login, git_email, member_role)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s,
                           CASE WHEN %s = 'human' AND NOT EXISTS (
                                    SELECT 1 FROM agents
                                     WHERE container_id=%s AND kind='human'
                                       AND terminated_at IS NULL)
                                THEN 'owner' ELSE 'member' END)
                   RETURNING id""",
                (cid, body.alias, body.role, body.kind, body.prompt, model,
                 github_login, git_email, body.kind, cid),
            )
        except psycopg.errors.UniqueViolation as exc:
            # Two unique surfaces can trip here: (container_id, alias) and the
            # 036 partial index on (container_id, lower(github_login)).
            constraint = (exc.diag.constraint_name or "") if exc.diag else ""
            if "github_login" in constraint:
                raise HTTPException(
                    409,
                    f"github_login '{github_login}' already maps to another member "
                    "of this container",
                )
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
