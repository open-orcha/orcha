"""Request contracts for wakes endpoints."""

from typing import Optional

from pydantic import BaseModel, Field

from portal_backend.limits import MAX_NAME_LEN, MAX_PAYLOAD_LEN


class WakeAck(BaseModel):
    """Notifier daemon acknowledges that it issued (or attempted) a wake."""

    delivered_ts: Optional[float] = Field(
        default=None,
        description="advance the agent's wake cursor to this agent_events.ts (omit if no events consumed)",
    )
    kind: str = Field(
        ...,
        description="tmux | ephemeral | resident | unreachable | skipped (or a *_killed/*_failed/released reason)",
    )
    lane: Optional[str] = Field(
        default=None,
        pattern="^(work|conversation)$",
        description="GH #91/#90: which lease slot this ack acts on. None -> resolved to 'work' for "
        "backward compat (existing ephemeral/live acks are work-lane; a resident "
        "conversation ack passes 'conversation'). release_lease / cursor advance / "
        "running->orphaned reconcile are all scoped to this lane.",
    )
    event: Optional[str] = Field(
        default=None,
        max_length=MAX_NAME_LEN,
        description="the event_name / reason that triggered the wake",
    )
    release_lease: bool = Field(
        default=False,
        description="R2.4: a one-shot worker that has finished draining sets this on its final "
        "ack to release its single-flight lease immediately (snappy continuity). The "
        "daemon's post-spawn ack leaves it false; the lease TTL is the crash-safe net.",
    )
    stamp_woken: bool = Field(
        default=True,
        description="#266: whether this ack counts as a WAKE (stamps last_woken_at=now(), resetting "
        "the cooldown + the clock-driven auto-wake cadence). Default true for every real "
        "wake/finish. The auto-wake idle-yield sets it FALSE so a resident that merely "
        "steps aside to let the ephemeral clock-wake fire does NOT reset secs_since_woken "
        "out from under its own auto_wake_due (the real ephemeral wake stamps it instead).",
    )
    clear_self_wake: bool = Field(
        default=False,
        description="GH #122: clear the one-shot self-wake row after its resume context rendered",
    )
    self_wake_task_id: Optional[str] = Field(
        default=None,
        description="GH #122: task id of the exact per-task self-wake row to clear",
    )


class PromptEvent(BaseModel):
    """A3: a directed human/teammate message that wakes an agent. Posting one publishes a
    `prompt` agent_event carrying the text; wake-scan counts it as pending work and the daemon
    surfaces the message in the woken worker's context. Keystone for B2 (prompt-from-portal)
    and B12 (poke / reject-loop)."""

    message: str = Field(
        ...,
        min_length=1,
        max_length=MAX_PAYLOAD_LEN,
        description="the directed message the woken agent should act on",
    )
    from_agent_id: Optional[str] = Field(
        default=None,
        description="UUID of the sender (a human or agent); omitted for system pokes",
    )


class WakeClaim(BaseModel):
    """R2.4: the daemon's atomic single-flight claim before spawning a headless worker."""

    lease_ttl: float = Field(
        default=300.0,
        ge=1,
        le=3600,
        description="seconds the lease is held; the worker should finish well within this, and the "
        "TTL auto-expires it on crash so the agent is never stuck unwakeable",
    )
    kind: str = Field(
        default="ephemeral",
        description="transport about to be used: ephemeral | tmux | resident | live",
    )
    lane: Optional[str] = Field(
        default=None,
        pattern="^(work|conversation)$",
        description="GH #91/#90: which lease slot to claim. When None it is derived from lease_kind/"
        "kind (see _resolve_claim_lane): a 'resident' embodiment (or an explicit "
        "'conversation' kind) claims the CONVERSATION lane; ephemeral/live claim WORK. "
        "The two lanes have independent lease slots on the one agent_wake_state row, so a "
        "warm resident chat and a work worker can be live for the same agent at once.",
    )
    event: Optional[str] = Field(
        default=None,
        max_length=MAX_NAME_LEN,
        description="the event_name / reason driving this wake",
    )
    lease_kind: str = Field(
        default="ephemeral",
        pattern="^(ephemeral|resident|live)$",
        description="E1/§3b: embodiment holding the lease — 'ephemeral' (a one-shot "
        "`claude -p` wake), 'resident' (a background warm conversation "
        "session, also headless), or 'live' (a human interactively driving "
        "an embedded terminal AS the agent via `orcha use`). All three share "
        "the one single-flight lease, so one excludes the others "
        "(one-embodiment-per-agent).",
    )
    preempt: bool = Field(
        default=False,
        description="ISS-69(b): if the claim is DENIED because an IDLE warm RESIDENT holds the lease, "
        "record a yield request on the held row instead of just refusing. The daemon reads "
        "it back on its next wake-renew and gracefully yields the idle resident (snapshot + "
        "release) so this claim can win on retry. No effect when the holder is ephemeral or "
        "another live terminal (those stay 4409).",
    )


class EventsAckHandled(BaseModel):
    """GH #58: acknowledge only the event ids a delivery or finished run may safely consume.

    Wake-scan exposes `delivery_handled_event_ids` for non-reaped delivery and
    `handled_event_ids` for confirmed clean completion. The completion set may additionally contain
    a same-task DIRECTIVE; delivery alone never consumes that directive. Cross-task and NEW_WORK
    rows stay pending for their owning run or claim/terminal seam.
    """

    event_ids: list[int] = Field(default_factory=list)


class WakesToggle(BaseModel):
    enabled: bool = Field(..., description="false = halt ALL wakes for this container")
    actor_agent_id: Optional[str] = Field(
        default=None, description="who flipped it (for the audit row)"
    )


class AutonomyUpdate(BaseModel):
    level: str = Field(..., description="engine autonomy level: 'plan' | 'pr' | 'full'")
    actor_agent_id: str = Field(
        ..., description="UUID of the human (kind='human') moving the slider"
    )


class EmbodimentTokenMint(BaseModel):
    """GH #91/#90: mint a per-process capability token before a spawn."""

    lane: str = Field(
        ...,
        pattern="^(work|conversation)$",
        description="work = may claim/work/complete tasks; conversation = dispatch only",
    )
    kind: str = Field(..., description="informational: headless | resident | live")
