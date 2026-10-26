-- Saved review evidence is independent of temporary worker diagnostics.
-- References never bind to the mutable current run/generation of an execution.
ALTER TABLE worker_runs ADD COLUMN details_pruned_at TIMESTAMPTZ;
CREATE UNIQUE INDEX idx_workflow_execution_identity
    ON workflow_executions(id, task_id, workflow_id);
CREATE UNIQUE INDEX idx_workflow_objective_identity ON workflow_objectives(id, workflow_id);
CREATE UNIQUE INDEX idx_workflow_round_identity ON workflow_review_rounds(id, workflow_id);
CREATE UNIQUE INDEX idx_deliverable_task_identity ON task_deliverables(id, task_id);

CREATE TABLE workflow_evidence_sets (
    id UUID PRIMARY KEY NOT NULL,
    workflow_execution_id UUID NOT NULL,
    workflow_id UUID NOT NULL,
    task_id UUID NOT NULL,
    review_round_id UUID,
    objective_id UUID,
    run_id UUID REFERENCES worker_runs(run_id),
    generation INTEGER NOT NULL CONSTRAINT workflow_evidence_sets_generation_check CHECK (generation > 0),
    result_revision INTEGER NOT NULL CONSTRAINT workflow_evidence_sets_result_revision_check CHECK (result_revision > 0),
    work_revision INTEGER NOT NULL CONSTRAINT workflow_evidence_sets_work_revision_check CHECK (work_revision > 0),
    source_revision TEXT,
    source_sequence INTEGER NOT NULL CONSTRAINT workflow_evidence_sets_source_sequence_check CHECK (source_sequence > 0),
    capture_sha256 TEXT NOT NULL,
    supersedes_set_id UUID REFERENCES workflow_evidence_sets(id),
    purpose TEXT NOT NULL CONSTRAINT workflow_evidence_sets_purpose_check CHECK (purpose IN ('acceptance', 'attempt_record')),
    state TEXT NOT NULL CONSTRAINT workflow_evidence_sets_state_check CHECK (state IN ('pending', 'saved', 'missing', 'superseded')),
    required_kinds JSONB NOT NULL,
    missing_reason TEXT,
    terminal_cause TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    frozen_at TIMESTAMPTZ,
    FOREIGN KEY (workflow_execution_id, task_id, workflow_id)
        REFERENCES workflow_executions(id, task_id, workflow_id),
    FOREIGN KEY (run_id, task_id) REFERENCES worker_run_tasks(run_id, task_id),
    FOREIGN KEY (review_round_id, workflow_id) REFERENCES workflow_review_rounds(id, workflow_id),
    FOREIGN KEY (objective_id, workflow_id) REFERENCES workflow_objectives(id, workflow_id),
    UNIQUE (id, task_id),
    UNIQUE (workflow_execution_id, generation, source_sequence),
    UNIQUE (task_id, result_revision)
);
CREATE INDEX idx_workflow_evidence_sets_run ON workflow_evidence_sets(run_id);
CREATE INDEX idx_workflow_evidence_sets_task ON workflow_evidence_sets(task_id, result_revision);

CREATE TABLE workflow_evidence (
    id UUID PRIMARY KEY NOT NULL,
    evidence_set_id UUID NOT NULL REFERENCES workflow_evidence_sets(id),
    task_id UUID NOT NULL,
    kind TEXT NOT NULL CONSTRAINT workflow_evidence_kind_check CHECK (kind IN ('result_summary', 'file_changes', 'log_excerpt', 'owner_result', 'outside_result')),
    source TEXT NOT NULL CONSTRAINT workflow_evidence_source_check CHECK (source IN ('worker', 'owner', 'outside', 'cancelled_attempt', 'released_attempt')),
    snapshot_phase TEXT NOT NULL CONSTRAINT workflow_evidence_snapshot_phase_check CHECK (snapshot_phase IN ('submission', 'terminal')),
    deliverable_id UUID NOT NULL,
    deliverable_version INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    complete BOOLEAN NOT NULL DEFAULT true,
    note TEXT,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    captured_by UUID REFERENCES agents(id),
    FOREIGN KEY (deliverable_id, deliverable_version)
        REFERENCES task_deliverable_versions(deliverable_id, version),
    FOREIGN KEY (deliverable_id, task_id) REFERENCES task_deliverables(id, task_id),
    FOREIGN KEY (evidence_set_id, task_id) REFERENCES workflow_evidence_sets(id, task_id),
    UNIQUE (evidence_set_id, kind, snapshot_phase)
);

CREATE TABLE workflow_terminal_receipts (
    run_id UUID NOT NULL REFERENCES worker_runs(run_id),
    generation INTEGER NOT NULL,
    cause TEXT NOT NULL,
    evidence_set_id UUID NOT NULL REFERENCES workflow_evidence_sets(id),
    terminal_status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, generation, cause, evidence_set_id)
);
