-- GH #350 (workflow redesign, spec §4.14 / §7.1): reversible workflow deactivation.
-- "Hide" is a presentation state separate from lifecycle status: a completed or
-- cancelled workflow with no live worker can be hidden from the usual list and
-- from ordinary task views, and restored later. Nothing is deleted or detached;
-- tasks, messages, evidence and history stay exactly as they were.
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS hidden_by_human_id UUID REFERENCES agents(id);
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS hidden_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_workflows_visibility ON workflows(container_id, hidden_at, status, id);
