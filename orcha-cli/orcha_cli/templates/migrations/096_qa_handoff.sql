-- Orcha QA handoff and workflow integration (docs/orcha-qa-plan.md, "Handoff and workflow
-- integration"). A qa_requests row is the handoff record: what was asked of QA, where it came
-- from and what came back. A QA result never verifies a task: a person still does.

CREATE TABLE qa_settings (
    container_id UUID PRIMARY KEY REFERENCES containers(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    default_platform TEXT,
    trigger TEXT NOT NULL DEFAULT 'manual',
    on_fail TEXT NOT NULL DEFAULT 'report',
    max_rounds INTEGER NOT NULL DEFAULT 3,
    auto_triage TEXT NOT NULL DEFAULT 'off',
    max_per_run INTEGER NOT NULL DEFAULT 2,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    CONSTRAINT qa_settings_platform_check CHECK (default_platform IS NULL OR default_platform IN ('ios', 'android', 'web')),
    CONSTRAINT qa_settings_trigger_check CHECK (trigger IN ('manual', 'ui_changes', 'always')),
    CONSTRAINT qa_settings_on_fail_check CHECK (on_fail IN ('report', 'reopen')),
    CONSTRAINT qa_settings_rounds_check CHECK (max_rounds BETWEEN 1 AND 10),
    CONSTRAINT qa_settings_auto_triage_check CHECK (auto_triage IN ('off', 'critical', 'all')),
    CONSTRAINT qa_settings_per_run_check CHECK (max_per_run BETWEEN 1 AND 20)
);

CREATE TABLE qa_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    platform TEXT,
    origin TEXT NOT NULL DEFAULT 'handoff',
    source_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    source_work_revision INTEGER,
    source_workflow_id UUID REFERENCES workflows(id) ON DELETE SET NULL,
    source_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    source_finding_id UUID REFERENCES qa_findings(id) ON DELETE SET NULL,
    requested_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    approved_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    qa_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    previous_request_id UUID REFERENCES qa_requests(id) ON DELETE SET NULL,
    round INTEGER NOT NULL DEFAULT 1,
    max_rounds INTEGER,
    scenario_ids JSONB NOT NULL DEFAULT '[]',
    tags JSONB NOT NULL DEFAULT '[]',
    finding_ids JSONB NOT NULL DEFAULT '[]',
    focus TEXT,
    minutes INTEGER,
    acceptance JSONB NOT NULL DEFAULT '[]',
    build JSONB,
    on_fail TEXT NOT NULL DEFAULT 'report',
    status TEXT NOT NULL DEFAULT 'requested',
    decision TEXT,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    CONSTRAINT qa_requests_kind_check CHECK (kind IN ('map', 'explore', 'draft', 'check', 'triage')),
    CONSTRAINT qa_requests_decision_check CHECK (decision IS NULL OR decision IN ('fix', 'clear', 'needs_person')),
    CONSTRAINT qa_requests_platform_check CHECK (platform IS NULL OR platform IN ('ios', 'android', 'web')),
    CONSTRAINT qa_requests_origin_check CHECK (origin IN ('handoff', 'trigger', 'workflow', 'reopen', 'recheck', 'auto_triage')),
    CONSTRAINT qa_requests_on_fail_check CHECK (on_fail IN ('report', 'reopen')),
    CONSTRAINT qa_requests_status_check CHECK (status IN ('requested', 'running', 'passed', 'failed', 'blocked', 'cancelled'))
);
CREATE INDEX qa_requests_container ON qa_requests (container_id, created_at);
CREATE INDEX qa_requests_source_task ON qa_requests (source_task_id, created_at);
CREATE INDEX qa_requests_qa_task ON qa_requests (qa_task_id);
CREATE INDEX qa_requests_workflow ON qa_requests (source_workflow_id);

-- One verdict on one acceptance line of a request. A line can be judged with no scenario (an
-- explore session has none), so it cannot be a qa_verdicts row. The newest row for a line wins.
CREATE TABLE qa_acceptance_verdicts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    request_id UUID NOT NULL REFERENCES qa_requests(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES qa_sessions(id) ON DELETE CASCADE,
    line_index INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    note TEXT,
    frame_ids JSONB NOT NULL DEFAULT '[]',
    scenario_id UUID REFERENCES qa_scenarios(id) ON DELETE SET NULL,
    criterion_index INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT qa_acceptance_verdicts_verdict_check CHECK (verdict IN ('pass', 'fail', 'blocked', 'inconclusive'))
);
CREATE INDEX qa_acceptance_verdicts_request ON qa_acceptance_verdicts (request_id, line_index, created_at);

ALTER TABLE qa_sessions ADD COLUMN IF NOT EXISTS request_id UUID REFERENCES qa_requests(id) ON DELETE SET NULL;
ALTER TABLE qa_verdicts ADD COLUMN IF NOT EXISTS request_id UUID REFERENCES qa_requests(id) ON DELETE SET NULL;
ALTER TABLE qa_findings ADD COLUMN IF NOT EXISTS request_id UUID REFERENCES qa_requests(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS qa_sessions_request ON qa_sessions (request_id);

-- Triage: a finding is a claim, not a fix order (docs/orcha-qa-plan.md, "Triage").
ALTER TABLE qa_findings ADD COLUMN IF NOT EXISTS triage JSONB;
ALTER TABLE qa_findings ADD COLUMN IF NOT EXISTS severity_original TEXT;
ALTER TABLE qa_findings ADD COLUMN IF NOT EXISTS duplicate_of UUID REFERENCES qa_findings(id) ON DELETE SET NULL;

-- What people told QA about this app. QA agents read it (list_project) and obey it.
CREATE TABLE qa_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    finding_id UUID REFERENCES qa_findings(id) ON DELETE SET NULL,
    scenario_id UUID REFERENCES qa_scenarios(id) ON DELETE SET NULL,
    screen_key TEXT,
    created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT qa_memory_kind_check CHECK (kind IN ('not_a_bug', 'convention', 'decision'))
);
CREATE INDEX qa_memory_container ON qa_memory (container_id, created_at);

-- A workflow QA step: {kind, platform?, scenario_ids?, tags?, focus?, minutes?}, kept on the step's task.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS qa_step JSONB;
