"""Agent registration schemas and its optional initial-task contract."""

from typing import Optional

from pydantic import BaseModel, Field

from portal_backend.limits import (
    MAX_DESC_LEN,
    MAX_DOD_LEN,
    MAX_NAME_LEN,
    MAX_PROMPT_LEN,
)


class InitialTask(BaseModel):
    title: str = Field(..., max_length=MAX_NAME_LEN)
    description: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    definition_of_done: str = Field(..., max_length=MAX_DOD_LEN)
    priority: int = 100


class AgentCreate(BaseModel):
    alias: str = Field(..., max_length=64)
    role: str = Field(..., max_length=200)
    prompt: Optional[str] = Field(
        default=None,
        description=(
            "System prompt that defines this agent "
            "(required for kind='ai'; omit for 'human')"
        ),
        max_length=MAX_PROMPT_LEN,
    )
    kind: str = Field(default="ai", pattern="^(ai|human)$")
    model: Optional[str] = Field(default=None, max_length=64)
    initial_task: Optional[InitialTask] = None


class AgentCreateResponse(BaseModel):
    agent_id: str
    alias: str
    container_id: str
    initial_task: Optional[dict] = None
