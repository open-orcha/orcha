"""Persist per-event acknowledgements and advance contiguous delivery cursors."""

from portal_backend.event_policy import _WORK_NON_WAKING_EVENTS
from portal_backend.guards import valid_uuid as _valid_uuid


def _recompute_delivered_floor(cur, aid: str) -> float:
    """GH #58: advance agent_wake_state.delivered_ts to the CONTIGUOUS floor — the ts just below the
    OLDEST still-unhandled WAKING event past the cursor — never over an unhandled one. So an event a
    run could not handle (a cross-task task_bound left pending) keeps re-surfacing instead of being
    skipped by a blanket high-water jump. Idempotent; only ever moves the cursor forward (GREATEST).

    delivered_ts is the WORK-lane cursor (every caller is a work seam or the run-completion ack), so
    "unhandled WAKING" is judged with _WORK_NON_WAKING_EVENTS — a bare conversation_turn never pins
    the floor. That matches the wake_scan contract (a work ack advances past conversation turns; the
    conversation lane consumes them via its own conv_delivered_ts), and keeps the GH #138 safety net
    one-shot: an old chat turn is not re-injected into every later work wake once a work ack lands."""
    cur.execute(
        "SELECT COALESCE(delivered_ts, 0) AS d FROM agent_wake_state WHERE agent_id=%s",
        (aid,),
    )
    row = cur.fetchone()
    delivered = (row["d"] if row else 0.0) or 0.0
    cur.execute(
        """SELECT min(e.ts) AS m FROM agent_events e
           WHERE e.event_key=%s AND e.ts > %s AND e.event_name <> ALL(%s)
             AND NOT EXISTS (SELECT 1 FROM agent_event_acks a
                              WHERE a.agent_id=%s AND a.event_id=e.id)""",
        (aid, delivered, list(_WORK_NON_WAKING_EVENTS), aid),
    )
    min_unhandled = cur.fetchone()["m"]
    if min_unhandled is None:
        # nothing waking left unhandled → advance past EVERYTHING above the cursor (incl. trailing
        # non-waking / already-handled rows) so a later scan starts clean.
        cur.execute(
            "SELECT max(ts) AS m FROM agent_events WHERE event_key=%s AND ts > %s",
            (aid, delivered),
        )
        new_floor = cur.fetchone()["m"]
    else:
        # advance to the largest event ts strictly BELOW the oldest unhandled one — everything there is
        # acked or non-waking, safe to skip; the unhandled event still re-surfaces on the next scan.
        cur.execute(
            "SELECT max(ts) AS m FROM agent_events WHERE event_key=%s AND ts > %s AND ts < %s",
            (aid, delivered, min_unhandled),
        )
        new_floor = cur.fetchone()["m"]
    if new_floor is None or new_floor <= delivered:
        return delivered
    cur.execute(
        """INSERT INTO agent_wake_state (agent_id, delivered_ts) VALUES (%s, %s)
           ON CONFLICT (agent_id) DO UPDATE SET
             delivered_ts = GREATEST(agent_wake_state.delivered_ts, EXCLUDED.delivered_ts)""",
        (aid, new_floor),
    )
    return new_floor


def _ack_events_handled(
    cur, agent_id, event_name: str, link_field: str, link_value
) -> None:
    """GH #58: mark every pending agent_events row of `event_name` on `agent_id`'s key whose payload
    `link_field` == `link_value` as handled (the per-event ack), then advance the contiguous floor.
    Called at each NEW_WORK / DIRECTIVE resolution seam — the /next claim, /done, accept/reject-task,
    unassign, cancel, request close/escalate — in the SAME txn that consumes the work, so a
    started/finished item stops re-waking. Idempotent (PK ON CONFLICT DO NOTHING)."""
    if not agent_id or not _valid_uuid(str(agent_id)) or link_value is None:
        return
    cur.execute(
        """INSERT INTO agent_event_acks (agent_id, event_id)
           SELECT %s, e.id FROM agent_events e
           WHERE e.event_key=%s AND e.event_name=%s AND e.payload->>%s = %s
           ON CONFLICT DO NOTHING""",
        (str(agent_id), str(agent_id), event_name, link_field, str(link_value)),
    )
    _recompute_delivered_floor(cur, str(agent_id))
