"""Acknowledge wake delivery, release leases, and advance handled-event floors."""

from fastapi import HTTPException

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.event_acknowledgement import (
    _recompute_delivered_floor as recompute_delivered_floor,
)
from portal_backend.guards import require_agent, valid_uuid
from portal_backend.schemas.wakes import EventsAckHandled, WakeAck


def _acknowledge_lane(cur, aid, body, lane):
    if lane == "conversation":
        cur.execute(
            """INSERT INTO agent_wake_state
                 (agent_id, conv_delivered_ts, conv_last_woken_at,
                  last_wake_kind, last_wake_event, conv_lease_until)
               VALUES (%s, COALESCE(%s, 0), CASE WHEN %s THEN now() ELSE NULL END,
                       %s, %s, NULL)
               ON CONFLICT (agent_id) DO UPDATE SET
                 conv_delivered_ts=GREATEST(
                   COALESCE(agent_wake_state.conv_delivered_ts, 0),
                   COALESCE(EXCLUDED.conv_delivered_ts,
                            agent_wake_state.conv_delivered_ts)),
                 conv_last_woken_at=CASE WHEN %s THEN now()
                   ELSE agent_wake_state.conv_last_woken_at END,
                 last_wake_kind=EXCLUDED.last_wake_kind,
                 last_wake_event=EXCLUDED.last_wake_event,
                 conv_lease_until=CASE WHEN %s THEN NULL
                   ELSE agent_wake_state.conv_lease_until END,
                 conv_lease_kind=CASE WHEN %s THEN NULL
                   ELSE agent_wake_state.conv_lease_kind END,
                 conv_preempt_requested_at=CASE WHEN %s THEN NULL
                   ELSE agent_wake_state.conv_preempt_requested_at END,
                 conv_preempt_for=CASE WHEN %s THEN NULL
                   ELSE agent_wake_state.conv_preempt_for END
               RETURNING conv_delivered_ts AS delivered_ts,
                         conv_last_woken_at AS last_woken_at,
                         last_wake_kind, last_wake_event,
                         conv_lease_until AS wake_lease_until,
                         conv_lease_kind AS lease_kind""",
            (
                aid,
                body.delivered_ts,
                body.stamp_woken,
                body.kind,
                body.event,
                body.stamp_woken,
                body.release_lease,
                body.release_lease,
                body.release_lease,
                body.release_lease,
            ),
        )
    else:
        cur.execute(
            """INSERT INTO agent_wake_state
                 (agent_id, delivered_ts, last_woken_at, last_wake_kind,
                  last_wake_event, wake_lease_until)
               VALUES (%s, COALESCE(%s, 0), CASE WHEN %s THEN now() ELSE NULL END,
                       %s, %s, NULL)
               ON CONFLICT (agent_id) DO UPDATE SET
                 delivered_ts=GREATEST(
                   agent_wake_state.delivered_ts,
                   COALESCE(EXCLUDED.delivered_ts,
                            agent_wake_state.delivered_ts)),
                 last_woken_at=CASE WHEN %s THEN now()
                   ELSE agent_wake_state.last_woken_at END,
                 last_wake_kind=EXCLUDED.last_wake_kind,
                 last_wake_event=EXCLUDED.last_wake_event,
                 wake_lease_until=CASE WHEN %s THEN NULL
                   ELSE agent_wake_state.wake_lease_until END,
                 lease_kind=CASE WHEN %s THEN NULL
                   ELSE agent_wake_state.lease_kind END,
                 preempt_requested_at=CASE WHEN %s THEN NULL
                   ELSE agent_wake_state.preempt_requested_at END,
                 preempt_for=CASE WHEN %s THEN NULL
                   ELSE agent_wake_state.preempt_for END
               RETURNING delivered_ts, last_woken_at, last_wake_kind,
                         last_wake_event, wake_lease_until, lease_kind""",
            (
                aid,
                body.delivered_ts,
                body.stamp_woken,
                body.kind,
                body.event,
                body.stamp_woken,
                body.release_lease,
                body.release_lease,
                body.release_lease,
                body.release_lease,
            ),
        )
    return cur.fetchone()


