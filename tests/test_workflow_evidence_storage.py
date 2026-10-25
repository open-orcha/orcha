"""Real-file checks for immutable workflow evidence, independent of run diagnostics."""

import hashlib
import uuid
from dataclasses import replace

import pytest

from portal_backend import deliverables_storage as store
from portal_backend.workflow_evidence_storage import (
    EvidenceStorageError,
    evidence_file_state,
    publish_evidence,
    stage_evidence,
)


@pytest.fixture
def destination(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "attachments_dir", lambda: tmp_path)
    return {
        "task_id": str(uuid.uuid4()),
        "deliverable_id": str(uuid.uuid4()),
        "version": 1,
        "logical_path": "workflow-evidence/result-001.txt",
    }


def state(destination, data, stored_name="v1.txt"):
    return evidence_file_state(
        task_id=destination["task_id"],
        deliverable_id=destination["deliverable_id"],
        stored_name=stored_name,
        sha256=hashlib.sha256(data).hexdigest(),
    )


def test_version_remains_exact_when_a_new_result_is_published(destination):
    first = stage_evidence(b"First report")
    assert publish_evidence(first, **destination) == "v1.txt"
    assert not first.path.exists()
    second = stage_evidence(b"Corrected report")
    publish_evidence(second, **{**destination, "version": 2})
    assert state(destination, b"First report") == "readable"
    assert state(destination, b"Corrected report", "v2.txt") == "readable"
    assert state(destination, b"Corrected report") == "corrupt"


def test_database_retry_reuses_identical_bytes_without_overwriting(destination):
    publish_evidence(stage_evidence(b"Report"), **destination)
    publish_evidence(stage_evidence(b"Report"), **destination)
    with pytest.raises(EvidenceStorageError, match="evidence_version_conflict"):
        publish_evidence(stage_evidence(b"Replacement"), **destination)
    assert state(destination, b"Report") == "readable"


def test_missing_or_corrupt_historical_version_never_uses_newer_bytes(destination):
    publish_evidence(stage_evidence(b"Accepted report"), **destination)
    publish_evidence(stage_evidence(b"Later report"), **{**destination, "version": 2})
    path = store.resolve_version_file(
        destination["task_id"], destination["deliverable_id"], "v1.txt"
    )
    path.write_bytes(b"damaged")
    assert state(destination, b"Accepted report") == "corrupt"
    path.unlink()
    assert state(destination, b"Accepted report") == "missing"
    assert state(destination, b"Later report", "v2.txt") == "readable"


def test_changed_stage_is_not_published(destination):
    staged = stage_evidence(b"Report")
    staged.path.write_bytes(b"Edited")
    with pytest.raises(EvidenceStorageError, match="evidence_stage_changed"):
        publish_evidence(staged, **destination)
    assert state(destination, b"Report") == "missing"


def test_cap_is_checked_before_staging_and_again_at_publish(destination, monkeypatch):
    monkeypatch.setattr(store, "max_deliverable_bytes", lambda: 6)
    with pytest.raises(EvidenceStorageError, match="evidence_file_too_large"):
        stage_evidence(b"Too large")
    staged = stage_evidence(b"Report")
    monkeypatch.setattr(store, "max_deliverable_bytes", lambda: 5)
    with pytest.raises(EvidenceStorageError, match="evidence_file_too_large"):
        publish_evidence(staged, **destination)
    assert state(destination, b"Report") == "missing"


@pytest.mark.parametrize("version", [0, 51, True, "1"])
def test_version_caps_require_a_new_shard(destination, version):
    with pytest.raises(EvidenceStorageError, match="evidence_version_limit"):
        publish_evidence(stage_evidence(b"Report"), **{**destination, "version": version})


def test_stage_and_destination_cannot_escape_the_attachment_store(destination, tmp_path):
    staged = stage_evidence(b"Report")
    outside = tmp_path / "outside.txt"
    outside.write_bytes(b"Report")
    with pytest.raises(EvidenceStorageError, match="invalid_evidence_stage"):
        publish_evidence(replace(staged, path=outside), **destination)
    with pytest.raises(EvidenceStorageError, match="invalid_evidence_identity"):
        publish_evidence(staged, **{**destination, "task_id": "../outside"})
    staged.path.unlink()
    staged.path.symlink_to(outside)
    with pytest.raises(EvidenceStorageError, match="invalid_evidence_stage"):
        publish_evidence(staged, **destination)


def test_failed_publication_keeps_prior_version(destination, monkeypatch):
    publish_evidence(stage_evidence(b"Accepted report"), **destination)
    staged = stage_evidence(b"Next report")

    def disk_full(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr("portal_backend.workflow_evidence_storage.os.link", disk_full)
    with pytest.raises(EvidenceStorageError, match="evidence_publish_failed"):
        publish_evidence(staged, **{**destination, "version": 2})
    assert state(destination, b"Accepted report") == "readable"
    assert state(destination, b"Next report", "v2.txt") == "missing"
    assert staged.path.exists()
