"""Org chart API (mig 052): read and set an agent's reporting line.

PUT /api/agents/{aid}/reports-to is HUMAN-authoritative, gated exactly like the agent
configuration writes (owner-or-``manage_agents`` under the trusted lane; viewers and
non-members refused; trust off = an acting human, never an AI). A manager must be a live
agent in the SAME project (422 otherwise) and the line may not close a loop (409).
Every change is audit-logged (``agent_reports_to_changed``).
"""

from fastapi import HTTPException, Request

from portal_backend import sql
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_kind, valid_uuid
from portal_backend.identity_routes import (
    enforce_grant,
    require_member_read,
    trusted_actor,
)
from portal_backend.org_chart import manager_chain, would_cycle
from portal_backend.schemas.org_chart import ReportsToResponse, ReportsToUpdate


def _chain_view(cur, aid):
    return [
        {
            "id": str(m["id"]),
            "alias": m["alias"],
            "kind": m["kind"],
            "member_role": m["member_role"],
            "terminated": m["terminated_at"] is not None,
        }
        for m in manager_chain(cur, aid)
    ]


def _load_agent(cur, aid):
    cur.execute(
        """SELECT a.id, a.alias, a.container_id, a.terminated_at, a.reports_to_agent_id,
                  m.alias AS reports_to_alias
             FROM agents a LEFT JOIN agents m ON m.id = a.reports_to_agent_id
            WHERE a.id=%s""",
        (aid,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"agent {aid} not found")
    return row


@app.get("/api/agents/{aid}/reports-to", response_model=ReportsToResponse)
def get_reports_to(aid: str, request: Request):
    """Who this agent reports to, and its full chain of command (nearest first)."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_conn, cur):
        row = _load_agent(cur, aid)
        require_member_read(cur, request, str(row["container_id"]))
        return {
            "agent_id": aid,
            "reports_to_agent_id": (
                str(row["reports_to_agent_id"]) if row["reports_to_agent_id"] else None
            ),
            "reports_to_alias": row["reports_to_alias"],
            "chain": _chain_view(cur, aid),
        }


@app.put("/api/agents/{aid}/reports-to", response_model=ReportsToResponse)
def set_reports_to(aid: str, body: ReportsToUpdate, request: Request):
    """Set (``reports_to_agent_id``) or clear (null) who this agent reports to."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    mid = body.reports_to_agent_id
    if mid is not None and not valid_uuid(mid):
        raise HTTPException(422, "reports_to_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        row = _load_agent(cur, aid)
        cid = str(row["container_id"])
        # Access model: org structure is agent configuration → owner-or-manage_agents
        # (trusted lane; viewers / non-members refused inside enforce_grant).
        enforce_grant(cur, request, cid, "manage_agents")
        actor = trusted_actor(cur, request, cid, body.actor_agent_id)
        # Human-authoritative: an AI can never rewire the org (agents can't manage agents).
        require_kind(cur, actor, ("human",))
        cur.execute(
            "SELECT container_id, member_role, terminated_at FROM agents WHERE id=%s",
            (actor,),
        )
        act = cur.fetchone()
        if str(act["container_id"]) != cid or act["terminated_at"] is not None:
            raise HTTPException(403, "the acting human is not a member of this project")
        if act["member_role"] == "viewer":
            # The viewer role is read-only on every lane (identity_routes._forbid_viewer_write).
            raise HTTPException(
                403,
                "your role on this project is viewer — it is read-only; "
                "ask an owner for the member role to act",
            )
        if row["terminated_at"] is not None:
            raise HTTPException(409, "agent is retired — its reporting line cannot change")

        # Serialize org edits per project so two concurrent edits can't form a loop
        # that each one alone would not (A→B racing B→A).
        cur.execute(sql.xact_lock("'orcha-org:' || %s"), (cid,))

        mgr_alias = None
        if mid is not None:
            cur.execute(
                "SELECT id, alias, container_id, terminated_at FROM agents WHERE id=%s",
                (mid,),
            )
            mgr = cur.fetchone()
            if not mgr:
                raise HTTPException(404, f"manager agent {mid} not found")
            if str(mgr["container_id"]) != cid:
                raise HTTPException(422, "a manager must be an agent in the same project")
            if mgr["terminated_at"] is not None:
                raise HTTPException(422, f"'{mgr['alias']}' is retired and cannot be a manager")
            if would_cycle(cur, aid, mid):
                raise HTTPException(
                    409,
                    f"'{row['alias']}' cannot report to '{mgr['alias']}' — that would make "
                    "a loop in the reporting lines",
                )
            mgr_alias = mgr["alias"]

        before = str(row["reports_to_agent_id"]) if row["reports_to_agent_id"] else None
        cur.execute(
            "UPDATE agents SET reports_to_agent_id=%s WHERE id=%s", (mid, aid)
        )
        if before != mid:
            log_event(
                cur,
                cid,
                "human",
                actor,
                "agent",
                aid,
                "agent_reports_to_changed",
                {
                    "alias": row["alias"],
                    "from_agent_id": before,
                    "from_alias": row["reports_to_alias"],
                    "to_agent_id": mid,
                    "to_alias": mgr_alias,
                },
            )
        chain = _chain_view(cur, aid)
        conn.commit()
    return {
        "agent_id": aid,
        "reports_to_agent_id": mid,
        "reports_to_alias": mgr_alias,
        "chain": chain,
    }
