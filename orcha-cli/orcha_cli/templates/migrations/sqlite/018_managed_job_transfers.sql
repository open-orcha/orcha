-- Planned handoffs freeze the old worker without extending its command cap.
ALTER TABLE managed_run_limits ADD COLUMN controls_frozen BOOLEAN NOT NULL DEFAULT 0;
CREATE TABLE managed_job_transfers (
    transfer_id UUID PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES managed_jobs(job_id) ON DELETE CASCADE,
    source_run_id UUID NOT NULL REFERENCES worker_runs(run_id),
    execution_id UUID REFERENCES workflow_executions(id),
    generation INTEGER,
    launch_nonce UUID NOT NULL,
    proof_digest TEXT NOT NULL,
    capability_digest TEXT NOT NULL,
    authority_until TIMESTAMPTZ NOT NULL,
    prepared_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
    adopted_run_id UUID REFERENCES worker_runs(run_id),
    operation_id UUID,
    payload_digest TEXT,
    UNIQUE(job_id,source_run_id),
    CONSTRAINT managed_transfer_adoption_check CHECK (
        (adopted_run_id IS NULL AND operation_id IS NULL AND payload_digest IS NULL)
        OR (adopted_run_id IS NOT NULL AND operation_id IS NOT NULL AND payload_digest IS NOT NULL)),
    CONSTRAINT managed_transfer_generation_check CHECK (
        (execution_id IS NULL AND generation IS NULL)
        OR (execution_id IS NOT NULL AND generation IS NOT NULL AND generation > 0))
);
INSERT OR IGNORE INTO schema_migrations(version) VALUES ('018_managed_job_transfers.sql'),('088_managed_job_transfers.sql');
