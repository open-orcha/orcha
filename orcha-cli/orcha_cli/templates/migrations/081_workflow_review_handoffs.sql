CREATE TABLE workflow_review_handoffs (
    id UUID PRIMARY KEY NOT NULL,
    workflow_id UUID NOT NULL REFERENCES workflows(id),
    source_task_id UUID NOT NULL REFERENCES tasks(id),
    review_task_id UUID NOT NULL REFERENCES tasks(id),
    source_execution_id UUID NOT NULL REFERENCES workflow_executions(id),
    review_execution_id UUID REFERENCES workflow_executions(id),
    source_work_revision INTEGER NOT NULL,
    review_work_revision INTEGER NOT NULL,
    phase TEXT NOT NULL CONSTRAINT workflow_review_handoffs_phase_check CHECK (phase IN ('source_stopping','review','review_stopping','correction','clean','superseded','cancelled')),
    verdict TEXT CONSTRAINT workflow_review_handoffs_verdict_check CHECK (verdict IN ('clean','changes_requested')),
    source_result TEXT NOT NULL,
    review_result TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(source_execution_id),
    CONSTRAINT workflow_review_handoffs_check CHECK (source_task_id <> review_task_id)
);
CREATE UNIQUE INDEX workflow_review_handoffs_active ON workflow_review_handoffs(workflow_id)
    WHERE phase IN ('source_stopping','review','review_stopping','correction');
