-- Orcha QA run tasks (docs/orcha-qa-plan.md, "Run tasks: every run is a task"). qa_runs marks the
-- tasks created for QA work, whatever made them. qa_settings.final_decision says who has the final
-- say in a project, and qa_final_decisions is the record of every decision made under `quality`.

ALTER TABLE qa_settings ADD COLUMN final_decision TEXT NOT NULL DEFAULT 'person'
    CONSTRAINT qa_settings_final_decision_check CHECK (final_decision IN ('person', 'quality'));
ALTER TABLE qa_settings ADD COLUMN final_decision_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE qa_settings ADD COLUMN final_decision_at TIMESTAMPTZ;

CREATE TABLE qa_runs (
    task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    origin TEXT NOT NULL,
    kind TEXT,
    platform TEXT,
    result_session_id UUID REFERENCES qa_sessions(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    CONSTRAINT qa_runs_origin_check CHECK (origin IN ('request', 'workflow', 'onboarding', 'run_check', 'exploration', 'agent'))
);
CREATE INDEX qa_runs_container ON qa_runs (container_id, created_at);

CREATE TABLE qa_final_decisions (
    id UUID PRIMARY KEY NOT NULL,
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    decision TEXT NOT NULL,
    setting TEXT NOT NULL,
    turned_on_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    turned_on_by_alias TEXT,
    turned_on_at TIMESTAMPTZ,
    reasons JSONB NOT NULL DEFAULT '[]',
    lines JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    CONSTRAINT qa_final_decisions_subject_check CHECK (subject IN ('work', 'run')),
    CONSTRAINT qa_final_decisions_decision_check CHECK (decision IN ('finished', 'person', 'sent_back'))
);
CREATE INDEX qa_final_decisions_task ON qa_final_decisions (task_id, created_at);

-- A workflow step that came from a Quality block: {key, name}, for its label.
ALTER TABLE tasks ADD COLUMN qa_block JSONB;

-- Every handed-off run so far is a run task.
INSERT OR IGNORE INTO qa_runs (task_id, container_id, origin, kind, platform, created_at)
SELECT qa_task_id, container_id, CASE WHEN origin = 'workflow' THEN 'workflow' ELSE 'request' END, kind, platform, created_at
  FROM qa_requests WHERE qa_task_id IS NOT NULL ORDER BY created_at;

INSERT OR IGNORE INTO schema_migrations (version)
VALUES ('027_qa_run_tasks.sql'), ('097_qa_run_tasks.sql');
