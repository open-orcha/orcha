"""Reconcile worker runs left 'running' after their lane's lease has lapsed.

A wake is single-embodiment: while a ``worker_runs`` row for a lane says
``status='running'`` the wake-scan refuses to wake that lane
(``wake_scan_queries.embodiment_running``). The host notifier closes the row when
its worker exits, and the heartbeat reaper (``orphan_lease_routes._reap_lane``)
handles a LIVE lease whose embodiment went silent. Neither covers a row whose
lease has already LAPSED: a notifier that stalled, crashed, or lost its process
handle never renews or releases anything again, so the row blocks every wake of
that lane forever (field bug: "queued — answered on the agent's next wake" for
40+ minutes while wake-scan said "lapsed-lease orphan").

This is the server-side backstop. A running row is *stranded* only when ALL hold:

* its lane has no live lease (NULL or expired) — a live lease means a daemon is
  still renewing it every tick, so the run is governed and never touched here;
* nothing about the run or its lane has shown activity for ``orphan_secs`` (the
  same 1260s the heartbeat reaper uses, > the 1200s watchdog hard-cap): not the
  run's start, not a streamed output line, not the lane heartbeat, not a claim.

A host-sandbox row's container can legitimately outlive a daemon restart without a
lease (adoption, remote-runner spec §3.3c), so those rows additionally wait out the
default sandbox deadline before this backstop may act.

Stranded rows become ``orphaned`` (the same terminal status the wake-ack release
uses), their embodiment tokens are revoked, and an audit event is logged.
"""

from portal_backend.agent_status import log_event

# Same threshold and reasoning as the heartbeat reaper (ISS-60B): longer than the
# 1200s watchdog hard-cap, so a legitimately busy worker is never reaped.
STRANDED_RUN_SECS = 1260.0

# A sandbox row may be an adopted, still-running container with no lease behind it.
# Its daemon reconciles it by container state; this backstop only acts once even the
# default max runtime (sandbox.DEFAULT_MAX_RUNTIME_SECS = 7200) has long passed.
SANDBOX_STRANDED_EXTRA_SECS = 7200.0

_LANES = {
    "work": {
        "lease_col": "wake_lease_until",
        "heartbeat_expr": "COALESCE(w.work_last_heartbeat_at, a.last_heartbeat_at)",
        "claim_floor_expr": "w.last_woken_at",
    },
    "conversation": {
        "lease_col": "conv_lease_until",
        "heartbeat_expr": "w.conv_last_heartbeat_at",
        "claim_floor_expr": "w.conv_last_woken_at",
    },
}


def last_activity_expr(lane: str, run_alias: str = "wr") -> str:
    """SQL for the newest sign of life of one running row and its lane.

    Needs ``agents a`` and ``LEFT JOIN agent_wake_state w`` in scope. GREATEST
    ignores NULLs, and ``started_at`` is never NULL, so the result is never NULL.
    """
    spec = _LANES[lane]
    return (
        f"GREATEST({run_alias}.started_at, "
        f"(SELECT max(l.ts) FROM worker_run_lines l WHERE l.run_id = {run_alias}.run_id), "
        f"{spec['heartbeat_expr']}, {spec['claim_floor_expr']})"
    )


def lease_lapsed_expr(lane: str) -> str:
    """SQL that is true when the lane holds no live lease."""
    column = _LANES[lane]["lease_col"]
    return f"(w.{column} IS NULL OR w.{column} <= now())"


def reconcile_stranded_runs(cur, cid: str, orphan_secs: float, lane: str) -> list:
    """Orphan one lane's stranded running rows; return what was reconciled."""
    activity = last_activity_expr(lane)
    cur.execute(
        f"""WITH stranded AS (
               SELECT wr.run_id, wr.agent_id, a.alias, wr.wake_kind,
                      EXTRACT(EPOCH FROM (now() - {activity})) AS idle_seconds
               FROM worker_runs wr
               JOIN agents a ON a.id = wr.agent_id
               LEFT JOIN agent_wake_state w ON w.agent_id = wr.agent_id
               WHERE a.container_id = %s
                 AND a.terminated_at IS NULL
                 AND wr.status = 'running'
                 AND wr.lane = %s
                 AND {lease_lapsed_expr(lane)}
                 AND {activity} < now() - make_interval(secs => (
                       %s + CASE WHEN wr.sandbox_container_id IS NULL THEN 0
                                 ELSE %s END))
           ), orphaned AS (
               UPDATE worker_runs r
               SET status = 'orphaned', ended_at = now()
               FROM stranded s
               WHERE r.run_id = s.run_id AND r.status = 'running'
               RETURNING r.run_id
           )
           SELECT s.run_id, s.agent_id, s.alias, s.wake_kind, s.idle_seconds
           FROM stranded s JOIN orphaned o ON o.run_id = s.run_id""",
        (cid, lane, orphan_secs, SANDBOX_STRANDED_EXTRA_SECS),
    )
    rows = cur.fetchall()
    run_ids = [str(row["run_id"]) for row in rows]
    if run_ids:
        cur.execute(
            """UPDATE embodiment_tokens SET revoked_at=now()
               WHERE run_id = ANY(%s) AND revoked_at IS NULL""",
            (run_ids,),
        )
    for row in rows:
        log_event(
            cur,
            cid,
            "system",
            None,
            "agent",
            str(row["agent_id"]),
            "stranded_run_reaped",
            {
                "run_id": str(row["run_id"]),
                "lane": lane,
                "wake_kind": row["wake_kind"],
                "idle_seconds": round(float(row["idle_seconds"]), 1),
                "orphan_secs": orphan_secs,
                "cause": "running row with no live lease and no activity",
            },
        )
    return rows
