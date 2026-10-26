-- Results completed before import are reviewed by the importer, not supplied by
-- them. Give those immutable evidence rows a distinct kind/source so history
-- never mislabels the reviewer as the result supplier.
ALTER TABLE workflow_evidence
    DROP CONSTRAINT workflow_evidence_kind_check;
ALTER TABLE workflow_evidence
    ADD CONSTRAINT workflow_evidence_kind_check
    CHECK (kind IN ('result_summary', 'file_changes', 'log_excerpt',
                    'owner_result', 'outside_result', 'import_result'));

ALTER TABLE workflow_evidence
    DROP CONSTRAINT workflow_evidence_source_check;
ALTER TABLE workflow_evidence
    ADD CONSTRAINT workflow_evidence_source_check
    CHECK (source IN ('worker', 'owner', 'outside', 'import',
                      'cancelled_attempt', 'released_attempt'));
