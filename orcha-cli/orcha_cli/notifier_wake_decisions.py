"""Grade notifier wake candidates without performing host or API side effects."""

from __future__ import annotations

from collections.abc import Callable
from typing import Optional


_T2_ACTIONS = ("ack_close", "ack_verify")


def decide_wake_suppression(
    candidate: Optional[dict],
    *,
    triage_fn: Callable[[str], dict],
) -> Optional[dict]:
    """Return a suppression verdict only for confidently non-actionable wakes."""
    if (candidate or {}).get("has_pending_task_request"):
        return None
    hint = (candidate or {}).get("triage_hint")
    if not hint:
        return None
    tier = hint.get("tier")
    if tier == "structural":
        return {
            "tier": "structural",
            "reason": f"bare {hint.get('event_name')}",
            "request_id": hint.get("request_id"),
        }
    if tier != "llm":
        return None
    try:
        verdict = triage_fn(hint.get("text") or "")
    except Exception:
        return None
    if isinstance(verdict, dict) and verdict.get("wake") is False:
        return {
            "tier": "llm",
            "reason": str(verdict.get("reason", "")),
            "request_id": hint.get("request_id"),
        }
    return None


def decide_wake_tier(
    candidate: Optional[dict],
    *,
    triage_fn: Callable[[str], dict],
) -> dict:
    """Choose suppression, cheap action, or a full worker boot for a wake."""
    if (candidate or {}).get("has_pending_task_request"):
        return {"tier": "full", "reason": "owed task request — full boot"}
    hint = (candidate or {}).get("triage_hint")
    if not hint:
        return {"tier": "full"}
    suppression = decide_wake_suppression(candidate, triage_fn=triage_fn)
    if suppression is not None:
        return suppression
    t2 = hint.get("t2") if isinstance(hint, dict) else None
    action = t2.get("action") if isinstance(t2, dict) else None
    if action not in _T2_ACTIONS:
        return {"tier": "full"}
    verdict = {"tier": "act", "action": action, "text": hint.get("text") or ""}
    target_key = "request_id" if action == "ack_close" else "task_id"
    verdict[target_key] = t2.get(target_key)
    return verdict
