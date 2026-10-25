"""Generated OpenAPI contracts for the workflow runner handshake."""

from pydantic import BaseModel, Field


class WorkflowReserve(BaseModel):
    task_id: str
    expected_workflow_revision: int = Field(ge=1)
    expected_work_revision: int = Field(ge=1)
    operation_key: str = Field(min_length=1, max_length=200)


class WorkflowActivate(BaseModel):
    permit: str = Field(min_length=32, max_length=256)
    process_key: str = Field(min_length=32, max_length=128)
    pid: int = Field(gt=0)


class WorkflowContinue(BaseModel):
    operation_key: str = Field(min_length=1, max_length=200)


class WorkflowStopObserved(BaseModel):
    generation: int = Field(ge=1)


class WorkflowOwnerStop(BaseModel):
    expected_work_revision: int = Field(ge=1)
    operation_key: str = Field(min_length=1, max_length=200)
    reason: str = Field(min_length=1, max_length=4000)
