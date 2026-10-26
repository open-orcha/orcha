-- Additive Workflows model. Capability remains disabled until every entry path is integrated.
-- 074 owns task autonomy; 076 owns evidence sets; 077 owns stop intents and worker fencing.
CREATE TABLE container_task_graph_guard (
    container_id UUID PRIMARY KEY NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1
);
INSERT INTO container_task_graph_guard(container_id) SELECT id FROM containers;

CREATE TABLE workflows (
    id UUID PRIMARY KEY NOT NULL,
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    owner_human_id UUID NOT NULL REFERENCES agents(id),
    created_by_human_id UUID NOT NULL REFERENCES agents(id),
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    execution_mode TEXT NOT NULL DEFAULT 'serial',
    launch_enabled BOOLEAN NOT NULL DEFAULT false,
    revision INTEGER NOT NULL DEFAULT 1,
    scope_revision INTEGER NOT NULL DEFAULT 1,
    goal_revision INTEGER NOT NULL DEFAULT 1,
    goal_accepted_revision INTEGER,
    goal_accepted_scope_revision INTEGER,
    goal_evidence JSONB,
    goal_accepted_by UUID REFERENCES agents(id),
    goal_accepted_at TIMESTAMPTZ,
    task_limit INTEGER NOT NULL DEFAULT 50,
    round_limit INTEGER NOT NULL DEFAULT 5,
    limit_reached BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    completed_by_human_id UUID REFERENCES agents(id),
    cancelled_at TIMESTAMPTZ,
    cancelled_by_human_id UUID REFERENCES agents(id),
    cancellation_reason TEXT,
    CONSTRAINT workflows_status_check CHECK (status IN ('active','paused','completed','cancelled')),
    CONSTRAINT workflows_mode_check CHECK (execution_mode IN ('serial','parallel')),
    CONSTRAINT workflows_title_check CHECK (length(trim(title)) BETWEEN 1 AND 200),
    CONSTRAINT workflows_goal_check CHECK (length(trim(goal)) BETWEEN 1 AND 4000),
    CONSTRAINT workflows_limits_check CHECK (task_limit > 0 AND round_limit > 0),
    UNIQUE (id, container_id)
);
CREATE INDEX idx_workflows_project ON workflows(container_id, status, created_at, id);

ALTER TABLE tasks ADD COLUMN workflow_id UUID REFERENCES workflows(id);
ALTER TABLE tasks ADD COLUMN work_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN preparation_state TEXT CONSTRAINT tasks_preparation_check CHECK (preparation_state IN ('draft','prepared'));
ALTER TABLE tasks ADD COLUMN start_hold BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN human_hold_by UUID REFERENCES agents(id);
ALTER TABLE tasks ADD COLUMN human_hold_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN human_hold_reason TEXT;
ALTER TABLE tasks ADD COLUMN awaiting_owner_decision TEXT CONSTRAINT tasks_owner_decision_check CHECK (awaiting_owner_decision IN ('changes_requested','stopped_by_owner','worker_released','evidence_withdrawn'));
ALTER TABLE tasks ADD COLUMN owner_decision_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN withdrawn_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN withdrawn_by UUID REFERENCES agents(id);
ALTER TABLE tasks ADD COLUMN withdrawn_reason TEXT;
CREATE UNIQUE INDEX idx_tasks_workflow_identity ON tasks(id, workflow_id);
CREATE INDEX idx_tasks_workflow_queue ON tasks(workflow_id, status, priority, created_at, id);

CREATE TABLE workflow_objectives (
    id UUID PRIMARY KEY NOT NULL,
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    criteria TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    accepted_revision INTEGER,
    evidence JSONB,
    accepted_by UUID REFERENCES agents(id),
    accepted_at TIMESTAMPTZ,
    CONSTRAINT workflow_objectives_title_check CHECK (length(trim(title)) BETWEEN 1 AND 200),
    CONSTRAINT workflow_objectives_criteria_check CHECK (length(trim(criteria)) BETWEEN 1 AND 4000)
);

CREATE TABLE workflow_executions (
    id UUID PRIMARY KEY NOT NULL,
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    task_id UUID NOT NULL,
    generation INTEGER NOT NULL,
    work_revision INTEGER NOT NULL,
    claimant_id UUID REFERENCES agents(id),
    run_id UUID,
    source_kind TEXT NOT NULL,
    exclusive BOOLEAN NOT NULL,
    state TEXT NOT NULL,
    current_evidence_set_id UUID,
    evidence_state TEXT NOT NULL DEFAULT 'pending',
    first_stop_at TIMESTAMPTZ,
    last_runner_contact_at TIMESTAMPTZ,
    generation_revoked_at TIMESTAMPTZ,
    worker_stopped_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at TIMESTAMPTZ,
    release_reason TEXT,
    CONSTRAINT workflow_executions_task_fkey FOREIGN KEY (task_id, workflow_id) REFERENCES tasks(id, workflow_id),
    CONSTRAINT workflow_executions_state_check CHECK (state IN ('reserved','running','awaiting_review','stopping','recovery_needed','released','released_lost','aborted')),
    CONSTRAINT workflow_executions_source_check CHECK (source_kind IN ('worker','evidence_review','import_review')),
    CONSTRAINT workflow_executions_evidence_check CHECK (evidence_state IN ('pending','saved','missing','superseded')),
    CONSTRAINT workflow_executions_generation_check CHECK (generation > 0 AND work_revision > 0),
    UNIQUE (task_id, generation)
);
CREATE UNIQUE INDEX idx_workflow_executions_live_task ON workflow_executions(task_id) WHERE state IN ('reserved','running','awaiting_review','stopping','recovery_needed');
CREATE INDEX idx_workflow_executions_live_workflow ON workflow_executions(workflow_id, state);
CREATE INDEX idx_workflow_executions_run ON workflow_executions(run_id);

