"""Derive canonical next-action ownership for request read models."""

from datetime import datetime, timezone

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
