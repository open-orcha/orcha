-- Freeze the evidence supplier's display identity at capture time.  The actor
-- row remains the authority; these fields make later review independent of
-- alias edits or membership changes.
ALTER TABLE workflow_evidence ADD COLUMN captured_by_alias TEXT;
ALTER TABLE workflow_evidence ADD COLUMN captured_by_kind TEXT
    CONSTRAINT workflow_evidence_captured_by_kind_check
    CHECK (captured_by_kind IS NULL OR captured_by_kind IN ('human', 'ai'));

UPDATE workflow_evidence e
SET captured_by_alias = a.alias,
    captured_by_kind = a.kind
FROM agents a
WHERE a.id = e.captured_by
  AND (e.captured_by_alias IS NULL OR e.captured_by_kind IS NULL);