CREATE TABLE workflow_task_acceptances (
    id UUID PRIMARY KEY NOT NULL,
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    task_id UUID NOT NULL,
    work_revision INTEGER NOT NULL,
    actor_id UUID NOT NULL REFERENCES agents(id),
    actor_kind TEXT NOT NULL,
    actor_alias TEXT NOT NULL,
    autonomy_at_acceptance TEXT NOT NULL,
    autonomy_revision INTEGER NOT NULL,
    acceptance_source TEXT NOT NULL,
    evidence_set_id UUID NOT NULL,
    evidence_items JSONB NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT workflow_acceptances_task_fkey FOREIGN KEY (task_id, workflow_id) REFERENCES tasks(id, workflow_id),
    CONSTRAINT workflow_acceptances_actor_check CHECK (actor_kind IN ('human','ai')),
    CONSTRAINT workflow_acceptances_permission_check CHECK (autonomy_at_acceptance IN ('off','on') AND (actor_kind = 'human' OR autonomy_at_acceptance = 'on')),
    UNIQUE (task_id, work_revision)
);

CREATE TABLE task_outside_evidence (
    id UUID PRIMARY KEY NOT NULL,
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    task_id UUID NOT NULL,
    work_revision INTEGER NOT NULL,
    submitted_by UUID NOT NULL REFERENCES agents(id),
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    evidence JSONB NOT NULL,
    produced_by TEXT,
    state TEXT NOT NULL,
    gate_reason_at_submit TEXT,
    execution_id UUID REFERENCES workflow_executions(id),
    decided_by UUID REFERENCES agents(id),
    decided_at TIMESTAMPTZ,
    decision_reason TEXT,
    CONSTRAINT task_outside_evidence_task_fkey FOREIGN KEY (task_id, workflow_id) REFERENCES tasks(id, workflow_id),
    CONSTRAINT task_outside_evidence_state_check CHECK (state IN ('pending','admitted','accepted','rejected','withdrawn'))
);
CREATE UNIQUE INDEX idx_task_outside_evidence_live ON task_outside_evidence(task_id) WHERE state IN ('pending','admitted');

CREATE TABLE workflow_review_rounds (
    id UUID PRIMARY KEY NOT NULL,
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    loop_key TEXT NOT NULL,
    round_number INTEGER NOT NULL,
    prior_round_id UUID REFERENCES workflow_review_rounds(id),
    review_task_id UUID NOT NULL,
    correction_task_id UUID,
    reviewed_artifact JSONB NOT NULL,
    reviewed_task_id UUID,
    reviewed_work_revision INTEGER,
    outcome TEXT,
    -- The review task's own work revision when its outcome was recorded; a retried
    -- review (newer revision) may replace an inconclusive outcome.
    review_work_revision INTEGER,
    resolved_by_owner UUID REFERENCES agents(id),
    resolved_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT workflow_round_review_task_fkey FOREIGN KEY (review_task_id, workflow_id) REFERENCES tasks(id, workflow_id),
    CONSTRAINT workflow_round_correction_task_fkey FOREIGN KEY (correction_task_id, workflow_id) REFERENCES tasks(id, workflow_id),
    CONSTRAINT workflow_round_outcome_check CHECK (outcome IN ('changes_requested','accepted','inconclusive')),
    CONSTRAINT workflow_round_reviewed_task_fkey FOREIGN KEY (reviewed_task_id, workflow_id) REFERENCES tasks(id, workflow_id),
    CONSTRAINT workflow_round_reviewed_check CHECK ((reviewed_task_id IS NULL) = (reviewed_work_revision IS NULL) AND (outcome IS NULL OR reviewed_task_id IS NOT NULL) AND (reviewed_work_revision IS NULL OR reviewed_work_revision >= 1) AND (outcome IS NULL) = (review_work_revision IS NULL)),
    UNIQUE (workflow_id, loop_key, round_number),
    UNIQUE (review_task_id),
    UNIQUE (correction_task_id)
);

CREATE TABLE workflow_operation_receipts (
    id UUID PRIMARY KEY NOT NULL,
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    workflow_id UUID REFERENCES workflows(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL REFERENCES agents(id),
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (container_id, actor_id, operation, idempotency_key)
);

CREATE TABLE workflow_history (
    id UUID PRIMARY KEY NOT NULL,
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    task_id UUID,
    actor_id UUID,
    actor_kind TEXT NOT NULL,
    actor_alias TEXT NOT NULL,
    event TEXT NOT NULL,
    revision INTEGER NOT NULL,
    detail JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_workflow_history ON workflow_history(workflow_id, created_at, id);

CREATE TABLE workflow_notification_receipts (
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    notice_kind TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    subject_revision INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workflow_id, notice_kind, subject_key, subject_revision)
);
