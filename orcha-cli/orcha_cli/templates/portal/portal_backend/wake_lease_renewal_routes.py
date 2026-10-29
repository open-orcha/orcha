"""Renew live wake leases and surface stop or preemption requests."""

from fastapi import HTTPException, Request

from portal_backend.managed_run_auth import lock_agent_runs, scheduling_run_matches
from portal_backend import sql
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_agent, valid_uuid
from portal_backend.schemas.wakes import WakeClaim
from portal_backend.wake_lease_claim_routes import resolve_claim_lane


def _recover_managed_lease(cur, runs, held, request):
    """A daemon may restore only the still-authorized exact run's lapsed lease."""
    if (len(runs) != 1 or not runs[0]['managed_commands'] or not held
            or held['lease_kind'] != 'ephemeral' or not held['wake_lease_until']):
        return False
    run = runs[0]
    from portal_backend.managed_job_service import authority_until, run_limits
    from portal_backend.managed_run_auth import require_managed_run
    cur.execute('SELECT 1 FROM managed_jobs WHERE owner_run_id=%s AND NOT termination_verified',
                (run['run_id'],))
    if not cur.fetchone():
        return False
    cur.execute("SELECT run_token FROM embodiment_tokens WHERE run_id=%s "
                "AND revoked_at IS NULL AND lane='work' ORDER BY created_at LIMIT 1", (run['run_id'],))
    binding = cur.fetchone()
    if not binding:
        return False
    try:
        run, task = require_managed_run(cur, str(run['task_id']), binding['run_token'], request,
                                       allow_lapsed=True, enrol=False)
        return authority_until(cur, run, task, run_limits(cur, run)) > sql.utcnow()
    except HTTPException:
        return False


@app.post("/api/agents/{aid}/wake-renew", status_code=200)
def wake_renew(aid: str, body: WakeClaim, request: Request = None):
    """Wake-latency fix: extend a live worker's single-flight lease (heartbeat).

    The daemon claims a SHORT lease (so a crashed/orphaned worker's lease expires fast and
    never starves a fresh high-priority event for minutes), then renews it every tick while
    its worker is genuinely alive. This keeps single-flight for a legitimately long-running
    worker WITHOUT tying the lease to the 1200s watchdog hard-cap. Only extends a LIVE lease —
    never creates one and never revives a RELEASED (NULL, after a clean worker exit) or EXPIRED
    lease (which would re-block wakes for an agent no worker owns, defeating the fast-expiry
    behavior). A managed run with an exact identity and a live/uncertain job may recover
    a LAPSED (never released) lease after authoritative revalidation. Idempotent."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_agent(cur, aid)
        lane = resolve_claim_lane(body)
        runs, held = lock_agent_runs(cur, aid, lane)
        if not scheduling_run_matches(cur, runs, held, lane, body.run_id):
            return {"agent_id": aid, "renewed": False, "lane": lane,
                    "wake_lease_until": None, "lease_kind": None,
                    "preempt_requested": False, "stop_requested": False,
                    "stop_run_id": None, "stop_requested_by": None,
                    "reason": "worker_owner_changed"}
        lease_until = sql.from_now(body.lease_ttl)
        recover = bool(lane == 'work' and body.run_id and held
                       and held['wake_lease_until'] and held['wake_lease_until'] <= sql.utcnow()
                       and _recover_managed_lease(cur, runs, held, request))
        if lane == "conversation":
            cur.execute(
                """UPDATE agent_wake_state
                   SET conv_lease_until=%s
                   WHERE agent_id=%s
                     AND conv_lease_until IS NOT NULL
                     AND conv_lease_until > now()
                   RETURNING conv_lease_until AS wake_lease_until,
                             conv_lease_kind AS lease_kind,
                             conv_preempt_requested_at AS preempt_requested_at""",
                (lease_until, aid),
            )
        else:
            cur.execute(
                """UPDATE agent_wake_state
                   SET wake_lease_until=%s
                   WHERE agent_id=%s
                     AND wake_lease_until IS NOT NULL
                     AND (wake_lease_until > now() OR %s)
                   RETURNING wake_lease_until, lease_kind, preempt_requested_at""",
                (lease_until, aid, recover),
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
                   LEFT JOIN agents ag ON CAST(ag.id AS TEXT) = w.stop_requested_by
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
