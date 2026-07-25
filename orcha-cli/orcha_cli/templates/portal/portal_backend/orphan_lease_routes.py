"""Reap stale wake leases independently for work and conversation lanes."""

from fastapi import HTTPException, Query

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid

ORPHAN_LEASE_SECS = 1260.0


def _reap_lane(
    cur,
    cid,
    orphan_secs,
    *,
    lease_col,
    kind_col,
    heartbeat_expr,
    claim_floor_expr,
    preempt_cols,
    run_lane,
):
    """Release one lane's stale leases and reconcile its stranded runs."""
    floored_expr = f"GREATEST(({heartbeat_expr}), ({claim_floor_expr}))"
    set_release = ", ".join(
        [f"{lease_col} = NULL", f"{kind_col} = NULL"]
        + [f"{column} = NULL" for column in preempt_cols]
    )
    cur.execute(
        f"""WITH orphans AS (
               SELECT w.agent_id, a.alias, w.{kind_col} AS lease_kind,
                      EXTRACT(EPOCH FROM (now() - ({floored_expr}))) AS idle_seconds
               FROM agent_wake_state w
               JOIN agents a ON a.id = w.agent_id
               WHERE a.container_id = %s
                 AND a.terminated_at IS NULL
                 AND w.{lease_col} IS NOT NULL
                 AND w.{lease_col} > now()
                 AND ({heartbeat_expr}) IS NOT NULL
                 AND ({floored_expr}) < now() - make_interval(secs => %s)
           ), released AS (
               UPDATE agent_wake_state w
               SET {set_release}
               FROM orphans o
               WHERE w.agent_id = o.agent_id
               RETURNING w.agent_id
           )
           SELECT agent_id, alias, lease_kind, idle_seconds FROM orphans""",
        (cid, orphan_secs),
    )
    reaped = cur.fetchall()
    runs_by_agent = {}
    reaped_ids = [str(row["agent_id"]) for row in reaped]
    if reaped_ids:
        cur.execute(
            """UPDATE worker_runs SET status='orphaned', ended_at=now()
               WHERE agent_id::text = ANY(%s) AND status='running' AND lane=%s
               RETURNING run_id, agent_id""",
            (reaped_ids, run_lane),
        )
        for run in cur.fetchall():
            runs_by_agent.setdefault(str(run["agent_id"]), []).append(
                str(run["run_id"])
            )
    reconciled = [run_id for run_ids in runs_by_agent.values() for run_id in run_ids]
    if reconciled:
        cur.execute(
            """UPDATE embodiment_tokens SET revoked_at=now()
               WHERE run_id = ANY(%s) AND revoked_at IS NULL""",
            (reconciled,),
        )
    for row in reaped:
        log_event(
            cur,
            cid,
            "system",
            None,
            "agent",
            str(row["agent_id"]),
            "orphan_lease_reaped",
            {
                "lease_kind": row["lease_kind"],
                "lane": run_lane,
                "idle_seconds": round(float(row["idle_seconds"]), 1),
                "orphan_secs": orphan_secs,
                "reconciled_runs": runs_by_agent.get(str(row["agent_id"]), []),
            },
        )
    return reaped


