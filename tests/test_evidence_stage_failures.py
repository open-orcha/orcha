"""Storage failure leaves a terminal run with explicit, unacceptably missing evidence."""

import hashlib
import json
from pathlib import Path

from fastapi import HTTPException
import pytest

from portal_backend import workflow_evidence_storage as storage
from portal_backend import workflow_evidence_service as evidence
from test_workflow_evidence_service import attempt, submit, finish, validate


def test_restore_audit_distinguishes_missing_after_restore_and_yields_to_repair(
    monkeypatch, tmp_path,
):
    root = tmp_path / "attachments"
    monkeypatch.setattr(storage.store, "attachments_dir", lambda: root)
    task_id = "11111111-1111-4111-8111-111111111111"
    deliverable_id = "22222222-2222-4222-8222-222222222222"
    data = b"exact restored evidence"
    digest = hashlib.sha256(data).hexdigest()
    relative = f"deliverables/{task_id}/{deliverable_id}/v1.txt"
    audit = root / ".restore-audits" / "current.json"
    audit.parent.mkdir(parents=True)
    audit.write_text(json.dumps({"items": [{
        "path": relative, "sha256": digest, "storage_state": "missing_after_restore",
    }]}))

    args = dict(task_id=task_id, deliverable_id=deliverable_id,
                stored_name="v1.txt", sha256=digest)
    assert storage.evidence_file_state(**args) == "missing_after_restore"
    restored = root / relative
    restored.parent.mkdir(parents=True)
    restored.write_bytes(data)
    assert storage.evidence_file_state(**args) == "readable"


@pytest.mark.parametrize("failure", ["mkdir", "write", "sync", "hash_read", "hash_changed", "publish_setup"])
async def test_stage_failure_freezes_missing_before_terminal_and_blocks_acceptance(
    attempt, db, monkeypatch, failure,
):
    pending = submit(attempt)
    original_hash = evidence.store.sha256_file
    original_sync = storage._sync_directory

    def unavailable(*args, **kwargs):
        raise OSError("test attachment storage unavailable")

    if failure == "mkdir":
        staging = evidence.store.staging_dir()
        staging.rmdir()
        staging.write_text("blocked")
    elif failure == "write":
        # The real exclusive open fails when its destination is a directory.
        blocked = evidence.store.staging_dir() / "blocked"
        blocked.mkdir()
        monkeypatch.setattr(evidence.store, "new_staging_path", lambda: blocked)
    elif failure == "sync":
        def fail_staging_sync(path):
            if Path(path) == evidence.store.staging_dir():
                unavailable()
            return original_sync(path)
        monkeypatch.setattr(storage, "_sync_directory", fail_staging_sync)
    elif failure in {"hash_read", "hash_changed"}:
        def fail_staging_hash(path):
            if Path(path).parent == evidence.store.staging_dir():
                if failure == "hash_changed":
                    return "0" * 64
                unavailable()
            return original_hash(path)
        monkeypatch.setattr(evidence.store, "sha256_file", fail_staging_hash)
    else:
        original_publish = evidence.publish_evidence
        def fail_publish_setup(*args, **kwargs):
            with monkeypatch.context() as patch:
                patch.setattr(evidence.store, "staging_dir", unavailable)
                return original_publish(*args, **kwargs)
        monkeypatch.setattr(evidence, "publish_evidence", fail_publish_setup)

    original_freeze = evidence._freeze_evidence
    def check_before_terminal(cur, run, *args):
        saved = original_freeze(cur, run, *args)
        cur.execute("SELECT ended_at FROM worker_runs WHERE run_id=%s", (attempt["run"],))
        assert cur.fetchone()["ended_at"] is None
        assert saved["state"] == "missing" and saved["missing_reason"]
        return saved
    monkeypatch.setattr(evidence, "_freeze_evidence", check_before_terminal)

    original_prune = evidence.prune_old_run_detail
    def check_before_prune(cur, aid):
        cur.execute("SELECT state,missing_reason FROM workflow_evidence_sets WHERE id=%s",
                    (pending["evidence_set_id"],))
        row = cur.fetchone()
        assert row["state"] == "missing" and row["missing_reason"]
        return original_prune(cur, aid)
    monkeypatch.setattr(evidence, "prune_old_run_detail", check_before_prune)
    saved = finish(attempt)
    assert saved["state"] == "missing" and saved["missing_reason"]
    assert db.execute("SELECT ended_at FROM worker_runs WHERE run_id=%s", (attempt["run"],))[0]["ended_at"]
    with pytest.raises(HTTPException) as exc:
        validate(attempt, saved)
    assert exc.value.status_code == 409 and exc.value.detail["code"] == "evidence_not_saved"
    repeated = finish(attempt)
    assert repeated["items"] == saved["items"]
    assert repeated["state"] == "missing"
