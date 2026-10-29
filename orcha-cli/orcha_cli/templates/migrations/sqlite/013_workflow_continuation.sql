ALTER TABLE agent_self_wake ADD COLUMN auto_continue_run_id UUID REFERENCES worker_runs(run_id) ON DELETE CASCADE;
INSERT OR IGNORE INTO schema_migrations(version) VALUES ('013_workflow_continuation.sql'),('083_workflow_continuation.sql');
