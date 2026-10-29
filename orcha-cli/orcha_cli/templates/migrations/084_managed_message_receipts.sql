-- Bind scheduling operations to their owning run; legacy callers remain supported.
ALTER TABLE agent_wake_state ADD COLUMN work_run_id UUID REFERENCES worker_runs(run_id);
ALTER TABLE agent_wake_state ADD COLUMN conv_run_id UUID REFERENCES worker_runs(run_id);
ALTER TABLE worker_runs ADD COLUMN managed_commands BOOLEAN NOT NULL DEFAULT false;
-- GH #312: received guidance is distinct from handled guidance and wake acks.
CREATE TABLE managed_message_receipts (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES task_messages(id) ON DELETE CASCADE,
    received_run_id UUID NOT NULL REFERENCES worker_runs(run_id),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    handled_run_id UUID REFERENCES worker_runs(run_id),
    handled_at TIMESTAMPTZ,
    handling_note TEXT,
    outcome TEXT CONSTRAINT managed_message_receipts_outcome_check CHECK (outcome IN ('applied','not_applicable')),
    PRIMARY KEY (task_id,agent_id,message_id),
    CONSTRAINT managed_message_receipts_state_check CHECK ((handled_at IS NULL AND handled_run_id IS NULL AND outcome IS NULL)
        OR (handled_at IS NOT NULL AND handled_run_id IS NOT NULL AND outcome IS NOT NULL))
);
CREATE INDEX managed_message_receipts_pending
    ON managed_message_receipts(task_id,agent_id) WHERE handled_at IS NULL;
