"""Request contracts for requests endpoints."""

from typing import Optional

from pydantic import BaseModel, Field

from portal_backend.limits import (
    MAX_DESC_LEN,
    MAX_DOD_LEN,
    MAX_FEEDBACK_LEN,
    MAX_NAME_LEN,
    MAX_PAYLOAD_LEN,
    MAX_PROMPT_LEN,
)
from portal_backend.schemas.tasks import ProtocolFields


class TaskRequestPayload(BaseModel):
    """Embedded inside a request when type='task' (Orcha#5, Phase 3)."""

    title: str = Field(..., max_length=MAX_NAME_LEN)
    description: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    definition_of_done: str = Field(..., max_length=MAX_DOD_LEN)
    priority: int = 100
    # GH #55: a task request may carry the per-task protocol (loop rules). It rides in the
    # request's `detail` JSONB (no schema change) and is read into the spawned task's protocol
    # on /accept-task — so a request-born task gets its loop rules without a follow-up PATCH.
    protocol: Optional[ProtocolFields] = None


class RequestCreate(BaseModel):
    requester_agent_id: str
    target_alias: Optional[str] = Field(
        default=None, max_length=64
    )  # mutually exclusive with target_agent_id
    target_agent_id: Optional[str] = (
        None  # ditto; both null → API picks the human via _pick_human() (Orcha#30)
    )
    payload: str = Field(..., max_length=MAX_PAYLOAD_LEN)
    priority: int = 100
    expires_minutes: int = Field(default=60, ge=0, le=10080)  # cap at 7 days
    parent_request_id: Optional[str] = None  # Orcha#1: chain off another request
    # GH #56 (Point 3): the task the REQUESTER was working on when it asked. Optional + agent-supplied
    # (never backend-guessed — a requester can have several tasks in progress). Null for conversation /
    # taskless asks. When present it is server-validated (must be a real task in this container the
    # requester participates in) and then rides the answer back so the requester wakes ON that task.
    originating_task_id: Optional[str] = None
    # Phase 3 (Orcha#5):
    type: str = Field(default="info", pattern="^(info|task)$")
    task: Optional[TaskRequestPayload] = None


class RequestRespond(BaseModel):
    responder_agent_id: str
    response: str = Field(..., max_length=MAX_PAYLOAD_LEN)


class RequestActorBody(BaseModel):
    requester_agent_id: str
    reason: Optional[str] = Field(default=None, max_length=MAX_FEEDBACK_LEN)


class TaskRequestAccept(BaseModel):
    """Target agent accepts a task request. Creates the task, assigns, starts."""

    responder_agent_id: str
    note: Optional[str] = Field(default=None, max_length=MAX_FEEDBACK_LEN)


class TaskRequestReject(BaseModel):
    """Target agent rejects a task request."""

    responder_agent_id: str
    reason: str = Field(..., max_length=MAX_FEEDBACK_LEN)


class AgentSuggestion(BaseModel):
    """Requester suggests a new agent be created (after task-request rejection or directly)."""

    requester_agent_id: str
    proposed_alias: str = Field(..., max_length=64)
    proposed_role: str = Field(..., max_length=200)
    proposed_prompt: str = Field(..., max_length=MAX_PROMPT_LEN)
    rationale: str = Field(..., max_length=MAX_FEEDBACK_LEN)


class SuggestionDecision(BaseModel):
    """Human resolves an agent suggestion."""

    kind: str = Field(..., pattern="^(create|reassign|refuse)$")
    # for reassign: which existing agent gets the task
    target_alias: Optional[str] = Field(default=None, max_length=64)
    # for refuse: why
    reason: Optional[str] = Field(default=None, max_length=MAX_FEEDBACK_LEN)
    # for create: optional turn budget for the new agent (else default)
    turn_budget: Optional[int] = None
    actor_agent_id: str = Field(
        ..., description="UUID of the human agent deciding (kind='human')"
    )


class RequestConvert(BaseModel):
    """Convert an answered info request into a task (Phase 3)."""

    requester_agent_id: str
    title: str = Field(..., max_length=MAX_NAME_LEN)
    definition_of_done: str = Field(..., max_length=MAX_DOD_LEN)
    priority: int = 100
    assignee_alias: Optional[str] = Field(default=None, max_length=64)


class NudgeBody(BaseModel):
    """#60: a standalone request nudge — wakes whoever owns the NEXT ACTION, no state change."""

    actor_agent_id: str
    note: Optional[str] = Field(default=None, max_length=MAX_FEEDBACK_LEN)


class TriageCloseBody(BaseModel):
    """#288 wake-suppression: the notifier daemon auto-closes an ANSWERED request whose answer was
    a pure ack (no actionable follow-up), so the requester is never spawned just to close it."""

    triage_reason: Optional[str] = Field(
        default=None,
        max_length=500,
        description="why the wake was suppressed (the triage verdict reason) — stamped into the "
        "request_closed event JSONB so #289 can measure suppressions with no schema change",
    )
