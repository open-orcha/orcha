-- SQLite cannot widen a CHECK constraint in place. Rebuild this feature table
-- after supplier columns exist; no table references workflow_evidence rows.
CREATE TABLE workflow_evidence_import_source (
    id UUID PRIMARY KEY NOT NULL,
    evidence_set_id UUID NOT NULL REFERENCES workflow_evidence_sets(id),
    task_id UUID NOT NULL,
    kind TEXT NOT NULL CONSTRAINT workflow_evidence_kind_check CHECK (
        kind IN ('result_summary', 'file_changes', 'log_excerpt',
                        'owner_result', 'outside_result', 'import_result')),
    source TEXT NOT NULL CONSTRAINT workflow_evidence_source_check CHECK (
        source IN ('worker', 'owner', 'outside', 'import',
                          'cancelled_attempt', 'released_attempt')),
    snapshot_phase TEXT NOT NULL CONSTRAINT workflow_evidence_snapshot_phase_check CHECK (
        snapshot_phase IN ('submission', 'terminal')),
    deliverable_id UUID NOT NULL,
    deliverable_version INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    complete BOOLEAN NOT NULL DEFAULT 1,
    note TEXT,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    captured_by UUID REFERENCES agents(id),
    captured_by_alias TEXT,
    captured_by_kind TEXT CONSTRAINT workflow_evidence_captured_by_kind_check CHECK (
        captured_by_kind IS NULL OR captured_by_kind IN ('human', 'ai')),
    FOREIGN KEY (deliverable_id, deliverable_version)
        REFERENCES task_deliverable_versions(deliverable_id, version),
    FOREIGN KEY (deliverable_id, task_id) REFERENCES task_deliverables(id, task_id),
    FOREIGN KEY (evidence_set_id, task_id) REFERENCES workflow_evidence_sets(id, task_id),
    UNIQUE (evidence_set_id, kind, snapshot_phase)
);

INSERT INTO workflow_evidence_import_source
SELECT id,evidence_set_id,task_id,kind,source,snapshot_phase,deliverable_id,
       deliverable_version,sha256,complete,note,captured_at,captured_by,
       captured_by_alias,captured_by_kind
FROM workflow_evidence;

DROP TABLE workflow_evidence;
ALTER TABLE workflow_evidence_import_source RENAME TO workflow_evidence;

INSERT OR IGNORE INTO schema_migrations (version)
VALUES ('009_workflow_import_evidence.sql'), ('079_workflow_import_evidence.sql');
