"""Public contracts contain identities and hashes, never command text or output."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, Field, model_validator
from pydantic_core import PydanticCustomError

JobState = Literal['reserved', 'running', 'completed', 'interrupted', 'unknown', 'exhausted']
ContinuationContract = Literal['stop_before_transfer', 'readonly_single_process_v1']


class ManagedRunLimits(BaseModel):
    run_until: AwareDatetime
    sandbox_until: AwareDatetime | None = None


class ManagedLimitsView(ManagedRunLimits):
    run_id: UUID


class ManagedJobReserve(BaseModel):
    job_key: UUID = Field(description='Stable task operation identity; reuse on every retry')
    max_elapsed_secs: int = Field(default=7200, ge=1, le=86400)
    max_transfers: int = Field(default=3, ge=0, le=10)
    continuation_contract: ContinuationContract = 'stop_before_transfer'


class ManagedJobView(BaseModel):
    job_id: UUID
    task_id: UUID
    job_key: UUID
    launch_nonce: UUID
    owner_run_id: UUID
    workflow_generation: int | None
    state: JobState
    version: int
    reserved_at: datetime
    budget_until: datetime
    max_transfers: int
    max_elapsed_secs: int
    transfers_used: int
    checkpoint_version: int
    checkpoint_digest: str | None
    result_digest: str | None
    termination_verified: bool
    continuation_contract: ContinuationContract


class HostWorkerStopObserved(BaseModel):
    process_id: int = Field(gt=0, le=2147483647)
    exit_code: int = Field(ge=-2147483648, le=2147483647)


class WorkerStopObservationView(BaseModel):
    run_id: UUID
    execution_id: UUID | None
    generation: int | None
    observed_at: datetime
    source: Literal['host_process', 'workflow_runner']
    process_id: int | None
    exit_code: int | None


class ManagedJobList(BaseModel):
    jobs: list[ManagedJobView]


class ManagedJobUpdate(BaseModel):
    operation_id: UUID
    expected_version: int = Field(ge=0, le=2147483646)
    state: JobState
    checkpoint_version: int = Field(ge=1, le=2147483647)
    checkpoint_digest: str = Field(pattern=r'^[a-f0-9]{64}$')
    result_digest: str | None = Field(default=None, pattern=r'^[a-f0-9]{64}$')
    termination_verified: bool = False

    @model_validator(mode='after')
    def terminal_evidence(self):
        if self.termination_verified and (self.state not in {'completed', 'interrupted', 'exhausted'}
                                          or not self.result_digest):
            raise PydanticCustomError('managed_terminal_evidence', 'Verified termination requires a terminal state and saved result')
        if self.state in {'completed', 'interrupted'} and not self.termination_verified:
            raise PydanticCustomError('managed_terminal_evidence', 'A known terminal outcome requires observed termination and saved result')
        return self


class ManagedJobAuthority(BaseModel):
    server_time: datetime
    run_id: UUID
    job_id: UUID
    workflow_generation: int | None
    token_valid: bool
    stop_requested: bool
    on_hold: bool
    cancelled: bool
    lease_until: datetime | None
    lease_active: bool
    mutations_allowed: bool
    authority_until: datetime
    run_until: datetime
    sandbox_until: datetime | None
    budget_until: datetime
    prepare_at: datetime


class ManagedJobReconcile(ManagedJobUpdate):
    """A current worker imports verified evidence from a stopped predecessor.

    This never grants control of a surviving process or spends a transfer. The
    original owner and launch identity remain part of the immutable result.
    """

    source_owner_run_id: UUID
    launch_nonce: UUID

    @model_validator(mode='after')
    def observed_result(self):
        if not self.termination_verified or self.state not in {'completed', 'interrupted', 'exhausted'}:
            raise PydanticCustomError('managed_result_required', 'Recovery requires an observed terminal result')
        return self
