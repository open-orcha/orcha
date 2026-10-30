-- Positive runner observations survive workflow execution-row reuse. Never
-- backfill from ended_at, token revocation, or an administrative release.
CREATE TABLE worker_stop_observations (
    run_id UUID PRIMARY KEY REFERENCES worker_runs(run_id) ON DELETE CASCADE,
    execution_id UUID REFERENCES workflow_executions(id),
    generation INTEGER,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
    source TEXT NOT NULL,
    process_id INTEGER,
    exit_code INTEGER,
    CONSTRAINT worker_stop_observations_source_check CHECK (
        (source='workflow_runner' AND execution_id IS NOT NULL AND generation IS NOT NULL
            AND generation > 0 AND process_id IS NULL AND exit_code IS NULL)
        OR (source='host_process' AND execution_id IS NULL AND generation IS NULL
            AND process_id IS NOT NULL AND process_id > 0 AND exit_code IS NOT NULL))
);
ALTER TABLE managed_jobs ADD COLUMN continuation_contract TEXT NOT NULL DEFAULT 'stop_before_transfer'
    CONSTRAINT managed_jobs_contract_check CHECK (continuation_contract IN ('stop_before_transfer','readonly_single_process_v1'));
INSERT OR IGNORE INTO schema_migrations(version) VALUES ('017_worker_stop_observations.sql'),('087_worker_stop_observations.sql');
