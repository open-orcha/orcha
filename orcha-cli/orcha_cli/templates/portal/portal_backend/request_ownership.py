"""Derive canonical next-action ownership for request read models."""

from datetime import datetime, timezone

from portal_backend import sql

# Parity r1 (escalations): escalation keeps status='open' and only re-targets the request
# at a human (Orcha#30), so the status alone can never say "this was escalated". The audit
# log can: /escalate and the expires_at sweep both write an events row with
# event_type='escalated'. Every portal request read-model (snapshot + paged list) joins the
# LATEST such row and exposes, additively:
#   escalated            — bool, an escalation event exists for this request
#   escalated_at         — when it was (last) escalated, else NULL
#   escalated_from_id    — the agent it was escalated away from (NULL on pre-r1 events)
#   escalated_from_alias — that agent's alias; for pre-r1 events (no from_target_id in the
#                          detail) it falls back to the alias recorded on the request's own
#                          `created` event — the target it was born with, the only target an
#                          escalation can move it away from. NULL when neither is recorded.
# Uses idx_events_request_entity (mig 051). Consumers join REQUEST_ESCALATION_JOIN after
# `FROM requests` and add REQUEST_ESCALATION_COLUMNS to the select list; the join's
# columns are prefixed esc_* so unqualified requests columns stay unambiguous.
# GH #258 S2b: no LATERAL (SQLite has none) -- join the events row whose PK is the id of the
# latest escalation (a correlated scalar subquery), exposing the same esc.esc_at / esc.esc_detail.
REQUEST_ESCALATION_JOIN = """
    LEFT JOIN (
        SELECT ev.id AS esc_id, ev.created_at AS esc_at, ev.detail AS esc_detail
          FROM events ev
    ) esc ON esc.esc_id = (
        SELECT e.id
          FROM events e
         WHERE e.entity_type = 'request' AND e.entity_id = requests.id
           AND e.event_type = 'escalated'
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT 1
    )"""

REQUEST_ESCALATION_COLUMNS = """
    (esc.esc_at IS NOT NULL) AS escalated,
    esc.esc_at AS escalated_at,
    esc.esc_detail->>'from_target_id' AS escalated_from_id,
    CASE WHEN esc.esc_at IS NOT NULL THEN COALESCE(
        (SELECT fa.alias FROM agents fa
          WHERE CAST(fa.id AS TEXT) = esc.esc_detail->>'from_target_id'),
        esc.esc_detail->>'from_target_alias',
        (SELECT ce.detail->>'target_alias' FROM events ce
          WHERE ce.entity_type = 'request' AND ce.entity_id = requests.id
            AND ce.event_type = 'created'
          ORDER BY ce.created_at, ce.id
          LIMIT 1)
    ) END AS escalated_from_alias"""

# Parity r2 (additive): WHO closed a request and — for a human force-close — WHY.
# The close reason is persisted as a decisions row (subject_type='request_close', via
# decision_routing._route_close_reason) and the closer as the audit `closed` event's
# actor, but no read-model exposed either, so a closed request read only "Closed — no
# further action". Consumers add REQUEST_CLOSE_COLUMNS next to the escalation columns:
#   closed_by_alias — alias of the actor on the latest `closed` event (NULL for a
#                     system/triage close or a pre-audit row)
#   close_decision  — {reason, actor, at} of the latest request_close decision, else NULL
REQUEST_CLOSE_COLUMNS = f"""
    (SELECT ca.alias FROM events ce JOIN agents ca ON ca.id = ce.actor_id
      WHERE ce.entity_type = 'request' AND ce.entity_id = requests.id
        AND ce.event_type = 'closed'
      ORDER BY ce.created_at DESC, ce.id DESC
      LIMIT 1) AS closed_by_alias,
    (SELECT {sql.json_object("'reason'", "d.reason", "'actor'", "da.alias", "'at'", "d.created_at")}
       FROM decisions d LEFT JOIN agents da ON da.id = d.actor_agent_id
      WHERE d.subject_type = 'request_close' AND d.subject_id = CAST(requests.id AS TEXT)
      ORDER BY d.created_at DESC
      LIMIT 1) AS close_decision"""

# ISS-47: an answered request the requester never closed within a day is a dangling thread.
STALE_ANSWERED_SECS = 24 * 3600


def _annotate_request_ownership(rows, *, now=None):
    """ISS-47 — questions/decisions fragment across surfaces → dangling threads + ambiguous
    ownership. Stamp every request read-row with a CANONICAL next-action ownership so each
    surface (snapshot, container list, inbox, outbox) agrees on *who holds the ball* and
    *whether the thread is dangling*, instead of each consumer re-deriving it (the
    /orcha-inbox skill did this client-side). Added fields:

      owner_id        — agent who owns the next action: open→target, answered→requester, else None
      owner_alias     — that agent's alias, when the SQL resolved it (mixed all-request views do)
      pending_action  — 'answer' | 'close' | None
      is_stale        — dangling-thread signal: an OPEN request past its expiry, or an ANSWERED
                        request left unclosed past STALE_ANSWERED_SECS

    Mutates each row dict in place and returns the list. Tolerant of a row missing a column
    (computes only what the fields allow). No DB access, no state change — pure derive.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    for r in rows:
        status = r.get("status")
        if status == "open":
            owner = r.get("target_id")
            pending = "answer"
        elif status == "answered":
            owner = r.get("requester_id")
            pending = "close"
        else:
            owner = None
            pending = None
        r["owner_id"] = str(owner) if owner else None
        r["pending_action"] = pending
        r.setdefault(
            "owner_alias", None
        )  # mixed views resolve it in SQL; single-side views leave None
        stale = False
        if status == "open":
            exp = r.get("expires_at")
            if exp is not None and exp < now:
                stale = True
        elif status == "answered":
            rat = r.get("responded_at")
            if rat is not None and (now - rat).total_seconds() > STALE_ANSWERED_SECS:
                stale = True
        r["is_stale"] = stale
    return rows
