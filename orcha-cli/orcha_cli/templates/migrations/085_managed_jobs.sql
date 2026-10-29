-- GH #312: server ownership is separate from the private command evidence.
CREATE TABLE managed_run_limits (
    run_id UUID PRIMARY KEY REFERENCES worker_runs(run_id) ON DELETE CASCADE,
    run_until TIMESTAMPTZ NOT NULL,
    sandbox_until TIMESTAMPTZ,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE managed_jobs (
    job_id UUID PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    job_key UUID NOT NULL,
    launch_nonce UUID NOT NULL,
    owner_run_id UUID NOT NULL REFERENCES worker_runs(run_id),
    workflow_generation INTEGER,
    state TEXT NOT NULL DEFAULT 'reserved'
        CONSTRAINT managed_jobs_state_check CHECK (state IN ('reserved','running','completed','interrupted','unknown','exhausted')),
    version INTEGER NOT NULL DEFAULT 0,
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    budget_until TIMESTAMPTZ NOT NULL,
    max_elapsed_secs INTEGER NOT NULL DEFAULT 7200,
    max_transfers INTEGER NOT NULL DEFAULT 3,
    transfers_used INTEGER NOT NULL DEFAULT 0,
    checkpoint_version INTEGER NOT NULL DEFAULT 0,
    checkpoint_digest TEXT,
    result_digest TEXT,
    termination_verified BOOLEAN NOT NULL DEFAULT false,
    UNIQUE(task_id,job_key),
    CONSTRAINT managed_jobs_counts_check CHECK (version >= 0 AND checkpoint_version >= 0
        AND max_elapsed_secs > 0 AND max_elapsed_secs <= 86400
        AND max_transfers >= 0 AND max_transfers <= 10
        AND transfers_used >= 0 AND transfers_used <= max_transfers),
    CONSTRAINT managed_jobs_evidence_check CHECK (
        (checkpoint_version = 0 AND checkpoint_digest IS NULL)
        OR (checkpoint_version > 0 AND checkpoint_digest IS NOT NULL)),
    CONSTRAINT managed_jobs_terminal_check CHECK (NOT termination_verified
        OR (state IN ('completed','interrupted','exhausted') AND result_digest IS NOT NULL))
);
CREATE INDEX managed_jobs_owner ON managed_jobs(owner_run_id);
CREATE TABLE managed_job_operations (
    job_id UUID NOT NULL REFERENCES managed_jobs(job_id) ON DELETE CASCADE,
    operation_id UUID NOT NULL,
    payload_digest TEXT NOT NULL,
    PRIMARY KEY(job_id,operation_id)
);
