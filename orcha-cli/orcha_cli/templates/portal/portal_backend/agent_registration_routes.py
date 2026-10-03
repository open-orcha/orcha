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


def _lock_pickable_task(cur, cid: str, tid: str):
    """P-10: lock and validate an existing task the new agent should start on: same
    project, not the root, status 'ready' and no active assignee. Anything else is a 409
    so the client never silently creates a duplicate or steals someone's work."""
    cur.execute(
        """SELECT id, title, status, is_root, container_id FROM tasks
           WHERE id=%s FOR UPDATE""",
        (tid,),
    )
    row = cur.fetchone()
    if not row or str(row["container_id"]) != cid:
        raise HTTPException(404, f"task {tid} not found in this project")
    if row["is_root"]:
        raise HTTPException(409, "the root task cannot be picked as a first task")
    if row["status"] != "ready":
        raise HTTPException(
            409, f"task is '{row['status']}' — only a ready task can be picked"
        )
    cur.execute(
        """SELECT 1 FROM agent_tasks WHERE task_id=%s
             AND assignment_status IN ('assigned','accepted','working') LIMIT 1""",
        (tid,),
    )
    if cur.fetchone():
        raise HTTPException(409, "task already has an active assignee")
    return row


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
    if body.kind == "human" and (
        body.initial_task is not None or body.initial_task_id is not None
    ):
        raise HTTPException(
            400, "humans don't get an initial_task — they pick work deliberately"
        )
    if body.initial_task is not None and body.initial_task_id is not None:
        raise HTTPException(
            400, "pass either initial_task (a new task) or initial_task_id (an existing one), not both"
        )
    if body.initial_task_id is not None and not _valid_uuid(body.initial_task_id):
        raise HTTPException(400, "initial_task_id is not a valid UUID")
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
        picked = None
        if body.initial_task_id is not None:
            picked = _lock_pickable_task(cur, cid, body.initial_task_id)
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
        elif picked is not None:
            # P-10: the picked EXISTING task becomes this agent's first task — same end
            # state as initial_task (in_progress + working), but no duplicate row.
            tid = str(picked["id"])
            cur.execute(
                "UPDATE tasks SET status='in_progress', started_at=now() WHERE id=%s",
                (tid,),
            )
            cur.execute(
                """INSERT INTO agent_tasks (agent_id, task_id, assignment_status)
                   VALUES (%s, %s, 'working')
                   ON CONFLICT (agent_id, task_id) DO UPDATE SET assignment_status='working'""",
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
                "assigned",
                {"agent_id": aid, "alias": body.alias, "status": "in_progress",
                 "via": "initial_task_id on register"},
            )
            log_event(
                cur,
                cid,
                "ai",
                aid,
                "task",
                tid,
                "claimed",
                {"via": "initial_task_id on register"},
            )
            initial = {"task_id": tid, "title": picked["title"], "status": "in_progress"}
        conn.commit()
    return AgentCreateResponse(
        agent_id=aid,
        alias=body.alias,
        container_id=cid,
        initial_task=initial,
    )
