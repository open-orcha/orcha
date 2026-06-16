-- Codex conversation fallback safety: persist enough process/run metadata for a
-- restarted notifier to reconcile an in-flight one-shot worker. Migration 013
-- already adds the generic host pid; this layers Codex-specific recovery fields
-- on top.
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS runtime TEXT;
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS conversation_ack_ts DOUBLE PRECISION;
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS last_message_path TEXT;
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS worktree TEXT;
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS branch TEXT;
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS base_cwd TEXT;

CREATE INDEX IF NOT EXISTS idx_worker_runs_running_conversation
    ON worker_runs (agent_id, status, runtime, conversation_id, started_at DESC)
    WHERE conversation_id IS NOT NULL;
