-- Flexible workflows (semantics version 2): outcomes, routes, repeat groups, rounds,
-- outcome reports, route decisions, owner decisions, run allowance and definition versions.
-- Additive only: every existing workflow keeps semantics_version = 1 and its current behaviour.
ALTER TABLE workflows ADD COLUMN semantics_version INTEGER NOT NULL DEFAULT 1
    CONSTRAINT workflows_semantics_version_check CHECK (semantics_version IN (1, 2));
ALTER TABLE workflows ADD COLUMN definition_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflows ADD COLUMN turn_allowance INTEGER NOT NULL DEFAULT 40
    CONSTRAINT workflows_turn_allowance_check CHECK (turn_allowance BETWEEN 1 AND 1000);
ALTER TABLE workflows ADD COLUMN turns_used INTEGER NOT NULL DEFAULT 0;

ALTER TABLE tasks ADD COLUMN route_state TEXT
    CONSTRAINT tasks_route_state_check CHECK (route_state IN ('not_selected'));
ALTER TABLE tasks ADD COLUMN awaiting_loop_decision TEXT
    CONSTRAINT tasks_loop_decision_check CHECK (awaiting_loop_decision IN ('limit_reached','stalled','missing_outcome','ask_owner'));

CREATE TABLE workflow_definition_versions (
    id UUID PRIMARY KEY NOT NULL,
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    reason TEXT NOT NULL,
    snapshot JSONB NOT NULL,
    created_by UUID REFERENCES agents(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT workflow_definition_versions_reason_check CHECK (reason IN ('start','edit')),
    UNIQUE (workflow_id, version)
);

CREATE TABLE workflow_step_outcomes (
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    task_id UUID NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    position INTEGER NOT NULL,
    CONSTRAINT workflow_step_outcomes_task_fkey FOREIGN KEY (task_id, workflow_id) REFERENCES tasks(id, workflow_id),
    CONSTRAINT workflow_step_outcomes_name_check CHECK (length(trim(name)) BETWEEN 1 AND 40),
    CONSTRAINT workflow_step_outcomes_kind_check CHECK (kind IN ('success','changes','failure','custom')),
    PRIMARY KEY (task_id, name)
);

CREATE TABLE workflow_repeat_groups (
    id UUID PRIMARY KEY NOT NULL,
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    review_task_id UUID NOT NULL,
    exit_outcome TEXT NOT NULL,
    max_rounds INTEGER NOT NULL DEFAULT 5,
    escalation_owner_id UUID NOT NULL REFERENCES agents(id),
    stall_rule TEXT NOT NULL DEFAULT 'findings_and_artifact',
    current_round INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'open',
    CONSTRAINT workflow_repeat_groups_review_fkey FOREIGN KEY (review_task_id, workflow_id) REFERENCES tasks(id, workflow_id),
    CONSTRAINT workflow_repeat_groups_name_check CHECK (length(trim(name)) BETWEEN 1 AND 80),
    CONSTRAINT workflow_repeat_groups_rounds_check CHECK (max_rounds BETWEEN 1 AND 20),
    CONSTRAINT workflow_repeat_groups_stall_check CHECK (stall_rule IN ('findings_and_artifact','off')),
    CONSTRAINT workflow_repeat_groups_state_check CHECK (state IN ('open','limit_reached','stalled','awaiting_owner','exited','stopped')),
    UNIQUE (workflow_id, name)
);

CREATE TABLE workflow_repeat_group_members (
    group_id UUID NOT NULL REFERENCES workflow_repeat_groups(id) ON DELETE CASCADE,
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    task_id UUID NOT NULL,
    position INTEGER NOT NULL,
    CONSTRAINT workflow_repeat_group_members_task_fkey FOREIGN KEY (task_id, workflow_id) REFERENCES tasks(id, workflow_id),
    PRIMARY KEY (group_id, task_id),
    UNIQUE (task_id)
);

CREATE TABLE workflow_step_routes (
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    task_id UUID NOT NULL,
    outcome_name TEXT NOT NULL,
    destination_kind TEXT NOT NULL,
    destination_task_id UUID,
    group_id UUID REFERENCES workflow_repeat_groups(id) ON DELETE CASCADE,
    CONSTRAINT workflow_step_routes_task_fkey FOREIGN KEY (task_id, workflow_id) REFERENCES tasks(id, workflow_id),
    CONSTRAINT workflow_step_routes_destination_fkey FOREIGN KEY (destination_task_id, workflow_id) REFERENCES tasks(id, workflow_id),
    CONSTRAINT workflow_step_routes_kind_check CHECK (destination_kind IN ('next','step','return','ask_owner','exit_group','stop')),
    CONSTRAINT workflow_step_routes_destination_check CHECK ((destination_kind IN ('step','return')) = (destination_task_id IS NOT NULL)),
    CONSTRAINT workflow_step_routes_group_check CHECK (destination_kind <> 'return' OR group_id IS NOT NULL),
    PRIMARY KEY (task_id, outcome_name)
);

CREATE TABLE workflow_group_rounds (
    id UUID PRIMARY KEY NOT NULL,
    group_id UUID NOT NULL REFERENCES workflow_repeat_groups(id) ON DELETE CASCADE,
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    round_number INTEGER NOT NULL,
    trigger_kind TEXT NOT NULL,
    return_from_task_id UUID,
    return_to_task_id UUID,
    reason TEXT,
    inputs JSONB NOT NULL,
    stall JSONB,
    end_reason TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    CONSTRAINT workflow_group_rounds_trigger_check CHECK (trigger_kind IN ('initial','return','owner_resume','owner_raise_limit','owner_reassign')),
    CONSTRAINT workflow_group_rounds_end_check CHECK (end_reason IN ('exit','return','limit','stall','ask_owner','stopped','accepted_override')),
    CONSTRAINT workflow_group_rounds_number_check CHECK (round_number > 0),
    UNIQUE (group_id, round_number)
);

CREATE TABLE workflow_step_instances (
    task_id UUID NOT NULL REFERENCES tasks(id),
    work_revision INTEGER NOT NULL,
    group_round_id UUID NOT NULL REFERENCES workflow_group_rounds(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, work_revision)
);

CREATE TABLE workflow_outcome_reports (
    id UUID PRIMARY KEY NOT NULL,
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    task_id UUID NOT NULL,
    work_revision INTEGER NOT NULL,
    generation INTEGER,
    reporter_id UUID NOT NULL REFERENCES agents(id),
    reporter_kind TEXT NOT NULL,
    outcome_name TEXT NOT NULL,
    findings JSONB NOT NULL,
    note TEXT,
    evidence_set_id UUID,
    reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT workflow_outcome_reports_task_fkey FOREIGN KEY (task_id, workflow_id) REFERENCES tasks(id, workflow_id),
    CONSTRAINT workflow_outcome_reports_reporter_check CHECK (reporter_kind IN ('human','ai')),
    UNIQUE (task_id, work_revision)
);

CREATE TABLE workflow_route_decisions (
    id UUID PRIMARY KEY NOT NULL,
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    report_id UUID NOT NULL REFERENCES workflow_outcome_reports(id) ON DELETE CASCADE,
    destination_kind TEXT NOT NULL,
    destination_task_id UUID,
    group_id UUID REFERENCES workflow_repeat_groups(id),
    preview JSONB NOT NULL,
    resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at TIMESTAMPTZ,
    applied_by_acceptance_id UUID,
    result TEXT,
    overridden_by_decision_id UUID,
    UNIQUE (report_id)
);
CREATE INDEX idx_workflow_route_decisions_unapplied ON workflow_route_decisions(workflow_id) WHERE applied_at IS NULL;

CREATE TABLE workflow_owner_decisions (
    id UUID PRIMARY KEY NOT NULL,
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    task_id UUID,
    group_id UUID REFERENCES workflow_repeat_groups(id),
    subject_kind TEXT NOT NULL,
    chosen TEXT NOT NULL,
    original_outcome TEXT,
    detail JSONB NOT NULL,
    reason TEXT,
    decided_by UUID NOT NULL REFERENCES agents(id),
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT workflow_owner_decisions_subject_check CHECK (subject_kind IN ('limit_reached','stalled','missing_outcome','ask_owner','allowance')),
    CONSTRAINT workflow_owner_decisions_chosen_check CHECK (chosen IN ('raise_limit','reassign_continue','accept_override','resume_stalled','pick_outcome','stop','raise_allowance'))
);
CREATE INDEX idx_workflow_owner_decisions ON workflow_owner_decisions(workflow_id, decided_at);
