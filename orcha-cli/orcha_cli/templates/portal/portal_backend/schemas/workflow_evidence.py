"""Read contracts for exact saved evidence, separate from acceptance input."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from portal_backend.schemas.workflows import EvidenceItem


class SavedEvidenceItem(EvidenceItem):
    kind: Literal[
        "result_summary", "file_changes", "log_excerpt", "owner_result",
        "outside_result", "import_result",
    ]
    source: Literal[
        "worker", "owner", "outside", "import", "cancelled_attempt",
        "released_attempt",
    ]
    snapshot_phase: Literal["submission", "terminal"]
    complete: bool
    note: str | None
    storage_state: Literal["readable", "missing", "corrupt", "missing_after_restore"]
    captured_by: str | None = None
    captured_by_alias: str | None = None
    captured_by_kind: Literal["human", "ai"] | None = None


class SavedEvidenceSet(BaseModel):
    evidence_set_id: str
    task_id: str
    workflow_id: str
    workflow_execution_id: str
    run_id: str | None
    work_revision: int
    result_revision: int
    source_sequence: int
    generation: int
    state: Literal["pending", "saved", "missing", "superseded"]
    purpose: Literal["acceptance", "attempt_record"]
    missing_reason: str | None
    terminal_cause: str | None
    created_at: datetime
    frozen_at: datetime | None
    source_revision: str | None
    items: list[SavedEvidenceItem]


class WorkflowTaskEvidence(BaseModel):
    task_id: str
    workflow_id: str
    current_evidence_set_id: str | None
    sets: list[SavedEvidenceSet]
    next_before_revision: int | None = None
