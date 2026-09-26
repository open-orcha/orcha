"""Prompt construction and stream framing for onboarding proposals."""

import json
import logging

from portal_backend.model_policy import MODEL_IDS as _MODEL_IDS
from portal_backend.schemas import ProposeBody

ONBOARDING_LOG = logging.getLogger("orcha.onboarding")


def _propose_sse(payload: dict) -> str:
    """House SSE frame format for SPEC-292's POST stream."""
    return f"data: {json.dumps(payload)}\n\n"


def _propose_error(code: str, message: str):
    """Terminal SPEC-292 error stream: exactly one error frame, then done."""
    ONBOARDING_LOG.warning(
        "POST /api/onboarding/propose SSE error code=%s message=%s", code, message
    )
    yield _propose_sse({"event": "error", "code": code, "message": message})
    yield _propose_sse({"event": "done"})


_ASK_CLARIFY_TOOL = {
    "name": "ask_clarifying_questions",
    "description": "Ask one to three short questions only when they are needed before drafting the roster.",
    "input_schema": {
        "type": "object",
        "properties": {
            "questions": {
                "type": "array",
                "minItems": 1,
                "maxItems": 3,
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "prompt": {"type": "string"},
                    },
                    "required": ["id", "prompt"],
                },
            },
        },
        "required": ["questions"],
    },
}


def _propose_roster_tool_schema() -> dict:
    """The SPEC-292 propose_roster tool schema, kept close to the route that uses it."""
    protocol_schema = {
        "type": ["object", "null"],
        "properties": {
            "review_chain": {"type": "string"},
            "handoff_to": {"type": "string"},
            "autonomy": {"type": "string"},
            "notes": {"type": "string"},
        },
        "additionalProperties": False,
    }
    return {
        "name": "propose_roster",
        "description": "Return an editable Orcha roster proposal. Do not create anything.",
        "input_schema": {
            "type": "object",
            "properties": {
                "rationale": {"type": "string"},
                "agents": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "role": {"type": "string"},
                            "charter": {"type": "string"},
                            "model_hint": {
                                "type": ["string", "null"],
                                "enum": [*_MODEL_IDS, None],
                            },
                        },
                        "required": ["name", "role", "charter"],
                    },
                },
                "tasks": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "definition_of_done": {"type": "string"},
                            "assignee": {"type": ["string", "null"]},
                            "depends_on": {
                                "type": "array",
                                "items": {"type": "string"},
                            },
                            "protocol": protocol_schema,
                            "is_kickoff": {"type": "boolean"},
                        },
                        "required": [
                            "title",
                            "definition_of_done",
                            "assignee",
                            "depends_on",
                            "is_kickoff",
                        ],
                    },
                },
            },
            "required": ["rationale", "agents", "tasks"],
        },
    }


def _propose_system_prompt(*, force_roster: bool) -> str:
    clarify_rule = (
        "If the goal is too vague, call ask_clarifying_questions with 1-3 short questions. "
        "If the goal is workable, call propose_roster."
        if not force_roster
        else "Do not ask another clarifying question. Call propose_roster now using the available context."
    )
    return (
        "You draft editable Orcha workspace rosters from a human's project goal. "
        "The proposal is advisory: the human will edit and commit through existing Orcha forms. "
        f"{clarify_rule}\n"
        "For propose_roster: include a concise rationale, at least one agent, and at least one task. "
        "Agent names must be unique. A task assignee must be one of the proposed agent names or null. "
        "depends_on entries must reference earlier task titles only. "
        "Each assignee with tasks must have exactly one kickoff task. "
        "Charters must tell agents to use Orcha requests for teamwork and stop at needs_verification."
    )


def _propose_messages(body: ProposeBody) -> list[dict]:
    messages = [{"role": "user", "content": "Project goal:\n" + body.goal.strip()}]
    for turn in body.dialogue:
        content = turn.content.strip()
        if content:
            messages.append({"role": turn.role, "content": content})
    return messages


def _propose_should_force_roster(body: ProposeBody) -> bool:
    user_text = "\n".join(t.content.lower() for t in body.dialogue if t.role == "user")
    if "skip clarifying" in user_text or "just propose" in user_text:
        return True
    # The UI appends one assistant turn per question; cap total questions at three.
    return sum(1 for t in body.dialogue if t.role == "assistant") >= 3


def _propose_roster_was_truncated(force_roster: bool, diag: dict) -> bool:
    if diag.get("stop_reason") == "max_tokens":
        return True
    # A forced tool call with started-but-incomplete or invalid JSON input is the
    # Anthropic streaming shape for an output-budget cut-off. Treat it as such
    # even if a provider/proxy omits stop_reason.
    return bool(
        force_roster
        and diag.get("started")
        and (not diag.get("completed") or diag.get("json_error"))
    )
