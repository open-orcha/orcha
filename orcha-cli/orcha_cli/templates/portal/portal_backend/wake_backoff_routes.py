"""List and manually release wake circuit-breaker suppressions (human authority).

The breaker itself (strike accounting, the ladder, the tier-3 needs-you artifact) lives
in wake_backoff.py and runs inline in the wake-scan chokepoint (wake_scan_routes.py). This
module is the two human-facing surfaces: read what's currently paced (GET, for a portal UI
to render), and the release valve (DELETE) — a human's manual release ALWAYS wins over the
timer, clearing the row outright so the very next scan sees the candidate again."""

from typing import Optional

from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_agent, require_container, require_kind, valid_uuid
from portal_backend.identity_routes import enforce_grant, require_member_read, trusted_actor
from portal_backend.schemas.agent_state import WakeBackoffRelease


@app.get("/api/containers/{cid}/wake-backoff")
def list_wake_backoff(cid: str, request: Request):
    """Every active/historical breaker row for this container (agent alias joined in for
    display) — the UI's "wakes paused" listing. Ordered by strikes desc, then most recently
    struck, so the noisiest/most-recent trigger surfaces first."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        # Access model: project-isolated read (a trusted non-member 403s), like every
        # other cid-scoped GET — the sibling DELETE below was already gated.
        require_member_read(cur, request, cid)
        cur.execute(
            """SELECT wb.agent_id, a.alias, wb.wake_key, wb.strikes, wb.suppressed_until,
                      wb.first_strike_at, wb.last_strike_at, wb.notified_at
                 FROM wake_backoff wb
                 JOIN agents a ON a.id = wb.agent_id
                WHERE wb.container_id=%s
                ORDER BY wb.strikes DESC, wb.last_strike_at DESC""",
            (cid,),
        )
        rows = cur.fetchall()
    return {
        "container_id": cid,
        "backoffs": [
            {
                "agent_id": str(row["agent_id"]),
                "alias": row["alias"],
                "wake_key": row["wake_key"],
                "strikes": row["strikes"],
                "suppressed_until": (
                    row["suppressed_until"].isoformat() if row["suppressed_until"] else None
                ),
                "suppressed": bool(row["suppressed_until"]),  # let the caller compute now()-relative
                "first_strike_at": row["first_strike_at"].isoformat() if row["first_strike_at"] else None,
                "last_strike_at": row["last_strike_at"].isoformat() if row["last_strike_at"] else None,
                "notified": row["notified_at"] is not None,
            }
            for row in rows
        ],
    }


@app.delete("/api/containers/{cid}/agents/{aid}/wake-backoff/{wake_key}", status_code=200)
def release_wake_backoff(
    cid: str, aid: str, wake_key: str, request: Request,
    body: Optional[WakeBackoffRelease] = None,
):
    """Human release valve: clear this (agent, wake_key) breaker row outright — resume
    wakes for the trigger IMMEDIATELY, not "wait out the suppression timer". Human-authority
    gated like other agent mutations (AutoWakeUpdate's pattern: owner-or-manage_autonomy under
    trusted-proxy identity; permissive body actor + require_kind='human' on the self-host trust-
    off lane). Never touches task/agent state — only this pacing row."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        agent = require_agent(cur, aid)
        if str(agent["container_id"]) != cid:
            raise HTTPException(400, "agent belongs to a different container")
        # Per-project identity: a trusted proxy login IS the actor (403 non-member); trust-off
        # keeps today's permissive body-actor + require_kind self-host convention intact.
        enforce_grant(cur, request, cid, "manage_autonomy")
        actor_agent_id = trusted_actor(
            cur, request, cid, body.actor_agent_id if body else None
        )
        require_kind(cur, actor_agent_id, ("human",))
        cur.execute(
            "DELETE FROM wake_backoff WHERE agent_id=%s AND wake_key=%s RETURNING strikes",
            (aid, wake_key),
        )
        deleted = cur.fetchone()
        log_event(
            cur, cid, "human", actor_agent_id, "agent", aid, "wake_backoff_released",
            {"wake_key": wake_key, "strikes_at_release": deleted["strikes"] if deleted else None},
        )
        conn.commit()
    return {
        "agent_id": aid,
        "wake_key": wake_key,
        "released": deleted is not None,
    }
