"""Shared protocol normalization and report-back instructions."""

from typing import Any, Optional

from portal_backend.limits import MAX_PROTOCOL_FIELD_LEN
from portal_backend.schemas import ProtocolFields


def _clean_protocol(raw: Any) -> Optional[dict]:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("protocol must be an object or null")
    cleaned = ProtocolFields(
        **{k: raw.get(k) for k in ("review_chain", "handoff_to", "autonomy", "notes")}
    )
    data = cleaned.model_dump(exclude_none=True)
    return data or None


def _build_report_back(rid: str, dod: str) -> str:
    """GH #56 (Point 4.4/4.5): the report-back instruction for a request-born task. It is
    injected into the spawned task's protocol.notes AND echoed in the accept response so the
    same worker session sees it immediately. Derived purely from (rid, dod) so the fresh
    accept and the idempotent retry (first response lost) return the IDENTICAL instruction —
    a retry must never fall back to the old, instruction-less response shape (review P-retry)."""
    text = (
        f"REPORT BACK: when you've materially finished this task — i.e. "
        f"{dod.strip() or 'the requested work is complete'} — post your result to request {rid} "
        f'(/orcha-respond {rid} "...") BEFORE moving on. Reporting back is a separate, '
        f"agent-judged step: it is NOT /orcha-done (which only sends this task to human "
        f"verification, and may still be pending after you report back)."
    )
    return text[:MAX_PROTOCOL_FIELD_LEN]
