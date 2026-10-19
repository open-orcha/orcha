"""GH #301 follow-up: say in the chat why a conversation worker cannot start, and let a
human ask for the one safe, project-local Git setup that unblocks it.

The notifier's startup check (``notifier_startup_preflight``) refuses to start a chat
worker when the project folder has no repository of its own (it sits inside someone
else's, e.g. an empty ``~/Documents`` repository) or its own repository has no first
commit. It stores the plain-language reason on the ``woken`` audit row. This module turns
the newest such row into ``startup_blocked`` on the conversation reads, so the chat can
show a lasting explanation instead of "answered on the next wake", and records a human's
explicit setup request for the notifier to carry out. Nothing here touches the project
folder: the notifier runs on the host and does the Git work, only after that click.
"""

import json

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field

from portal_backend import sql
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_agent as _require_agent
from portal_backend.guards import require_kind as _require_kind
from portal_backend.guards import valid_uuid as _valid_uuid
from portal_backend.identity_routes import trusted_actor as _trusted_actor
from portal_backend.schemas.conversations import ConversationActor

# The wake-ack kinds the startup check reports for Claude and Codex chat workers.
STARTUP_FAILED_KINDS = ("resident_failed", "codex_conversation_failed")
# Blockers the project-local setup can fix (the others need a person at the folder).
SETUP_BLOCKERS = ("ancestor_repo", "no_commit")
SETUP_REQUESTED = "startup_setup_requested"
SETUP_RESULT = "startup_setup_result"


class RepositorySetupResult(BaseModel):
    ok: bool
    detail: str = Field(..., max_length=1000)
    requested_at: float | None = None


def _payload(raw) -> dict:
    if isinstance(raw, str):
        try:
            return json.loads(raw) or {}
        except ValueError:
            return {}
    return raw or {}


def _agent_events(cur, aid, event_types, limit):
    cur.execute(
        f"""SELECT event_type, detail, {sql.epoch('created_at')} AS at FROM events
           WHERE entity_type='agent' AND entity_id=%s AND {sql.in_list('event_type')}
           ORDER BY created_at DESC, id DESC LIMIT %s""",
        (str(aid), sql.list_param(list(event_types)), limit),
    )
    return [
        {"type": r["event_type"], "detail": _payload(r["detail"]), "at": float(r["at"])}
        for r in cur.fetchall()
    ]


def setup_status(cur, aid) -> dict | None:
    """The newest setup request and its outcome: requested (the notifier has not
    reported yet), done or failed. None when nobody asked."""
    rows = _agent_events(cur, aid, (SETUP_REQUESTED, SETUP_RESULT), 2)
    if not rows:
        return None
    newest = rows[0]
    if newest["type"] == SETUP_REQUESTED:
        return {"state": "requested", "at": newest["at"]}
    return {
        "state": "done" if newest["detail"].get("ok") else "failed",
        "detail": newest["detail"].get("detail"),
        "at": newest["at"],
    }


def pending_setup_request(cur, aid) -> float | None:
    """When a human asked for setup that the notifier has not reported on yet."""
    status = setup_status(cur, aid)
    return status["at"] if status and status["state"] == "requested" else None


def startup_block(cur, aid, conversation) -> dict | None:
    """Why this chat's newest message is not being answered, when startup is blocked.

    Shown only while the last turn is the human's and no conversation worker has started
    since the newest blocked attempt, so it clears by itself once the project is fixed
    (inside or outside Orcha) and the waiting message is picked up.
    """
    if not conversation or conversation.get("status") != "active":
        return None
    cur.execute(
        "SELECT role FROM conversation_turns WHERE conversation_id=%s "
        "ORDER BY seq DESC LIMIT 1",
        (conversation["id"],),
    )
    last = cur.fetchone()
    if not last or last["role"] != "human":
        return None
    block = None
    for row in _agent_events(cur, aid, ("woken",), 25):
        d = row["detail"]
        if (
            d.get("lane") == "conversation"
            and d.get("kind") in STARTUP_FAILED_KINDS
            and d.get("detail")
        ):
            block = row
            break
    if block is None:
        return None
    cur.execute(
        f"""SELECT 1 FROM worker_runs WHERE agent_id=%s AND lane='conversation'
             AND {sql.epoch('started_at')} >= %s LIMIT 1""",
        (str(aid), block["at"]),
    )
    if cur.fetchone():
        return None
    d = block["detail"]
    blocker = d.get("blocker")
    return {
        "reason": d["detail"],
        "blocker": blocker,
        "at": block["at"],
        "setup_available": bool(d.get("setup_available")) and blocker in SETUP_BLOCKERS,
        "setup": setup_status(cur, aid),
    }


def _active_conversation(cur, aid):
    cur.execute(
        "SELECT * FROM conversations WHERE agent_id=%s AND status='active'", (aid,)
    )
    return cur.fetchone()


@app.post("/api/agents/{aid}/conversation/repository-setup", status_code=202)
def request_repository_setup(aid: str, body: ConversationActor, request: Request):
    """A human asks Orcha to set up Git for this chat's project folder.

    Only offered while startup is blocked by a fixable repository state. The notifier
    then creates a repository in the project folder (only when the folder has none of
    its own) plus one empty first commit, without touching other files, the index, or any
    parent repository, and reports back through ``.../repository-setup/result``.
    Idempotent while a request is still waiting.
    """
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        agent = _require_agent(cur, aid)
        cid = str(agent["container_id"])
        body.actor_agent_id = _trusted_actor(cur, request, cid, body.actor_agent_id)
        _require_kind(cur, body.actor_agent_id, ("human",))
        block = startup_block(cur, aid, _active_conversation(cur, aid))
        if not block or not block["setup_available"]:
            raise HTTPException(
                409, "this chat is not blocked by a repository setup Orcha can do"
            )
        if block["setup"] and block["setup"]["state"] == "requested":
            return {"setup": block["setup"], "created": False}
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "agent",
            aid,
            SETUP_REQUESTED,
            {"blocker": block["blocker"], "by": body.actor_agent_id},
        )
        conn.commit()
        return {"setup": setup_status(cur, aid), "created": True}


@app.post("/api/agents/{aid}/conversation/repository-setup/result", status_code=201)
def report_repository_setup(aid: str, body: RepositorySetupResult):
    """The notifier reports the outcome of a requested setup (plain-language detail)."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        agent = _require_agent(cur, aid)
        log_event(
            cur,
            str(agent["container_id"]),
            "system",
            None,
            "agent",
            aid,
            SETUP_RESULT,
            {"ok": body.ok, "detail": body.detail, "requested_at": body.requested_at},
        )
        conn.commit()
        return {"setup": setup_status(cur, aid)}

