"""Task-thread read contract, including exact forward and backward cursors."""

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_serializer


class TaskThreadHeader(BaseModel):
    title: str
    description: Optional[str] = None
    definition_of_done: Optional[str] = None


class TaskThreadMessage(BaseModel):
    message_id: UUID
    author_id: Optional[UUID]
    author_alias: Optional[str]
    is_human: bool
    body: str
    attachments: list[dict[str, Any]]
    created_at: datetime

    @field_serializer("created_at")
    def serialize_created_at(self, value: datetime) -> str:
        return value.isoformat()


class TaskThreadResponse(BaseModel):
    task_id: str
    task: TaskThreadHeader
    messages: list[TaskThreadMessage]
    has_more: Optional[bool] = None
    next_before: Optional[str] = None
    next_before_id: Optional[str] = None
    next_after: Optional[str] = Field(
        default=None,
        description="Exclusive forward timestamp; retained even at the current end of the thread.",
    )
    next_after_id: Optional[str] = Field(
        default=None,
        description="Message identity paired with next_after, so timestamp ties cannot lose guidance.",
    )
