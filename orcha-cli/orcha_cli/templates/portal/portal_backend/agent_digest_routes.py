"""Store and assemble durable agent continuity digests."""

import json
import time

from fastapi import HTTPException

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.events import publish_event
from portal_backend.guards import require_agent, valid_uuid
from portal_backend.schemas.agent_state import DigestSnapshot

_digest_curator = None


def configure_compatibility(digest_curator):
    """Bind the optional shared digest curator copied into portal installs."""
    global _digest_curator
    _digest_curator = digest_curator


@app.post("/api/agents/{aid}/digest", status_code=201)
def post_digest(aid: str, body: DigestSnapshot):
    """D3: store one per-agent memory digest the agent composed.

    Append-only — every POST is a new snapshot row; the latest is the live view.
    The server stamps snapshot_ts (so cadence is server-truth) and never edits
    the agent's reasoning. Emits a 'digest_snapshotted' event for the portal.
    """
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    decisions, learnings, open_threads = (
        body.decisions,
        body.learnings,
        body.open_threads,
    )
    if _digest_curator is not None:
        clean = _digest_curator.dedup_digest(
            {
                "decisions": decisions,
                "learnings": learnings,
                "open_threads": open_threads,
            }
        )
        decisions, learnings, open_threads = (
            clean["decisions"],
            clean["learnings"],
            clean["open_threads"],
        )
    with db_cursor() as (connection, cur):
        agent = require_agent(cur, aid)
        container_id = str(agent["container_id"])
        snapshot_ts = time.time()
        cur.execute(
            """INSERT INTO agent_memory_digests
                 (container_id, agent_id, snapshot_ts, current_focus,
                  decisions, learnings, open_threads, audience)
               VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s)
               RETURNING id""",
            (
                container_id,
                aid,
                snapshot_ts,
                body.current_focus,
                json.dumps(decisions),
                json.dumps(learnings),
                json.dumps(open_threads),
                body.audience,
            ),
        )
        digest_id = cur.fetchone()["id"]
        log_event(
            cur,
            container_id,
            "ai",
            aid,
            "agent",
            aid,
            "digest_snapshotted",
            {"digest_id": digest_id, "current_focus": body.current_focus},
        )
        publish_event(
            cur,
            container_id,
            None,
            "digest_snapshotted",
            {"digest_id": digest_id, "snapshot_ts": snapshot_ts, "agent_id": aid},
        )
        connection.commit()
    return {"digest_id": digest_id, "agent_id": aid, "snapshot_ts": snapshot_ts}


@app.get("/api/agents/{aid}/digest")
def get_digest(aid: str):
    """Return the agent's LATEST memory digest (or {digest: null} if none yet)."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_agent(cur, aid)
        cur.execute(
            """SELECT id, snapshot_ts, current_focus, decisions, learnings,
                      open_threads, audience, created_at
               FROM agent_memory_digests
               WHERE agent_id=%s ORDER BY snapshot_ts DESC LIMIT 1""",
            (aid,),
        )
        return {"digest": cur.fetchone()}


@app.get("/api/agents/{aid}/rehydrate")
def rehydrate(aid: str):
    """D4: assemble the 'where we left off' brief for a re-binding tab.

    One call returns everything the SessionStart rehydrate prints: identity,
    the agent's live (non-terminal) tasks, open incoming requests, answered
    outgoing requests, and the latest memory digest. Identity/tasks/inbox come
    FRESH from the existing tables (Dock's (i)-(iii)); the digest carries the
    reasoning gap (iv). Deliberately carries NO Claude Code file-memory — that
    loads via its own parallel injector (the ownership boundary).
    """
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        cur.execute(
            """SELECT id, container_id, alias, role, kind, status,
                      turns_used, turn_budget FROM agents WHERE id=%s""",
            (aid,),
        )
        agent = cur.fetchone()
        if not agent:
            raise HTTPException(404, f"agent {aid} not found")
        cur.execute(
            """SELECT t.id, t.title, t.status, t.priority, t.definition_of_done,
                      (SELECT m.body FROM task_messages m
                       WHERE m.task_id = t.id ORDER BY m.created_at DESC LIMIT 1)
                        AS last_message
               FROM tasks t JOIN agent_tasks at ON at.task_id = t.id
               WHERE at.agent_id = %s
                 AND t.status NOT IN ('completed', 'cancelled')
               ORDER BY t.priority, t.created_at""",
            (aid,),
        )
        tasks = cur.fetchall()
        cur.execute(
            """SELECT r.id, r.type, r.priority, LEFT(r.payload, 240) AS payload,
                      req.alias AS requester_alias
               FROM requests r JOIN agents req ON req.id = r.requester_id
               WHERE r.target_id = %s AND r.status = 'open'
               ORDER BY r.priority, r.created_at""",
            (aid,),
        )
        inbox = cur.fetchall()
        cur.execute(
            """SELECT r.id, r.type, LEFT(r.payload, 160) AS payload,
                      LEFT(r.response, 240) AS response,
                      COALESCE(tgt.alias, '(human)') AS target_alias
               FROM requests r LEFT JOIN agents tgt ON tgt.id = r.target_id
               WHERE r.requester_id = %s AND r.status = 'answered'
               ORDER BY r.responded_at DESC NULLS LAST""",
            (aid,),
        )
        outbox = cur.fetchall()
        cur.execute(
            """SELECT snapshot_ts, current_focus, decisions, learnings,
                      open_threads, audience, created_at
               FROM agent_memory_digests
               WHERE agent_id=%s ORDER BY snapshot_ts DESC LIMIT 1""",
            (aid,),
        )
        digest = cur.fetchone()
    return {
        "identity": agent,
        "tasks": tasks,
        "inbox": inbox,
        "outbox": outbox,
        "digest": digest,
    }
