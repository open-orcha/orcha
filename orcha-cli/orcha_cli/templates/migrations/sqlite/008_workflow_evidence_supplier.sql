-- Freeze the evidence supplier's display identity at capture time.  Historical
-- rows are backfilled from the retained actor record during this migration.
ALTER TABLE workflow_evidence ADD COLUMN captured_by_alias TEXT;
ALTER TABLE workflow_evidence ADD COLUMN captured_by_kind TEXT
    CHECK (captured_by_kind IS NULL OR captured_by_kind IN ('human', 'ai'));

UPDATE workflow_evidence
SET captured_by_alias = (
        SELECT alias FROM agents WHERE agents.id = workflow_evidence.captured_by
    ),
    captured_by_kind = (
        SELECT kind FROM agents WHERE agents.id = workflow_evidence.captured_by
    )
WHERE captured_by IS NOT NULL
  AND (captured_by_alias IS NULL OR captured_by_kind IS NULL);

INSERT OR IGNORE INTO schema_migrations (version)
VALUES ('008_workflow_evidence_supplier.sql'), ('078_workflow_evidence_supplier.sql');
