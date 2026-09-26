"""Renew live wake leases and surface stop or preemption requests."""

from fastapi import HTTPException

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_agent, valid_uuid
from portal_backend.schemas.wakes import WakeClaim
from portal_backend.wake_lease_claim_routes import resolve_claim_lane


@app.post("/api/agents/{aid}/wake-renew", status_code=200)
def wake_renew(aid: str, body: WakeClaim):
    """Wake-latency fix: extend a live worker's single-flight lease (heartbeat).

    The daemon claims a SHORT lease (so a crashed/orphaned worker's lease expires fast and
    never starves a fresh high-priority event for minutes), then renews it every tick while
    its worker is genuinely alive. This keeps single-flight for a legitimately long-running
    worker WITHOUT tying the lease to the 1200s watchdog hard-cap. Only extends a LIVE lease —
    never creates one and never revives a RELEASED (NULL, after a clean worker exit) or EXPIRED
    lease (which would re-block wakes for an agent no worker owns, defeating the fast-expiry
    behavior). So a renew that races a release/expiry is a no-op. Idempotent."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_agent(cur, aid)
        lane = resolve_claim_lane(body)
        if lane == "conversation":
            cur.execute(
                """UPDATE agent_wake_state
                   SET conv_lease_until=now() + make_interval(secs => %s)
                   WHERE agent_id=%s
                     AND conv_lease_until IS NOT NULL
                     AND conv_lease_until > now()
                   RETURNING conv_lease_until AS wake_lease_until,
                             conv_lease_kind AS lease_kind,
                             conv_preempt_requested_at AS preempt_requested_at""",
                (body.lease_ttl, aid),
            )
        else:
            cur.execute(
                """UPDATE agent_wake_state
                   SET wake_lease_until=now() + make_interval(secs => %s)
                   WHERE agent_id=%s
                     AND wake_lease_until IS NOT NULL
                     AND wake_lease_until > now()
                   RETURNING wake_lease_until, lease_kind, preempt_requested_at""",
                (body.lease_ttl, aid),
            )
        row = cur.fetchone()
        if row is not None:
            heartbeat_column = (
                "conv_last_heartbeat_at"
                if lane == "conversation"
                else "work_last_heartbeat_at"
            )
            cur.execute(
                f"UPDATE agent_wake_state SET {heartbeat_column}=now() "
                "WHERE agent_id=%s",
                (aid,),
            )
            cur.execute("UPDATE agents SET last_heartbeat_at=now() WHERE id=%s", (aid,))
            cur.execute(
                """SELECT w.run_id, ag.alias AS by_alias
                   FROM worker_runs w
                   LEFT JOIN agents ag ON ag.id::text = w.stop_requested_by
                   WHERE w.agent_id=%s AND w.status='running' AND w.lane=%s
                     AND w.stop_requested_at IS NOT NULL
                   ORDER BY w.started_at DESC LIMIT 1""",
                (aid, lane),
            )
            stop = cur.fetchone()
        else:
            stop = None
        conn.commit()
    if row is None:
        return {
            "agent_id": aid,
            "renewed": False,
            "lane": lane,
            "wake_lease_until": None,
            "lease_kind": None,
            "preempt_requested": False,
            "stop_requested": False,
            "stop_run_id": None,
            "stop_requested_by": None,
        }
    return {
        "agent_id": aid,
        "renewed": True,
        "lane": lane,
        "lease_kind": row["lease_kind"],
        "wake_lease_until": row["wake_lease_until"].isoformat(),
        "preempt_requested": row["preempt_requested_at"] is not None,
        "stop_requested": stop is not None,
        "stop_run_id": str(stop["run_id"]) if stop else None,
        "stop_requested_by": stop["by_alias"] if stop else None,
    }
