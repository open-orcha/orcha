"""Define fail-safe wake-triage and routine-handoff decision policies."""

from __future__ import annotations

from typing import Callable, Optional

TRIAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "wake": {
            "type": "boolean",
            "description": "Whether this event needs the agent to wake.",
        },
        "reason": {
            "type": "string",
            "description": "One short sentence justifying the decision.",
        },
    },
    "required": ["wake", "reason"],
}

_TRIAGE_SYSTEM = (
    "Decide whether an autonomous agent must be WOKEN for an incoming event. Wake if the event "
    "needs a response, changes task state, asks a question, or carries a review verdict. Review "
    "verdicts are workflow commands, not acknowledgements; they include CLEAN, APPROVED, PASS, "
    "LGTM, NEEDS CHANGES, REQUEST CHANGES, and BLOCKED, so return wake=true for them. "
    "Skip only pure acknowledgements or FYIs that need no action. When uncertain, prefer to WAKE."
)

HANDOFF_ACK_SCHEMA = {
    "type": "object",
    "properties": {
        "ack": {
            "type": "boolean",
            "description": "True only when a brief acknowledgement fully closes the loop.",
        },
        "text": {
            "type": "string",
            "description": "A short acknowledgement, meaningful only when ack is true.",
        },
    },
    "required": ["ack", "text"],
}

_HANDOFF_ACK_SYSTEM = (
    "Decide whether a routine handoff needs only a brief acknowledgement. Return ack=false if it "
    "asks for work, a change, a rebase, an answer, or a decision. Never auto-ack and close a "
    "review verdict. Verdicts include CLEAN, APPROVED, PASS, LGTM, NEEDS CHANGES, "
    "REQUEST CHANGES, and BLOCKED. When in "
    "doubt return ack=false so the full agent handles it."
)


def triage_wake(
    event_text: str,
    *,
    classify: Callable,
    log_failure: Callable,
    resolve_spec: Callable,
    system: Optional[str] = None,
    config: Optional[dict] = None,
    api_key: Optional[str] = None,
    provider=None,
) -> dict:
    """Classify an event, failing open toward a wake on every uncertainty."""
    spec = resolve_spec("triage", config=config)
    try:
        result = classify(
            "triage",
            system=system or _TRIAGE_SYSTEM,
            user=event_text,
            schema=TRIAGE_SCHEMA,
            config=config,
            api_key=api_key,
            provider=provider,
        )
        return {
            "wake": result.get("wake", True) is not False,
            "reason": str(result.get("reason", "")),
        }
    except Exception as exc:
        log_failure(
            use_case="triage",
            spec=spec,
            outcome="fail_open",
            latency_ms=0,
            error=str(exc),
        )
        return {"wake": True, "reason": f"fail-open: {exc}"}


def handoff_ack(
    handoff_text: str,
    *,
    classify: Callable,
    log_failure: Callable,
    resolve_spec: Callable,
    system: Optional[str] = None,
    config: Optional[dict] = None,
    api_key: Optional[str] = None,
    provider=None,
) -> dict:
    """Classify a handoff, failing closed toward a full wake on uncertainty."""
    spec = resolve_spec("ack", config=config)
    try:
        result = classify(
            "ack",
            system=system or _HANDOFF_ACK_SYSTEM,
            user=handoff_text,
            schema=HANDOFF_ACK_SCHEMA,
            config=config,
            api_key=api_key,
            provider=provider,
        )
        text = (result.get("text") or "").strip()
        if result.get("ack") is True and text:
            return {"ack": True, "text": text}
    except Exception as exc:
        log_failure(
            use_case="ack",
            spec=spec,
            outcome="fail_closed",
            latency_ms=0,
            error=str(exc),
        )
    return {"ack": False, "text": ""}