@app.post("/api/agents/{aid}/wake-ack", status_code=200)
def wake_ack(aid: str, body: WakeAck):
    """Notifier daemon records that it woke (or tried to wake) this agent.

    Advances the per-agent wake cursor (so the same events don't re-trigger) and
    stamps last_woken_at for the cooldown debounce — both surviving daemon/stopgap
    restarts. Writes a `woken` audit row to events for portal visibility.
    """
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        agent = require_agent(cur, aid)
        lane = body.lane or "work"
        row = _acknowledge_lane(cur, aid, body, lane)
        cleared_self_wake = False
        if (
            lane == "work"
            and body.clear_self_wake
            and body.self_wake_task_id
            and valid_uuid(body.self_wake_task_id)
        ):
            cur.execute(
                "DELETE FROM agent_self_wake WHERE agent_id=%s AND task_id=%s",
                (aid, body.self_wake_task_id),
            )
            cleared_self_wake = cur.rowcount > 0
        if body.release_lease:
            cur.execute(
                """UPDATE worker_runs SET status='orphaned', ended_at=now()
                   WHERE agent_id=%s AND status='running' AND lane=%s
                   RETURNING run_id""",
                (aid, lane),
            )
            reconciled = [str(run["run_id"]) for run in cur.fetchall()]
            if reconciled:
                cur.execute(
                    """UPDATE embodiment_tokens SET revoked_at=now()
                       WHERE run_id=ANY(%s) AND revoked_at IS NULL""",
                    (reconciled,),
                )
                log_event(
                    cur,
                    str(agent["container_id"]),
                    "system",
                    None,
                    "agent",
                    aid,
                    "worker_runs_reconciled",
                    {
                        "reconciled": reconciled,
                        "to_status": "orphaned",
                        "trigger": "lease_release",
                        "lane": lane,
                    },
                )
        log_event(
            cur,
            str(agent["container_id"]),
            "system",
            None,
            "agent",
            aid,
            "woken",
            {
                "kind": body.kind,
                "event": body.event,
                "delivered_ts": body.delivered_ts,
                "release_lease": body.release_lease,
                "lane": lane,
                "clear_self_wake": body.clear_self_wake,
                "self_wake_task_id": body.self_wake_task_id,
                "cleared_self_wake": cleared_self_wake,
            },
        )
        conn.commit()
    return {
        "agent_id": aid,
        "lane": lane,
        "cleared_self_wake": cleared_self_wake,
        **row,
    }


@app.post("/api/agents/{aid}/events/ack-handled", status_code=200)
def events_ack_handled(aid: str, body: EventsAckHandled):
    """GH #58: record that THIS run handled the given pending events, then advance the wake cursor to
    the CONTIGUOUS floor (the ts just below the oldest still-unhandled waking event). Replaces the
    blanket delivered_ts high-water jump for drain acks: an event the run could not handle stays
    pending and re-surfaces; a handled one never re-wakes. Idempotent (PK ON CONFLICT DO NOTHING); an
    empty event_ids list just recomputes the floor. Scoped to the agent's OWN key, so a daemon can
    never ack another agent's events."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        agent = require_agent(cur, aid)
        event_ids = [
            int(event) for event in (body.event_ids or []) if event is not None
        ]
        if event_ids:
            cur.execute(
                """INSERT INTO agent_event_acks (agent_id, event_id)
                   SELECT %s, e.id FROM agent_events e
                   WHERE e.event_key=%s AND e.id=ANY(%s)
                   ON CONFLICT DO NOTHING""",
                (aid, aid, event_ids),
            )
        new_floor = recompute_delivered_floor(cur, aid)
        log_event(
            cur,
            str(agent["container_id"]),
            "system",
            None,
            "agent",
            aid,
            "events_ack_handled",
            {"count": len(event_ids), "delivered_ts": new_floor},
        )
        conn.commit()
    return {
        "agent_id": aid,
        "handled": len(event_ids),
        "delivered_ts": new_floor,
    }
