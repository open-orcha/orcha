"""Request contracts for worker runs endpoints."""

from typing import Optional

from pydantic import BaseModel, Field

from portal_backend.limits import MAX_NAME_LEN


class WorkerRunStart(BaseModel):
    """Notifier records a spawned worker (status=running)."""

    wake_kind: str = Field(
        default="ephemeral",
        description="transport: ephemeral | tmux | resident | live | sandbox",
    )
    wake_event: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN)
    task_id: Optional[str] = Field(
        default=None, description="the wake's auto-start task, if any"
    )
    log_path: Optional[str] = Field(
        default=None, description="host path of the per-wake stream-json log (A1)"
    )
    pid: Optional[int] = Field(
        default=None,
        description="919050a5: host PID of the spawned worker, so "
        "the notifier can os.kill(pid,0)-reap a run whose process is dead",
    )
    runtime: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN)
    conversation_id: Optional[str] = Field(
        default=None, description="conversation answered by this run, if any"
    )
    conversation_ack_ts: Optional[float] = Field(
        default=None, description="event cursor claimed for this conversation turn"
    )
    last_message_path: Optional[str] = Field(
        default=None, description="Codex --output-last-message sidecar path"
    )
    worktree: Optional[str] = Field(
        default=None, description="isolated worktree cwd, if any"
    )
    branch: Optional[str] = Field(
        default=None, description="isolated worktree branch, if any"
    )
    base_cwd: Optional[str] = Field(
        default=None, description="host project cwd that owns the worktree/logs"
    )
    # GH #91/#90: the run's lane. This is the SINGLE insert choke point where a run is tagged, so it
    # is validated here (DB CHECK is the backstop). Default 'work' keeps every existing caller landing
    # on the work lane; the conversation resident/turn spawns pass 'conversation'.
    lane: str = Field(
        default="work",
        pattern="^(work|conversation)$",
        description="GH #91/#90: work | conversation — scopes the single-flight belt, "
        "wake gates and orphan reaper per lane",
    )
    # GH #91/#90: the embodiment run_token this process was minted BEFORE spawn (if any). When
    # present, the server binds it to the freshly-created run_id (+pid) so revocation survives daemon
    # turnover — the server can revoke a run's token on any terminal transition it observes.
    token_id: Optional[str] = Field(
        default=None, description="the run_token to bind to this run, if any"
    )
    # Remote-runner §3.3c: a sandbox wake stamps its docker container name so a restarted daemon
    # re-adopts live runs by label instead of orphaning them, and metering can attribute container
    # runtime to the run row. NULL for every host-spawned (non-sandbox) run.
    sandbox_container_id: Optional[str] = Field(
        default=None,
        max_length=MAX_NAME_LEN,
        description="docker container name of a sandbox wake (orcha-run-<hex12>), if any",
    )


class WorkerRunFinish(BaseModel):
    """Notifier finishes a run on reap (clean exit or ISS-15 kill)."""

    status: str = Field(..., description="exited | killed | rate_limited | failed")
    exit_code: Optional[int] = None
    output: Optional[str] = Field(
        default=None, description="captured stream-json text from the per-wake log"
    )
    diff: Optional[str] = Field(
        default=None,
        description="ISS-8: net `git diff` vs origin/main from the worker's isolated worktree",
    )
    kill_reason: Optional[str] = Field(
        default=None,
        description="#270: structured watchdog diagnostic (JSON) when the stall/hard-cap reaper kills a worker — explains WHY it was reaped",
    )
    input_tokens: Optional[int] = Field(
        default=None,
        description="#289: input tokens for the wake (from the stream-json result event's usage)",
    )
    output_tokens: Optional[int] = Field(
        default=None, description="#289: output tokens for the wake"
    )
    cache_read_input_tokens: Optional[int] = Field(
        default=None,
        description="#289: cached input tokens READ — cheap in $ but count against the plan quota",
    )
    cache_creation_input_tokens: Optional[int] = Field(
        default=None, description="#289: input tokens written to cache"
    )
    total_cost_usd: Optional[float] = Field(
        default=None,
        description="#289: total dollar cost the CLI reported for the wake",
    )


class WorkerRunStop(BaseModel):
    """#240 + #171/ISS-72: a human requests a graceful STOP of a running worker run / resident
    turn. The API only RECORDS the intent (it can't signal host PIDs); the host daemon enforces
    it on its next wake-renew tick. Human-gated."""

    actor_agent_id: str = Field(
        ..., description="UUID of the human (kind='human') requesting the stop"
    )


class WorkerRunLines(BaseModel):
    """ISS-39: the daemon posts a batch of new stream-json lines for a running worker.
    `start_seq` is the seq of the FIRST line; the rest are start_seq+1, +2, … Idempotent
    (PK (run_id, seq), ON CONFLICT DO NOTHING) so a retried batch never duplicates."""

    start_seq: int = Field(
        ..., ge=1, description="seq of lines[0]; subsequent lines increment"
    )
    lines: list[str] = Field(..., description="raw NDJSON stream-json lines, in order")
