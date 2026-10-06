"""Org chart (mig 052): an agent's reporting line."""

from typing import List, Optional

from pydantic import BaseModel, Field


class ReportsToUpdate(BaseModel):
    """Set (or with null, clear) who an agent reports to. Human-authoritative."""

    reports_to_agent_id: Optional[str] = Field(
        ...,
        description=(
            "The manager's agent id (an AI or human agent in the SAME project); "
            "null clears the reporting line (the agent becomes a root)."
        ),
    )
    actor_agent_id: Optional[str] = Field(
        default=None,
        description=(
            "The human making the change (self-host lane). Under the trusted proxy lane the "
            "signed-in member is the actor and this is ignored."
        ),
    )


class ChainEntry(BaseModel):
    id: str
    alias: str
    kind: str
    member_role: Optional[str] = None
    terminated: bool = False


class ReportsToResponse(BaseModel):
    agent_id: str
    reports_to_agent_id: Optional[str] = None
    reports_to_alias: Optional[str] = None
    chain: List[ChainEntry] = Field(
        default_factory=list,
        description="Managers from the nearest upward (the chain of command).",
    )
