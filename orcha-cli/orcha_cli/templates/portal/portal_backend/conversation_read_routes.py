"""Conversation creation and history-reading routes."""

from fastapi import HTTPException

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_agent as _require_agent
from portal_backend.guards import require_kind as _require_kind
from portal_backend.guards import valid_uuid as _valid_uuid
from portal_backend.schemas.conversations import ConversationStart

TURN_COLUMNS = (
    "id, conversation_id, seq, role, author_agent_id, content, run_id, meta, "
    "attachments, created_at"
)


@app.post("/api/agents/{aid}/conversations", status_code=201)
def start_conversation(aid: str, body: ConversationStart):
    """Get-or-create the ACTIVE conversation with an AI agent (a human opens it). At most
    ONE active conversation per agent (the one-embodiment invariant). Idempotent — returns
    the existing active conversation if one is open."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        agent = _require_agent(cur, aid)
        _require_kind(cur, body.actor_agent_id, ("human",))
        cur.execute("SELECT kind FROM agents WHERE id=%s", (aid,))
        if cur.fetchone()["kind"] != "ai":
            raise HTTPException(400, "conversations target an AI agent")
        cur.execute(
            "INSERT INTO conversations (container_id, agent_id, started_by) "
            "VALUES (%s, %s, %s) "
            "ON CONFLICT (agent_id) WHERE status='active' DO NOTHING RETURNING *",
            (agent["container_id"], aid, body.actor_agent_id),
        )
        conversation = cur.fetchone()
        if conversation is None:
            cur.execute(
                "SELECT * FROM conversations WHERE agent_id=%s AND status='active'",
                (aid,),
            )
            return {"conversation": cur.fetchone(), "created": False}
        log_event(
            cur,
            str(agent["container_id"]),
            "human",
            body.actor_agent_id,
            "conversation",
            str(conversation["id"]),
            "conversation_started",
            {"agent_id": aid},
        )
        conn.commit()
    return {"conversation": conversation, "created": True}


@app.get("/api/agents/{aid}/conversation")
def get_agent_conversation(aid: str, limit: int = 50):
    """The agent's ACTIVE conversation + its most-recent turns (oldest→newest). Convenience
    for V1 boot-injection and the portal panel. {conversation: null, turns: []} if none."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    limit = max(1, min(limit, 500))
    with db_cursor() as (_, cur):
        _require_agent(cur, aid)
        cur.execute(
            "SELECT * FROM conversations WHERE agent_id=%s AND status='active'", (aid,)
        )
        conversation = cur.fetchone()
        if not conversation:
            return {"conversation": None, "turns": []}
        cur.execute(
            f"SELECT {TURN_COLUMNS} FROM conversation_turns "
            "WHERE conversation_id=%s ORDER BY seq DESC LIMIT %s",
            (conversation["id"], limit),
        )
        turns = list(reversed(cur.fetchall()))
    return {"conversation": conversation, "turns": turns}


@app.get("/api/conversations/{conv_id}")
def get_conversation(conv_id: str):
    if not _valid_uuid(conv_id):
        raise HTTPException(400, "conversation_id is not a valid UUID")
    with db_cursor() as (_, cur):
        cur.execute("SELECT * FROM conversations WHERE id=%s", (conv_id,))
        conversation = cur.fetchone()
    if not conversation:
        raise HTTPException(404, f"conversation {conv_id} not found")
    return {"conversation": conversation}


@app.get("/api/conversations/{conv_id}/turns")
def list_turns(conv_id: str, limit: int = 100, after_seq: int = 0):
    """Ordered turns oldest→newest from after_seq (exclusive). For V1 history injection
    (cache-friendly prefix order) and the portal panel; page with ?after_seq=<last seq>."""
    if not _valid_uuid(conv_id):
        raise HTTPException(400, "conversation_id is not a valid UUID")
    limit = max(1, min(limit, 1000))
    with db_cursor() as (_, cur):
        cur.execute("SELECT 1 FROM conversations WHERE id=%s", (conv_id,))
        if not cur.fetchone():
            raise HTTPException(404, f"conversation {conv_id} not found")
        cur.execute(
            f"SELECT {TURN_COLUMNS} FROM conversation_turns "
            "WHERE conversation_id=%s AND seq>%s ORDER BY seq LIMIT %s",
            (conv_id, after_seq, limit),
        )
        turns = cur.fetchall()
    return {"conversation_id": conv_id, "turns": turns}
