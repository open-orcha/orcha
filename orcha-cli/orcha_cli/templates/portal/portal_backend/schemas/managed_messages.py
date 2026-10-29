"""Bounded message recovery and explicit handled receipts for managed workers."""

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator
from pydantic_core import PydanticCustomError


class ManagedMessagePoll(BaseModel):
    limit: int = Field(default=50, ge=1, le=200)


class ManagedMessageHandle(BaseModel):
    outcome: Literal["applied", "not_applicable"]
    handling_note: str | None = Field(default=None, max_length=1000,
                                      description="Brief explanation; required when guidance cannot apply. Do not include credentials or logs.")

    @model_validator(mode="after")
    def require_explanation(self):
        if self.handling_note is not None:
            self.handling_note = self.handling_note.strip() or None
        if self.outcome == "not_applicable" and not self.handling_note:
            raise PydanticCustomError("managed_explanation_required", "Explain why this guidance cannot apply")
        return self


class MessagePosition(BaseModel):
    created_at: datetime
    message_id: UUID


class ManagedMessage(BaseModel):
    message_id: UUID
    created_at: datetime
    author_id: UUID | None
    author_alias: str | None
    author_kind: str | None
    author_role: str | None
    body: str
    attachments: list[dict[str, Any]]
    event_ids: list[int]
    operation_key: str


class ManagedTaskScope(BaseModel):
    title: str
    description: str | None
    definition_of_done: str | None
    work_revision: int
    autonomy: str


class ManagedMessagePage(BaseModel):
    task_id: UUID
    run_id: UUID
    task: ManagedTaskScope
    messages: list[ManagedMessage]
    has_more: bool
    received_position: MessagePosition | None
    handled_position: MessagePosition | None


class ManagedMessageReceipt(BaseModel):
    message_id: UUID
    outcome: Literal["applied", "not_applicable"]
    already_handled: bool
    handled_position: MessagePosition | None
