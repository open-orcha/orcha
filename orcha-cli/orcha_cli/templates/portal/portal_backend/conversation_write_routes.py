"""Conversation turn, session, and closure mutation routes."""

import json

from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.auth_provider import authorize, resolve_actor
from portal_backend.attachment_references import (
    validate_conv_attachment_refs as _validate_conv_attachment_refs,
)
from portal_backend.conversation_read_routes import TURN_COLUMNS
from portal_backend.database import db_cursor
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import require_agent as _require_agent
from portal_backend.guards import valid_uuid as _valid_uuid
from portal_backend.provider_keys import container_llm_key as _container_llm_key
from portal_backend.schemas.conversations import (
    ConversationActor,
    ConversationSession,
    TurnAppend,
)


def _validate_turn_actor(cur, conversation, body):
    if body.role == "agent":
        if body.author_agent_id != str(conversation["agent_id"]):
            raise HTTPException(
                403, "an 'agent' turn must be authored by the conversation's agent"
            )
        if not body.run_id:
            raise HTTPException(400, "an 'agent' turn requires run_id (its worker_run)")
        cur.execute("SELECT agent_id FROM worker_runs WHERE run_id=%s", (body.run_id,))
        run = cur.fetchone()
        if not run:
            raise HTTPException(404, f"worker_run {body.run_id} not found")
        if str(run["agent_id"]) != str(conversation["agent_id"]):
            raise HTTPException(403, "run_id belongs to a different agent")
    if body.role == "human":
        cur.execute("SELECT kind FROM agents WHERE id=%s", (body.author_agent_id,))
        author = cur.fetchone()
        if not author:
            raise HTTPException(404, f"agent {body.author_agent_id} not found")
        if author["kind"] != "human":
            raise HTTPException(403, "a 'human' turn must be authored by a human")


@app.post("/api/conversations/{conv_id}/turns", status_code=201)
def append_turn(conv_id: str, body: TurnAppend):
    """Append one turn; the server assigns a per-conversation monotonic seq. A HUMAN turn
    is PERSISTED FIRST, then a targeted 'conversation_turn' event is published to the agent
    so the resident-session manager (Forge) feeds it to the resident's stdin — guaranteeing
    the human turn has its seq before delivery (deterministic ordering). An AGENT turn is
    posted by the resident once per stream-json 'result', linked to its worker_run via run_id."""
    if not _valid_uuid(conv_id):
        raise HTTPException(400, "conversation_id is not a valid UUID")
    if not _valid_uuid(body.author_agent_id):
        raise HTTPException(400, "author_agent_id is not a valid UUID")
    if body.run_id is not None and not _valid_uuid(body.run_id):
        raise HTTPException(400, "run_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        cur.execute("SELECT * FROM conversations WHERE id=%s FOR UPDATE", (conv_id,))
        conversation = cur.fetchone()
        if not conversation:
            raise HTTPException(404, f"conversation {conv_id} not found")
        if conversation["status"] == "ended":
            raise HTTPException(409, "conversation has ended — cannot append turns")
        _validate_turn_actor(cur, conversation, body)
        llm_key = _container_llm_key(cur, str(conversation["container_id"]))
        attachments = _validate_conv_attachment_refs(
            conv_id, body.attachments, api_key=llm_key
        )
        cur.execute(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM conversation_turns "
            "WHERE conversation_id=%s",
            (conv_id,),
        )
        seq = cur.fetchone()["n"]
        cur.execute(
            "INSERT INTO conversation_turns "
            "(conversation_id, seq, role, author_agent_id, content, run_id, meta, attachments) "
            f"VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING {TURN_COLUMNS}",
            (
                conv_id,
                seq,
                body.role,
                body.author_agent_id,
                body.content,
                body.run_id,
                json.dumps(body.meta or {}),
                json.dumps(attachments),
            ),
        )
        turn = cur.fetchone()
        cur.execute(
            "UPDATE conversations SET last_turn_at=now() WHERE id=%s", (conv_id,)
        )
        if body.role == "human":
            _publish_event(
                cur,
                str(conversation["container_id"]),
                str(conversation["agent_id"]),
                "conversation_turn",
                {
                    "conversation_id": conv_id,
                    "turn_id": str(turn["id"]),
                    "seq": seq,
                    "content": body.content,
                    "attachments": attachments,
                },
            )
        conn.commit()
    return {"turn": turn}


@app.post("/api/conversations/{conv_id}/session", status_code=200)
def set_conversation_session(conv_id: str, body: ConversationSession):
    """Record the claude --session-id (the resident manager sets this when it spawns the
    resident, so the same session can be pinned/resumed across respawns). ISS-70: also stamp
    session_pinned_at=now() so active-conversations can compute `cold_required` — force a one-shot
    cold boot (re-injecting persona+digest) when a digest written by another embodiment is newer
    than this pin."""
    if not _valid_uuid(conv_id) or not _valid_uuid(body.session_id):
        raise HTTPException(400, "conversation_id and session_id must be valid UUIDs")
    with db_cursor() as (conn, cur):
        cur.execute(
            "UPDATE conversations SET session_id=%s, session_pinned_at=now() "
            "WHERE id=%s RETURNING id, session_id",
            (body.session_id, conv_id),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, f"conversation {conv_id} not found")
        conn.commit()
    return {"conversation_id": conv_id, "session_id": str(row["session_id"])}


@app.post("/api/conversations/{conv_id}/end", status_code=200)
def end_conversation(conv_id: str, body: ConversationActor, request: Request):
    """Mark a conversation ended (human closes it, or the idle reaper on session end).
    Idempotent. Frees the agent's single active-conversation slot."""
    if not _valid_uuid(conv_id):
        raise HTTPException(400, "conversation_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        actor_agent = _require_agent(cur, body.actor_agent_id)
        # SEAM A (#211): default no-op resolve/authorize; downstream overridable. The
        # conversation's container isn't known until the conditional UPDATE below, so
        # authorize against the acting agent's container (its correct authority scope).
        resolved_actor = resolve_actor(
            cur, request, str(actor_agent["container_id"]), body.actor_agent_id
        )
        authorize(
            cur,
            request,
            resolved_actor,
            "end_conversation",
            str(actor_agent["container_id"]),
        )
        cur.execute(
            "UPDATE conversations SET status='ended', ended_at=now() "
            "WHERE id=%s AND status<>'ended' RETURNING id, container_id",
            (conv_id,),
        )
        row = cur.fetchone()
        if row:
            log_event(
                cur,
                str(row["container_id"]),
                "ai",
                body.actor_agent_id,
                "conversation",
                conv_id,
                "conversation_ended",
                {},
            )
            conn.commit()
            return {"conversation_id": conv_id, "status": "ended"}
        cur.execute("SELECT 1 FROM conversations WHERE id=%s", (conv_id,))
        if not cur.fetchone():
            raise HTTPException(404, f"conversation {conv_id} not found")
        return {"conversation_id": conv_id, "status": "ended", "already_ended": True}
