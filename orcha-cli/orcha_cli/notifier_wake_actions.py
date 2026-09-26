"""Apply cheap notifier wake actions and advance delivery cursors safely."""

from __future__ import annotations

import json
import sys
from collections.abc import Callable


def ack_config_from_scan(scan: dict) -> dict | None:
    """Translate a wake-scan acknowledgement model into the universal-client shape."""
    model = (scan or {}).get("ack_model")
    if isinstance(model, dict) and (model.get("provider") or model.get("model")):
        return {"ack": model}
    return None


def log_graded_wake(verdict: dict, autonomy_level, acted: bool) -> None:
    """Emit the structured record consumed by the continuity evaluation harness."""
    try:
        record = json.dumps(
            {
                "event": "graded_wake",
                "tier": verdict.get("tier"),
                "action": verdict.get("action"),
                "acted": bool(acted),
                "would_boot": True,
                "autonomy_level": autonomy_level,
            }
        )
        print(f"[notifier] graded_wake {record}", flush=True)
    except (OSError, TypeError, ValueError):
        pass


def advance_wake_cursor(
    api_base: str,
    cand: dict,
    event,
    *,
    post_json: Callable,
) -> None:
    """Acknowledge the surfaced event batch without releasing the agent lease."""
    ack_ts = cand.get("ack_through_ts")
    if ack_ts is None:
        ack_ts = cand.get("max_event_ts")
    post_json(
        f"{api_base}/api/agents/{cand['agent_id']}/wake-ack",
        {
            "delivered_ts": ack_ts,
            "kind": "skipped",
            "event": event,
            "release_lease": False,
        },
    )


def request_actionable(api_base: str, rid: str, *, get_json: Callable) -> bool | None:
    """Return whether an answered request still needs its routine close action."""
    data = get_json(f"{api_base}/api/requests/{rid}")
    if not isinstance(data, dict):
        return None
    status = data.get("status")
    if not status:
        return None
    return status == "answered"


def apply_wake_act(
    api_base: str,
    cand: dict,
    event,
    verdict: dict,
    *,
    quiet: bool,
    llm_util,
    get_json: Callable,
    post_json: Callable,
    ack_config: dict | None = None,
    ack_api_key: str | None = None,
) -> bool:
    """Perform a cheap routine handoff, escalating safely when it cannot be completed."""
    action = verdict.get("action")
    target = (
        verdict.get("request_id")
        if action == "ack_close"
        else (verdict.get("task_id") if action == "ack_verify" else None)
    )
    if not target:
        return False

    if (
        action == "ack_close"
        and request_actionable(
            api_base,
            target,
            get_json=get_json,
        )
        is False
    ):
        if not quiet:
            print(
                f"[notifier] ack_close for {cand.get('alias')} is already resolved "
                f"(request {str(target)[:8]} not 'answered') — advancing cursor, NO boot (GH#36)"
            )
        advance_wake_cursor(api_base, cand, event, post_json=post_json)
        return True
    if llm_util is None:
        return False
    try:
        decision = llm_util.handoff_ack(
            verdict.get("text") or "",
            config=ack_config,
            api_key=ack_api_key,
        )
    except Exception:  # noqa: BLE001 - model/provider failures must escalate rather than crash
        return False
    line = (decision.get("text") or "").strip() if isinstance(decision, dict) else ""
    if not (isinstance(decision, dict) and decision.get("ack") and line):
        return False

    if action == "ack_close":
        response = post_json(
            f"{api_base}/api/requests/{target}/triage-close",
            {"triage_reason": line[:500]},
        )
    else:
        response = post_json(
            f"{api_base}/api/tasks/{target}/messages",
            {"author_agent_id": cand["agent_id"], "body": line},
        )
    if response is None:
        if not quiet:
            print(
                f"[notifier] WARN T2 {action} write failed for {cand.get('alias')} "
                "— escalating to a full boot (cursor not advanced)",
                file=sys.stderr,
            )
        return False
    advance_wake_cursor(api_base, cand, event, post_json=post_json)
    return True


def suppress_wake(
    api_base: str,
    cand: dict,
    event,
    suppress: dict,
    *,
    quiet: bool,
    post_json: Callable,
) -> None:
    """Close a suppressible request and acknowledge its event without spawning."""
    rid = suppress.get("request_id")
    if rid:
        response = post_json(
            f"{api_base}/api/requests/{rid}/triage-close",
            {"triage_reason": (suppress.get("reason") or "")[:500]},
        )
        if response is None and not quiet:
            print(
                f"[notifier] WARN triage-close failed for request {rid} "
                f"({cand.get('alias')}) — wake still suppressed; request stays 'answered'",
                file=sys.stderr,
            )
    advance_wake_cursor(api_base, cand, event, post_json=post_json)
