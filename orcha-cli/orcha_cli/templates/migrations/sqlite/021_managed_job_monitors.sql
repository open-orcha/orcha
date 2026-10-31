-- GH #388: monitoring, execution authority and result handling are distinct.
CREATE TABLE managed_job_monitors (
    job_id UUID PRIMARY KEY REFERENCES managed_jobs(job_id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id),
    launch_run_id UUID NOT NULL REFERENCES worker_runs(run_id),
    work_revision INTEGER NOT NULL,
    continue_after_exit BOOLEAN NOT NULL DEFAULT 0,
    capability_digest TEXT,
    execution_until TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    stop_reason TEXT,
    suppress_wake BOOLEAN NOT NULL DEFAULT 0,
    outcome_revision INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT managed_monitor_capability_check CHECK (NOT continue_after_exit OR capability_digest IS NOT NULL)
);
CREATE TABLE managed_job_outcomes (
    job_id UUID NOT NULL REFERENCES managed_job_monitors(job_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CONSTRAINT managed_outcome_revision_check CHECK (revision > 0),
    state TEXT NOT NULL CONSTRAINT managed_outcome_state_check CHECK (state IN ('completed','interrupted','exhausted','unknown')),
    result_digest TEXT,
    termination_verified BOOLEAN NOT NULL,
    reason TEXT NOT NULL CONSTRAINT managed_outcome_reason_check CHECK (reason IN ('result_saved','evidence_unavailable')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
    received_run_id UUID REFERENCES worker_runs(run_id),
    received_at TIMESTAMPTZ,
    handled_run_id UUID REFERENCES worker_runs(run_id),
    handled_at TIMESTAMPTZ,
    handling_digest TEXT,
    disposition TEXT,
    handling_note TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CONSTRAINT managed_outcome_attempts_check CHECK (attempts BETWEEN 0 AND 3),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
    exhaustion_notified_at TIMESTAMPTZ,
    PRIMARY KEY(job_id,revision)
);
CREATE TABLE managed_job_monitor_operations (
    job_id UUID NOT NULL REFERENCES managed_job_monitors(job_id) ON DELETE CASCADE,
    operation_id UUID NOT NULL,
    payload_digest TEXT NOT NULL,
    receipt JSONB NOT NULL,
    PRIMARY KEY(job_id,operation_id)
);
CREATE TABLE managed_job_waits (
    job_id UUID PRIMARY KEY REFERENCES managed_job_monitors(job_id) ON DELETE CASCADE,
    source_run_id UUID NOT NULL REFERENCES worker_runs(run_id),
    work_revision INTEGER NOT NULL,
    context_digest TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now'))
);
CREATE TABLE managed_job_wake_receipts (
    job_id UUID NOT NULL,
    outcome_revision INTEGER NOT NULL,
    operation_id UUID NOT NULL,
    admitted_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
    PRIMARY KEY(job_id,outcome_revision,operation_id),
    FOREIGN KEY(job_id,outcome_revision) REFERENCES managed_job_outcomes(job_id,revision) ON DELETE CASCADE
);
CREATE INDEX managed_job_monitors_agent ON managed_job_monitors(agent_id,job_id);
INSERT OR IGNORE INTO schema_migrations(version) VALUES ('021_managed_job_monitors.sql'),('091_managed_job_monitors.sql');
