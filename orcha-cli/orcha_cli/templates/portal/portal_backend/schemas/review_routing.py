"""Manager review handoff (mig 057): the project's review routing + AI manager pre-review."""

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

from portal_backend.limits import MAX_FEEDBACK_LEN

ReviewRoute = Literal["manager_chain", "owner", "anyone"]


class ReviewRoutingUpdate(BaseModel):
    """PUT /api/containers/{cid}/review-routing — owner-or-assign_reviewers, human only."""

    review_route: Optional[ReviewRoute] = Field(
        default=None,
        description="where finished work goes for verification: 'manager_chain' (the "
        "assignee's nearest human manager; anyone when there is no reporting line), "
        "'owner' (the project owner) or 'anyone'. Omit to keep the current value.",
    )
    ai_manager_prereview: Optional[bool] = Field(
        default=None,
        description="when an AI manager sits between the assignee and the human reviewer, "
        "ask it to pre-review first (advisory — a human still verifies). Omit to keep.",
    )
    actor_agent_id: Optional[str] = Field(
        default=None,
        description="the human making the change (self-host lane); ignored under the "
        "trusted proxy lane, where the signed-in member is the actor",
    )


class ReviewRoutingResponse(BaseModel):
    container_id: str
    review_route: ReviewRoute
    ai_manager_prereview: bool
    reporting_lines: int = Field(
        ..., description="live agents in this project that have a manager (reports_to set)"
    )
    reviewers: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="per human reviewer: {agent_id, alias, pending_reviews} for tasks "
        "awaiting verification routed to them",
    )


class ManagerReviewDecision(BaseModel):
    """POST /api/tasks/{tid}/manager-review — the AI manager's pre-review verdict."""

    agent_id: str = Field(..., description="the AI manager the pre-review was sent to")
    decision: Literal["approve", "send_back"]
    reasons: Optional[str] = Field(default=None, max_length=MAX_FEEDBACK_LEN)
