-- 034_sandbox_runs.sql
-- Spec §3.3c: sandbox wakes stamp their docker container name so a restarted
-- daemon re-adopts live runs by label instead of orphaning them, and so
-- metering can attribute container runtime to a run row.
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS sandbox_container_id TEXT;
CREATE INDEX IF NOT EXISTS idx_worker_runs_sandbox_live
    ON worker_runs (sandbox_container_id) WHERE status = 'running';