@app.post("/api/containers/{cid}/reap-orphan-leases", status_code=200)
def reap_orphan_leases(
    cid: str, orphan_secs: float = Query(default=ORPHAN_LEASE_SECS, ge=0)
):
    """ISS-60(B): heartbeat-keyed orphan-lease reaper (defense-in-depth backstop for ISS-60).

    ISS-60 = an orphan resident lease blocks ALL wakes for an agent. The single-flight lease has
    a short TTL the daemon renews every tick, so a worker the daemon still TRACKS self-heals on
    exit/crash. The gap this closes: a lease that OUTLIVES its embodiment in a way the TTL alone
    won't recover — a daemon restart / externally-spawned resident whose lease survives an
    in-memory live_residents reset, where something keeps the lease alive without a live process
    behind it. This reaper is TTL-independent: it force-releases any LIVE lease whose agent hasn't
    produced a liveness heartbeat in `orphan_secs` (default 1260s > the 1200s watchdog hard-cap, so
    a legitimately busy worker is never reaped).

    SAFE only because wake-renew bumps last_heartbeat_at on every keep-alive tick — an alive-but-quiet
    resident keeps a fresh heartbeat, so heartbeat-staleness genuinely means the embodiment is gone.
    NULL heartbeats are NEVER reaped (an agent that never beat has no live embodiment to orphan; its
    own short TTL handles it) — only a once-alive-now-stale lease. The reap DECISION lives server-side
    (only the API touches the DB) so the host daemon stays a thin caller. The daemon polls this each
    tick; it is idempotent (a released lease is no longer LIVE, so a re-call is a no-op).

    GH #91/#90: the reaper is now TWO INDEPENDENT lane branches so a stale WORK lease is reaped
    without touching a live CONVERSATION lease on the same agent (and vice-versa). Each branch keys
    idle on its OWN heartbeat column, releases only its OWN lease columns, and reconciles only its
    OWN lane's runs. WORK back-compat: a legacy (pre-030) row that has a work lease but a NULL
    work_last_heartbeat_at (it was never split) still reaps — the WORK branch keys idle on
    COALESCE(work_last_heartbeat_at, agents.last_heartbeat_at), so pre-split rows fall back to the
    agent-wide heartbeat they always used. The conversation branch has no such legacy (conv leases
    only exist post-030), so it keys strictly on conv_last_heartbeat_at.

    GH #138: idle is floored at GREATEST(heartbeat, lane's own last_woken_at/conv_last_woken_at).
    wake-claim stamps last_woken_at on EVERY claim (including the first), but never touches the
    heartbeat column — only wake-renew does, on the next keep-alive tick. Without this floor, an
    agent idle for a long stretch before a brand-new claim has a heartbeat column still holding a
    value from BEFORE that claim; the reaper would read the fresh lease as already stale by however
    old that pre-claim heartbeat was and false-orphan a lease that is seconds old and genuinely
    alive — flipping its worker_run to 'orphaned' out from under it and briefly reopening the
    single-flight guard for a competing claim (a real double-embodiment window, not just a
    cosmetic status flash)."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        work_reaped = _reap_lane(
            cur,
            cid,
            orphan_secs,
            lease_col="wake_lease_until",
            kind_col="lease_kind",
            heartbeat_expr="COALESCE(w.work_last_heartbeat_at, a.last_heartbeat_at)",
            claim_floor_expr="w.last_woken_at",
            preempt_cols=("preempt_requested_at", "preempt_for"),
            run_lane="work",
        )
        conversation_reaped = _reap_lane(
            cur,
            cid,
            orphan_secs,
            lease_col="conv_lease_until",
            kind_col="conv_lease_kind",
            heartbeat_expr="w.conv_last_heartbeat_at",
            claim_floor_expr="w.conv_last_woken_at",
            preempt_cols=("conv_preempt_requested_at", "conv_preempt_for"),
            run_lane="conversation",
        )
        cur.execute(
            """UPDATE embodiment_tokens SET revoked_at=now()
               WHERE run_id IS NULL AND revoked_at IS NULL
                 AND kind <> 'resident'
                 AND created_at < now() - interval '2 minutes'"""
        )
        conn.commit()
    reaped = list(work_reaped) + list(conversation_reaped)
    return {
        "container_id": cid,
        "orphan_secs": orphan_secs,
        "reaped": [
            {
                "agent_id": str(row["agent_id"]),
                "alias": row["alias"],
                "lease_kind": row["lease_kind"],
                "idle_seconds": round(float(row["idle_seconds"]), 1),
            }
            for row in reaped
        ],
    }
