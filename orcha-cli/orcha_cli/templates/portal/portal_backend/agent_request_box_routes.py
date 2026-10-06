"""Agent inbox and outbox request-list routes."""

from datetime import datetime
from typing import Optional

from fastapi import HTTPException, Request

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_agent as _require_agent
from portal_backend.guards import valid_uuid as _valid_uuid
from portal_backend.identity_routes import require_member_read
from portal_backend.schemas.requests import AgentInboxResponse, AgentOutboxResponse
from portal_backend.request_ownership import (
    _annotate_request_ownership,
)

# Mig 065: `agent_payload` is the full text addressed to the agent (e.g. a code-thread
# question's anchor + reply instructions + lesson guide); null = `payload` is all there is.
# The /orcha-inbox and /orcha-checkpoint skills tell the agent to act on it when present.
_REQUEST_COLUMNS = """r.id, r.type, r.status, r.priority, r.payload, r.agent_payload, r.response,
                      r.created_at, r.responded_at, r.expires_at, r.detail"""


@app.get("/api/agents/{aid}/inbox", responses={200: {"model": AgentInboxResponse}})
def agent_inbox(aid: str, request: Request, since: Optional[str] = None):
    """Open requests addressed to this agent (incoming side of the inbox).

    Orcha#33: `?since=<ISO-8601 timestamp>` returns only requests with
    `created_at > since`. Used by the `orcha poll-inbox` CLI subcommand that
    runs as a Claude Code PostToolUse hook — gives working agents a ≤5s
    notice on new asks without re-printing items already surfaced.
    """
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    if since is not None:
        try:
            datetime.fromisoformat(since.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(400, "`since` must be an ISO-8601 timestamp")
    with db_cursor() as (_, cur):
        agent = _require_agent(cur, aid)
        # PS-08: project isolation — a trusted non-member cannot read another project's asks.
        require_member_read(cur, request, str(agent["container_id"]))
        since_clause = "AND r.created_at > %s::timestamptz" if since else ""
        params = (aid, since) if since else (aid,)
        cur.execute(
            f"""SELECT {_REQUEST_COLUMNS},
                       r.requester_id, a.alias AS requester_alias, r.target_id,
                       r.parent_request_id, r.chain_depth
                FROM requests r
                JOIN agents a ON a.id = r.requester_id
                WHERE r.target_id = %s AND r.status = 'open' {since_clause}
                ORDER BY r.priority, r.created_at""",
            params,
        )
        return {"open_requests": _annotate_request_ownership(cur.fetchall())}


@app.get("/api/agents/{aid}/outbox", responses={200: {"model": AgentOutboxResponse}})
def agent_outbox(
    aid: str, request: Request, status: Optional[str] = None, include_closed: bool = False
):
    """Outgoing requests where this agent is the requester.

    Use `?status=answered` to see only requests waiting for me to close (or resume the parent).
    Default: all non-closed (open, answered, escalated-via-target-null still open).

    GH #71: opt-in `?include_closed=true` ALSO returns recently-closed requests (the default
    view still omits them — back-compat). Ignored when an explicit `?status=` filter is given
    (that already pins the exact status the caller asked for).
    """
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        agent = _require_agent(cur, aid)
        require_member_read(cur, request, str(agent["container_id"]))  # PS-08
        if status:
            status_clause = "AND r.status = %s"
            params = (aid, status)
        elif include_closed:
            status_clause = ""
            params = (aid,)
        else:
            status_clause = "AND r.status <> 'closed'"
            params = (aid,)
        cur.execute(
            f"""SELECT {_REQUEST_COLUMNS}, r.closed_at,
                       r.target_id, t.alias AS target_alias, r.requester_id,
                       r.parent_request_id, r.chain_depth
                FROM requests r
                LEFT JOIN agents t ON t.id = r.target_id
                WHERE r.requester_id = %s {status_clause}
                ORDER BY r.created_at DESC""",
            params,
        )
        return {"outgoing_requests": _annotate_request_ownership(cur.fetchall())}
