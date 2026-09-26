"""Request contracts for task operations endpoints."""

from typing import Optional

from pydantic import BaseModel, Field

from portal_backend.limits import MAX_FEEDBACK_LEN, MAX_PAYLOAD_LEN


class TaskMessage(BaseModel):
    author_agent_id: Optional[str] = None
    body: str = Field(..., max_length=MAX_PAYLOAD_LEN)
    # #301: optional attachment refs the client staged via POST .../attachments (uploaded
    # FIRST, then referenced here by stored `id`). Each is re-validated against disk on post
    # (see _validate_attachment_refs) — the client cannot poison the JSONB with arbitrary
    # paths/sizes. Each item: {"id": "<stored basename>", "name": "<display name>"}.
    attachments: Optional[list[dict]] = None


class TaskDone(BaseModel):
    agent_id: str
    result: str = Field(..., max_length=MAX_PAYLOAD_LEN)


class AssignTask(BaseModel):
    actor_agent_id: str = Field(
        ...,
        description="the actor (human or dispatching AI orchestrator) — Orcha#30 + #327",
    )
    agent_id: str = Field(..., description="the AI agent to assign this task to")
    reassign: bool = Field(
        default=False,
        description="if the task already has a DIFFERENT active assignee, release them and reassign (else 409)",
    )


class TaskReadiness(BaseModel):
    """#326 (B3): POST /api/tasks/{tid}/readiness — flip a task between 'not_ready' (held) and
    'ready' (dispatchable). HUMAN-AUTHORITY gated (#327: AI cannot yet flip readiness). Holding
    parks a ready/pending row as 'not_ready' so it leaves the ready-queue and can't be claimed via
    /orcha-next; releasing returns it to 'ready' (or 'pending' if its deps aren't satisfied)."""

    actor_agent_id: str = Field(
        ..., description="UUID of the human (kind='human') flipping readiness"
    )
    ready: bool = Field(
        ...,
        description="true = release to ready (or pending if deps unmet); false = hold as not_ready",
    )


class TaskReviewerUpdate(BaseModel):
    """PUT /api/tasks/{tid}/reviewer — owner names the human who should verify the task
    (collab v1). null clears it back to 'anyone'. Advisory: /verify stays permissive.
    `actor_agent_id` is the trust-off fallback actor (identity_routes.require_owner)."""

    reviewer_agent_id: Optional[str] = Field(
        default=None,
        description="UUID of the human member to assign as reviewer; null = anyone",
    )
    actor_agent_id: Optional[str] = Field(
        default=None,
        description="acting human's UUID when no trusted proxy identity is present",
    )


class TaskUnassign(BaseModel):
    """#326 (B2): POST /api/tasks/{tid}/unassign — clear the active assignee(s) so the row returns
    to the ready queue (owner==null). HUMAN-AUTHORITY gated (Orcha#30 — a deliberate dispatch reset,
    pairs with #327 AI-can't-assign). Mirrors the release half of the /assign reassign branch."""

    actor_agent_id: str = Field(
        ..., description="UUID of the human (kind='human') clearing the assignee"
    )


class TaskVerify(BaseModel):
    approve: bool
    feedback: Optional[str] = Field(default=None, max_length=MAX_FEEDBACK_LEN)
    actor_agent_id: str = Field(
        ..., description="UUID of the human agent verifying (kind='human')"
    )


class TaskCancel(BaseModel):
    """B7 (ISS-23) + #327: force-close a task. A human OR a dispatching AI orchestrator may cancel
    ANY non-root task. reason is required when the actor cancels a task assigned to someone else
    (routed to the displaced owner via the B0 decision primitive)."""

    actor_agent_id: str = Field(
        ...,
        description="UUID of the actor (human or AI orchestrator may cancel any non-root task)",
    )
    reason: Optional[str] = Field(default=None, max_length=MAX_FEEDBACK_LEN)
