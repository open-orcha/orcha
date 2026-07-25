"""List active conversation sessions and their current embodiment state."""

from fastapi import HTTPException

from portal_backend.application import app
from portal_backend.attachment_references import (
    render_attachment_feed_line as _render_attachment_feed_line,
)
from portal_backend.database import db_cursor
from portal_backend.directed_message_collection import collect_directed_messages
from portal_backend.drain_classification import (
    _DRAIN_DIRECTIVE,
    _DRAIN_NEW_WORK,
    _DRAIN_RUN_ACKABLE,
    _DRAIN_TASK_BOUND,
    _drain_class,
)
from portal_backend.event_policy import (
    _NON_WAKING_EVENTS,
    _RESIDENT_DRAIN_AUDIT_EVENTS,
)
from portal_backend.guards import (
    require_container as _require_container,
    valid_uuid as _valid_uuid,
)
from portal_backend.orphan_lease_routes import ORPHAN_LEASE_SECS
from portal_backend.limits import MAX_PROMPT_BATCH_CHARS
from portal_backend.model_policy import (
    MODEL_IDS,
    resolve_model as _resolve_model,
    resolve_model_runtime as _resolve_model_runtime,
    resolve_reasoning_effort,
)
from portal_backend.wake_event_queries import (
    earliest_actionable_answer_ts as _earliest_actionable_answer_ts,
    resident_inbox_task_work_id as _resident_inbox_task_work_id,
)


def _default_supported_models():
    return MODEL_IDS


_supported_models = _default_supported_models


def configure_compatibility(supported_models):
    """Bind the facade-owned model catalog used by compatibility tests."""
    global _supported_models
    _supported_models = supported_models


