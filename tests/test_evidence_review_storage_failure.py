"""Reviewer storage failure probe using an isolated real attachment directory."""
import pytest
from test_workflow_evidence_service import attempt, submit, finish
from portal_backend import workflow_evidence_service as evidence

@pytest.mark.asyncio
async def test_unavailable_staging_directory_records_missing_and_terminalizes(attempt, db):
    pending = submit(attempt)
    staging = evidence.store.staging_dir()
    staging.rmdir()
    staging.write_text("A file now occupies the staging directory location")
    error = None
    try:
        finish(attempt)
    except OSError as exc:
        error = repr(exc)
    row = db.execute("SELECT status,ended_at FROM worker_runs WHERE run_id=%s", (attempt["run"],))[0]
    saved = db.execute("SELECT state,missing_reason FROM workflow_evidence_sets WHERE id=%s", (pending["evidence_set_id"],))[0]
    print(f"staging directory unavailable: exception={error}, run={row}, evidence={saved}")
    assert error is None, "A filesystem staging failure must be represented as missing evidence"
    assert row["ended_at"] is not None
    assert saved["state"] == "missing" and saved["missing_reason"]
