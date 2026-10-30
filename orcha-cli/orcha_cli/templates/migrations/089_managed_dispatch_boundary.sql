-- Preserve the work claim clock independently of wake acknowledgements.
ALTER TABLE agent_wake_state ADD COLUMN work_dispatch_started_at TIMESTAMPTZ;
-- Retain the boundary when a task is attributed after run registration.
ALTER TABLE worker_runs ADD COLUMN dispatch_started_at TIMESTAMPTZ;
