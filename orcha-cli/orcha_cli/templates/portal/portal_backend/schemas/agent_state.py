"""Request contracts for agent state endpoints."""

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

from portal_backend.limits import (
    MAX_DESC_LEN,
    MAX_FEEDBACK_LEN,
    MAX_NAME_LEN,
    MAX_PAYLOAD_LEN,
    MAX_PROMPT_LEN,
    MAX_SELF_WAKE_CONTEXT_LEN,
)


class AgentRetire(BaseModel):
    """ISS-51: retire an agent. Human-authority gated (actor must be kind='human')."""

    actor_agent_id: str


class AgentModelUpdate(BaseModel):
    """B8.1: change the LLM model an agent runs on. Must be one of the curated ids
    (AVAILABLE_MODELS); new providers are added there as supported."""

    model: str = Field(..., max_length=64)


class AgentReasoningEffortUpdate(BaseModel):
    """GH #51: change the reasoning effort an agent's worker runs at. Must be one of the
    curated levels (AVAILABLE_REASONING_EFFORTS), or null to use the runtime default."""

    reasoning_effort: Optional[str] = Field(..., max_length=16)


class AgentUpdate(BaseModel):
    """Agent-update: edit an agent's role / system_prompt / alias / autonomy_override
    (onboarding + re-profiles). Human-authority gated. All fields optional except the actor — a
    PARTIAL update: omit a field to leave it unchanged.

    mig 034: `autonomy_override` is nullable-and-meaningful — supplying null CLEARS the override
    (inherit the container level), while OMITTING it leaves the current override untouched. The
    route distinguishes the two via `model_fields_set` (not the None value), since None is a real
    target here. The Literal makes a bad enum value a 422 BEFORE the route body runs — an
    unvalidated string must never reach the hard completion gate. Humans carry no override
    (rejected in the route)."""

    actor_agent_id: str
    role: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN)
    system_prompt: Optional[str] = Field(default=None, max_length=MAX_PROMPT_LEN)
    alias: Optional[str] = Field(default=None, max_length=64)
    autonomy_override: Optional[Literal["plan", "pr", "full"]] = Field(default=None)


class AutoWakeUpdate(BaseModel):
    """#266: set/clear an agent's clock-driven AUTO-WAKE cadence. HUMAN-AUTHORITY gated.
    `interval_secs` is REQUIRED but NULLABLE — send an int (>=60s floor) to enable a recurring
    heartbeat wake, or null to DISABLE (opt-out). Unlike a partial PATCH (where an omitted field
    means 'unchanged'), the value is always explicit here, so null unambiguously means 'disable'
    rather than 'don't touch'. The 60s floor + nullability are also enforced by the DB CHECK."""

    actor_agent_id: str
    interval_secs: Optional[int] = Field(
        ...,
        ge=60,
        description="seconds between clock-driven auto-wakes (>=60s floor); null disables auto-wake",
    )


class SelfWakeSet(BaseModel):
    """GH #122: an ephemeral worker schedules a one-shot resume wake for active task work."""

    task_id: str = Field(..., description="task the worker is actively waiting on")
    delay_secs: Optional[int] = Field(
        default=None, ge=60, le=86_400, description="wake after this many seconds"
    )
    resume_in_seconds: Optional[int] = Field(
        default=None, ge=60, le=86_400, description="compat alias for delay_secs"
    )
    resume_at: Optional[datetime] = Field(
        default=None, description="absolute wake time; must be at least 60s out"
    )
    context: str = Field(
        ...,
        max_length=MAX_SELF_WAKE_CONTEXT_LEN,
        description="short, non-empty wait-point to inject on the scheduled wake",
    )


class ReachabilityUpsert(BaseModel):
    """Epic A: how the notifier daemon can reach this agent's Claude session to wake it.

    Recorded at /orcha-register-agent and refreshed at SessionStart (the tmux pane
    changes every session). Partial upsert — only the fields supplied are written,
    so SessionStart can refresh tmux_target without clobbering a wake_enabled=false
    opt-out the human set earlier.
    """

    tmux_target: Optional[str] = Field(
        default=None,
        max_length=MAX_NAME_LEN,
        description='"session:window.pane" for live send-keys wakes',
    )
    headless_cwd: Optional[str] = Field(
        default=None,
        max_length=MAX_DESC_LEN,
        description="project dir for out-of-band `claude -p` wakes",
    )
    headless_flags: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    wake_enabled: Optional[bool] = Field(
        default=None, description="ON by default; set false to opt out of wakes"
    )


class DigestSnapshot(BaseModel):
    """Epic C / D3: one per-agent memory digest the agent composes + POSTs.

    The server never synthesises these (reasoning isn't derivable from rows); it
    only stores what the agent sends. current_focus is a one-liner; the three
    lists are free-form [{text, ...}] objects (or bare strings, normalised on
    write). See docs/epic-c-agent-digest-plan.md for the ownership boundary.
    """

    current_focus: Optional[str] = Field(default=None, max_length=MAX_PAYLOAD_LEN)
    decisions: list = Field(default_factory=list)
    learnings: list = Field(default_factory=list)
    open_threads: list = Field(default_factory=list)
    # #325: the plain-language conversational register — who the agent is talking to,
    # their vocabulary, what they already understand. Free text, like current_focus.
    # Carried across wakes so tone survives (the facts above never captured HOW to talk
    # to a human, so each wake the agent reverted to internal jargon). Optional/additive.
    audience: Optional[str] = Field(default=None, max_length=MAX_PAYLOAD_LEN)


class DecisionCreate(BaseModel):
    """B0 / G1: the one shape every human-decision surface speaks.

    A decision is `approve` or `reject` plus a free-text `reason` (REQUIRED on
    reject, optional on approve). subject_type/subject_id name what's being decided
    (a task verify, a request, a checkpoint, a dummy demo) so a single endpoint
    serves every surface. The decision + reason are persisted (auditable) and an
    event is routed to target_agent_id so the agent sees *why* on its next wake.
    """

    subject_type: str = Field(
        ...,
        max_length=MAX_NAME_LEN,
        description="what's being decided, e.g. 'task_verify'|'request'|'checkpoint'|'dummy'",
    )
    subject_id: str = Field(
        ...,
        max_length=MAX_NAME_LEN,
        description="id of the thing being decided (task/request/etc)",
    )
    decision: Literal["approve", "reject"]
    reason: Optional[str] = Field(
        default=None,
        max_length=MAX_FEEDBACK_LEN,
        description="REQUIRED on reject, optional on approve",
    )
    actor_agent_id: str = Field(
        ..., description="UUID of the deciding human (kind='human')"
    )
    target_agent_id: Optional[str] = Field(
        default=None,
        description="agent that consumes {decision,reason} on next wake (omit if none)",
    )


class NotificationsRead(BaseModel):
    through_ts: Optional[float] = Field(
        None,
        description="advance the read cursor to this bus ts (epoch seconds); omit to mark ALL "
        "current notifications read (cursor jumps to the agent's newest event ts)",
    )
