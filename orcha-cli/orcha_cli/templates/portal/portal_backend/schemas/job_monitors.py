"""Safe scheduling references; no commands, output, context or capability hashes."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from portal_backend.schemas.managed_jobs import ManagedJobUpdate, ManagedJobView


class JobObservation(ManagedJobUpdate):
    owner_run_id: UUID
    launch_nonce: UUID


class JobOutcome(BaseModel):
    job_id: UUID
    revision: int
    state: Literal['completed', 'interrupted', 'exhausted', 'unknown']
    result_digest: str | None
    termination_verified: bool
    reason: Literal['result_saved', 'evidence_unavailable']
    created_at: datetime
    handled_at: datetime | None
    attempts: int
    next_attempt_at: datetime


class ObservationReceipt(BaseModel):
    job: ManagedJobView
    outcome: JobOutcome | None


class JobMonitor(BaseModel):
    job: ManagedJobView
    agent_id: UUID
    launch_run_id: UUID
    work_revision: int
    continue_after_exit: bool
    execution_until: datetime
    revoked_at: datetime | None
    suppress_wake: bool
    outcome: JobOutcome | None


class MonitorPage(BaseModel):
    monitors: list[JobMonitor]
    next_after: UUID | None


class OutcomePage(BaseModel):
    outcomes: list[JobOutcome]


class HandleOutcome(BaseModel):
    revision: int = Field(ge=1)
    result_digest: str | None = Field(default=None, pattern=r'^[a-f0-9]{64}$')
    disposition: Literal['applied', 'uncertainty_resolved']
    note: str = Field(min_length=1, max_length=500)


class JobYield(BaseModel):
    context_digest: str = Field(pattern=r'^[a-f0-9]{64}$')


class JobWaitReceipt(BaseModel):
    job_id: UUID
    source_run_id: UUID
    work_revision: int
    context_digest: str | None
    created_at: datetime


class RunJobWait(BaseModel):
    waiting: bool
    retained_job_ids: list[UUID] = Field(default_factory=list)


class JobStop(BaseModel):
    actor_agent_id: UUID | None = None


class JobStopReceipt(BaseModel):
    job_id: UUID
    revoked_at: datetime
    suppress_wake: bool


class ContinuationHeartbeat(BaseModel):
    launch_nonce: UUID
    capability: str = Field(min_length=43, max_length=128, repr=False)


class CompletionReason(BaseModel):
    task_id: UUID
    agent_id: UUID
    work_revision: int = Field(ge=1)
    job_id: UUID
    outcome_revision: int = Field(ge=1)
    operation_id: UUID


class UnlaunchedRelease(CompletionReason):
    admission_id: UUID = Field(description='The exact admission this launcher was granted')


class UnlaunchedAttempt(BaseModel):
    released: bool
