"""Request contracts for conversations endpoints."""

from typing import Optional

from pydantic import BaseModel, Field

from portal_backend.limits import MAX_TURN_LEN


class ConversationStart(BaseModel):
    """A human opens (or re-opens) the conversation with an AI agent."""

    actor_agent_id: str


class TurnAppend(BaseModel):
    """Append one turn. Human turn = the human's message; agent turn = ONE per stream-json
    'result' event (E2 findings), linked to its worker_run via run_id (the live token
    stream lives in worker_run_lines/ISS-39, not here)."""

    role: str = Field(..., pattern="^(human|agent)$")
    author_agent_id: str
    content: str = Field(..., max_length=MAX_TURN_LEN)
    run_id: Optional[str] = None
    meta: Optional[dict] = None
    # #338: staged attachment refs (each {"id": <stored basename>, ...}), validated against this
    # conversation's on-disk store before persist — mirrors TaskMessage.attachments (#330). Typed
    # as an object-array (list[dict]) so the OpenAPI schema matches the route's runtime contract
    # (_validate_attachment_refs requires each item be an object, main.py:846).
    attachments: Optional[list[dict]] = None


class ConversationSession(BaseModel):
    """Record the claude --session-id so the resident can pin/resume the same session."""

    session_id: str


class ConversationActor(BaseModel):
    actor_agent_id: str
