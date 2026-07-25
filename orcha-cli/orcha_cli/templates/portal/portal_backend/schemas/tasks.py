"""Task creation and working-agreement API schemas."""

from typing import Optional

from pydantic import BaseModel, Field

from portal_backend.limits import (
    MAX_DESC_LEN,
    MAX_DOD_LEN,
    MAX_NAME_LEN,
    MAX_PROTOCOL_FIELD_LEN,
)


class ProtocolFields(BaseModel):
    """SPEC-4: the per-task working agreement — four OPTIONAL free-text strings. `autonomy`
    is FREE TEXT for now (NOT an L1/L2/L3 enum; that waits on the SPEC-1 autonomy design-call).
    Used both as the create-time `protocol` block and (with actor_agent_id) as the PATCH body."""

    review_chain: Optional[str] = Field(
        default=None, max_length=MAX_PROTOCOL_FIELD_LEN
    )
    handoff_to: Optional[str] = Field(
        default=None, max_length=MAX_PROTOCOL_FIELD_LEN
    )
    autonomy: Optional[str] = Field(
        default=None, max_length=MAX_PROTOCOL_FIELD_LEN
    )
    notes: Optional[str] = Field(
        default=None, max_length=MAX_PROTOCOL_FIELD_LEN
    )


class ProtocolUpdate(ProtocolFields):
    """PATCH /api/tasks/{tid}/protocol body. PARTIAL update: only the keys explicitly sent are
    merged into the existing protocol (omitted keys are preserved). Actor: human or dispatching
    AI orchestrator (#327); editing `autonomy` stays human-only."""

    actor_agent_id: str = Field(
        ...,
        description=(
            "UUID of the actor (human or dispatching AI); "
            "autonomy edits stay human-only (#327)"
        ),
    )


class TaskCreateBody(BaseModel):
    title: str = Field(..., max_length=MAX_NAME_LEN)
    description: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    definition_of_done: str = Field(..., max_length=MAX_DOD_LEN)
    priority: int = 100
    created_by_agent_id: Optional[str] = None
    assignee_alias: Optional[str] = Field(default=None, max_length=64)
    depends_on: list[str] = Field(default_factory=list)
    protocol: Optional[ProtocolFields] = None
    not_ready: bool = False
