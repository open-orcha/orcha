-- Imported Quality reports: what someone else's run covered, as they reported it. Never proof
-- for this project: a person re-runs it here, or reads it as reported.

CREATE TABLE qa_reports (
    id UUID PRIMARY KEY,
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    file_name TEXT,
    data TEXT NOT NULL,
    imported_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00')
);
CREATE INDEX qa_reports_container_idx ON qa_reports (container_id, created_at DESC);

INSERT OR IGNORE INTO schema_migrations (version)
VALUES ('030_qa_reports.sql'), ('100_qa_reports.sql');
