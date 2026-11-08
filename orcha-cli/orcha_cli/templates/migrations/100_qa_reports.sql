-- Imported Quality reports: what someone else's run covered, as they reported it. Never proof
-- for this project: a person re-runs it here, or reads it as reported.

CREATE TABLE qa_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    file_name TEXT,
    data TEXT NOT NULL,
    imported_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX qa_reports_container_idx ON qa_reports (container_id, created_at DESC);