@app.get("/api/containers/{cid}/active-conversations")
def active_conversations(cid: str):
    """E3: the resident-session manager's read-only discovery scan. Every ACTIVE
    conversation in the container with its last-turn {role, seq}, so the daemon can
    find conversations whose latest turn is an unanswered HUMAN turn (`pending_human`)
    — work for the resident to answer.

    Deliberately OFF the wake/ack event cursor for CONVERSATION delivery: the resident
    manager services any conversation whose last turn is human and whose `last_turn_seq`
    exceeds the seq it last serviced (an in-memory per-conversation cursor), so resident
    delivery is idempotent and never contends with the ephemeral headless path's delivered_ts.

    ISS-74: it ALSO reports `pending_inbox` — the count of NON-conversation events queued for
    this conversation's agent past its wake cursor (event_name NOT IN digest_snapshotted /
    conversation_turn / _RESIDENT_DRAIN_AUDIT_EVENTS — see ISS-75) plus `inbox_ack_ts` (the max ts
    of a COUNTED event, to ack after draining). A warm resident
    holds the single-embodiment lease, so the wake gate suppresses every ephemeral wake for its
    agent (decision/task_message/request_* QUEUE). The daemon uses these fields to inject a
    one-shot inbox-drain turn INTO the warm resident so those events are still handled. We
    exclude `conversation_turn` (the resident already handles those via `pending_human`) so this
    never fires on conversation activity and never touches the ephemeral/headless conversation
    fallback (which still wakes on conversation_turn when no resident is live)."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    excl = (
        list(_NON_WAKING_EVENTS)
        + ["conversation_turn"]
        + list(_RESIDENT_DRAIN_AUDIT_EVENTS)
    )
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        cur.execute(
            """SELECT cv.id AS conversation_id, cv.agent_id, a.alias AS agent_alias, a.model,
                      a.reasoning_effort,
                      cv.session_id, cv.status, cv.last_turn_at,
                      -- #266: the clock-driven auto-wake inputs, so an idle warm resident can YIELD
                      -- its lease when the cadence is due (the wake then fires ephemeral, never
                      -- injected — ISS-78). Same truth table as wake_scan's auto_wake_due.
                      a.auto_wake_interval_secs, a.turns_used, a.turn_budget,
                      EXTRACT(EPOCH FROM (now() - ws.last_woken_at)) AS _secs_since_woken,
                      -- ISS-70: force a one-shot COLD boot when this agent's latest memory digest is
                      -- NEWER than when the resident's session was pinned (a digest written by another
                      -- embodiment the warm --resume would never re-read). FALSE when no session is
                      -- pinned (the boot is cold anyway via `not session_id`); TRUE for a pinned
                      -- session whose pin predates the digest, or a pre-ISS-70 pin with NULL timestamp
                      -- (re-inject the digest once). Uses idx_digest_agent_ts(agent_id, snapshot_ts).
                      CASE
                        WHEN cv.session_id IS NULL THEN false
                        WHEN cv.session_pinned_at IS NULL THEN true
                        ELSE COALESCE(
                            (SELECT max(d.snapshot_ts) FROM agent_memory_digests d
                              WHERE d.agent_id = cv.agent_id)
                            > extract(epoch FROM cv.session_pinned_at), false)
                      END AS cold_required,
                      t.seq AS last_turn_seq, t.role AS last_turn_role,
                      COALESCE(ws.delivered_ts, 0) AS _delivered_ts,
                      (SELECT max(ev.ts) FROM agent_events ev
                         WHERE ev.event_key = cv.agent_id::text
                           AND ev.ts > COALESCE(ws.conv_delivered_ts, 0)
                           AND ev.event_name = 'conversation_turn') AS conversation_ack_ts,
                      -- GH #58 (review fix): anti-join agent_event_acks so an ALREADY-handled row
                      -- never counts as pending_inbox. A `request_closed` audit row (excluded from
                      -- the resident drain) pins the contiguous floor LOW, so a later already-acked
                      -- row sits ABOVE the floor; without this anti-join it inflated pending_inbox
                      -- while drain_ackable_ids (which DOES anti-join) stayed empty — the resident
                      -- then kept spawning no-op drain sidecars. Now consistent with the floor
                      -- recompute, the manifest, _collect_directed_messages and drain_ackable_ids.
                      COALESCE((SELECT count(*) FROM agent_events ev
                                 WHERE ev.event_key = cv.agent_id::text
                                   AND ev.ts > COALESCE(ws.delivered_ts, 0)
                                   AND ev.event_name <> ALL(%s)
                                   AND NOT EXISTS (SELECT 1 FROM agent_event_acks a
                                                    WHERE a.agent_id = cv.agent_id
                                                      AND a.event_id = ev.id)), 0) AS pending_inbox,
                      (SELECT max(ev.ts) FROM agent_events ev
                         WHERE ev.event_key = cv.agent_id::text
                           AND ev.ts > COALESCE(ws.delivered_ts, 0)
                           AND ev.event_name <> ALL(%s)
                           AND NOT EXISTS (SELECT 1 FROM agent_event_acks a
                                            WHERE a.agent_id = cv.agent_id
                                              AND a.event_id = ev.id)) AS _inbox_max_ts
               FROM conversations cv
               JOIN agents a ON a.id = cv.agent_id
               LEFT JOIN agent_wake_state ws ON ws.agent_id = cv.agent_id
               LEFT JOIN LATERAL (
                   SELECT seq, role FROM conversation_turns
                   WHERE conversation_id = cv.id ORDER BY seq DESC LIMIT 1
               ) t ON true
               WHERE cv.container_id = %s AND cv.status = 'active'
               ORDER BY cv.last_turn_at ASC NULLS FIRST""",
            (excl, excl, cid),
        )
        convs = cur.fetchall()
        for r in convs:
            # last_turn_role is NULL only for a brand-new conversation with no turns yet.
            r["last_turn_seq"] = r["last_turn_seq"] or 0
            r["pending_human"] = r["last_turn_role"] == "human"
            r["pending_inbox"] = r["pending_inbox"] or 0
            _auto_iv = r["auto_wake_interval_secs"]
            _ssw = r["_secs_since_woken"]
            r["auto_wake_due"] = bool(
                _auto_iv is not None and (_ssw is None or _ssw >= _auto_iv)
            )
            r.pop("turns_used", None)
            r.pop("turn_budget", None)
            r.pop("_secs_since_woken", None)
            r["model"] = _resolve_model(r["model"], _supported_models())
            r["model_runtime"] = _resolve_model_runtime(r["model"], _supported_models())
            r["reasoning_effort"] = resolve_reasoning_effort(
                r["reasoning_effort"]
            )  # GH #51
            if r["pending_inbox"]:
                msgs, _tid, ack_ts = collect_directed_messages(
                    cur,
                    str(r["agent_id"]),
                    r["_delivered_ts"],
                    r["_inbox_max_ts"],
                    max_chars=MAX_PROMPT_BATCH_CHARS,
                    render_attachment_feed_line=_render_attachment_feed_line,
                    drain_class=_drain_class,
                )
                r["inbox_messages"] = [m["text"] for m in msgs]
                r["inbox_ack_ts"] = ack_ts
                floor = _earliest_actionable_answer_ts(
                    cur, str(r["agent_id"]), r["_delivered_ts"]
                )
                if floor is not None:
                    cur.execute(
                        """SELECT count(*) AS n, max(ts) AS mx FROM agent_events
                           WHERE event_key = %s AND ts > %s AND ts < %s
                             AND event_name <> ALL(%s)""",
                        (str(r["agent_id"]), r["_delivered_ts"], floor, excl),
                    )
                    drow = cur.fetchone()
                    r["drainable_inbox"] = drow["n"] or 0
                    safe = drow[
                        "mx"
                    ]  # newest drainable event ts strictly before the answer (or None)
                    if safe is None:
                        r["inbox_ack_ts"] = None
                    elif ack_ts is None:
                        r["inbox_ack_ts"] = safe
                    else:
                        r["inbox_ack_ts"] = min(ack_ts, safe)
                else:
                    r["drainable_inbox"] = r["pending_inbox"]
                r["inbox_wake_task_id"] = _resident_inbox_task_work_id(
                    cur,
                    str(r["agent_id"]),
                    r["_delivered_ts"],
                    r["_inbox_max_ts"],
                    valid_uuid=_valid_uuid,
                )
            else:
                r["inbox_messages"] = []
                r["inbox_ack_ts"] = None
                r["drainable_inbox"] = 0
                r["inbox_wake_task_id"] = None
            drain_taskbound = 0
            drain_ackable_ids: list[int] = []
            if r["pending_inbox"]:
                cur.execute(
                    """SELECT e.id, e.event_name, e.payload, e.target_id FROM agent_events e
                       WHERE e.event_key=%s AND e.ts > %s AND e.event_name <> ALL(%s)
                         AND NOT EXISTS (SELECT 1 FROM agent_event_acks a
                                          WHERE a.agent_id=%s AND a.event_id=e.id)
                       ORDER BY e.ts, e.id""",
                    (str(r["agent_id"]), r["_delivered_ts"], excl, str(r["agent_id"])),
                )
                for _row in cur.fetchall():
                    _b = _drain_class(
                        cur,
                        _row["event_name"],
                        _row["payload"],
                        target_id=_row["target_id"],
                    )["bucket"]
                    if _b in _DRAIN_RUN_ACKABLE:
                        drain_ackable_ids.append(_row["id"])
                    elif _b in (_DRAIN_TASK_BOUND, _DRAIN_NEW_WORK, _DRAIN_DIRECTIVE):
                        drain_taskbound += 1
            r["drain_taskbound"] = drain_taskbound
            r["drain_ackable_ids"] = drain_ackable_ids
            r.pop("_delivered_ts", None)
            r.pop("_inbox_max_ts", None)
    return {"container_id": cid, "conversations": convs}
