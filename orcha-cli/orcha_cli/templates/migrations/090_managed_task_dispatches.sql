-- Retain accepted task guidance even if its worker never registers a run.
-- Separate from managed_message_windows, whose first_run_id requires a real run.
CREATE TABLE managed_task_dispatches (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (task_id,agent_id)
);
