-- GH #350 (workflow redesign, spec §4.14 / §7.1): reversible workflow deactivation.
-- "Hide" is a presentation state separate from lifecycle status: a completed or
-- cancelled workflow with no live worker can be hidden from the usual list and
-- from ordinary task views, and restored later. Nothing is deleted or detached;
-- tasks, messages, evidence and history stay exactly as they were.
ALTER TABLE workflows ADD COLUMN hidden_at TIMESTAMPTZ;
ALTER TABLE workflows ADD COLUMN hidden_by_human_id UUID REFERENCES agents(id);
ALTER TABLE workflows ADD COLUMN hidden_reason TEXT;
CREATE INDEX idx_workflows_visibility ON workflows(container_id, hidden_at, status, id);

INSERT OR IGNORE INTO schema_migrations (version)
VALUES ('010_workflow_visibility.sql'), ('080_workflow_visibility.sql');
