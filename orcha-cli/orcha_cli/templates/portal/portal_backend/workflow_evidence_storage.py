"""Stage and publish immutable workflow evidence using the deliverable store.

The evidence service owns database transactions, version allocation and the existing
deliverable-count/version caps. These helpers make bytes durable before that service
records their exact hash. Publication never overwrites an earlier version, including
after a database rollback. Unreferenced files can be collected separately.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import uuid
from dataclasses import dataclass

from portal_backend import deliverables_storage as store


class EvidenceStorageError(ValueError):
    """Capture must record missing evidence and keep acceptance blocked."""


@dataclass(frozen=True)
class StagedEvidence:
    path: pathlib.Path
    sha256: str
    size_bytes: int


def _sync_directory(path: pathlib.Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def stage_evidence(data: bytes) -> StagedEvidence:
    """Write a bounded, hashed snapshot to the existing attachment staging area."""
    if len(data) > store.max_deliverable_bytes():
        raise EvidenceStorageError("evidence_file_too_large")
    try:
        path = store.new_staging_path()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        _sync_directory(path.parent)
        digest = store.sha256_file(path)
        if digest != hashlib.sha256(data).hexdigest():
            raise EvidenceStorageError("evidence_stage_changed")
    except OSError as exc:
        # The caller records the error before making its run prune-eligible.
        raise EvidenceStorageError("evidence_stage_failed") from exc
    return StagedEvidence(path, digest, len(data))


def _valid_id(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise EvidenceStorageError("invalid_evidence_identity") from exc


def publish_evidence(
    staged: StagedEvidence, *, task_id: str, deliverable_id: str, version: int,
    logical_path: str,
) -> str:
    """Publish one allocated version and return its stored name.

    Link-then-unlink is atomic and refuses overwrite; staging and versions share the
    attachment filesystem. An existing identical file is an idempotent retry, while
    changed bytes at the same version fail closed. The database caller must allocate
    versions under its task/deliverable lock and commit only after this succeeds.
    """
    task_id, deliverable_id = _valid_id(task_id), _valid_id(deliverable_id)
    if type(version) is not int or not 1 <= version <= store.MAX_VERSIONS_PER_DELIVERABLE:
        raise EvidenceStorageError("evidence_version_limit")
    logical_path = store.normalize_path(logical_path)
    try:
        stage_root = store.staging_dir().resolve()
        if staged.path.is_symlink() or staged.path.parent.resolve() != stage_root:
            raise EvidenceStorageError("invalid_evidence_stage")
        if not staged.path.is_file():
            raise EvidenceStorageError("evidence_stage_missing")
        if (
            staged.path.stat().st_size != staged.size_bytes
            or store.sha256_file(staged.path) != staged.sha256
        ):
            raise EvidenceStorageError("evidence_stage_changed")
        if staged.size_bytes > store.max_deliverable_bytes():
            raise EvidenceStorageError("evidence_file_too_large")
        directory = store.deliverable_dir(task_id, deliverable_id)
        if directory is None:
            raise EvidenceStorageError("invalid_evidence_destination")
        directory.mkdir(parents=True, exist_ok=True)
        name = store.stored_name_for(version, logical_path)
        destination = directory / name
        try:
            os.link(staged.path, destination, follow_symlinks=False)
        except FileExistsError:
            if destination.is_symlink() or not destination.is_file():
                raise EvidenceStorageError("evidence_version_conflict")
            if store.sha256_file(destination) != staged.sha256:
                raise EvidenceStorageError("evidence_version_conflict")
        _sync_directory(directory)
        # Persist newly-created task/deliverable directory entries too.
        _sync_directory(directory.parent)
        _sync_directory(directory.parent.parent)
        staged.path.unlink()
        _sync_directory(stage_root)
        return name
    except OSError as exc:
        raise EvidenceStorageError("evidence_publish_failed") from exc


def evidence_file_state(
    *, task_id: str, deliverable_id: str, stored_name: str, sha256: str,
) -> str:
    """Inspect an exact historical version; never substitute its latest version."""
    try:
        path = store.resolve_version_file(task_id, deliverable_id, stored_name)
        if path is None:
            audit = store.attachments_dir() / ".restore-audits" / "current.json"
            try:
                document = json.loads(audit.read_text())
            except (OSError, ValueError, TypeError):
                return "missing"
            if not isinstance(document, dict) or not isinstance(document.get("items"), list):
                return "missing"
            expected = (
                pathlib.PurePosixPath("deliverables") / str(task_id)
                / str(deliverable_id) / stored_name
            ).as_posix()
            for item in document.get("items", []):
                if isinstance(item, dict) and (
                    item.get("path") == expected
                    and item.get("sha256") == sha256
                    and item.get("storage_state") == "missing_after_restore"
                ):
                    return "missing_after_restore"
            return "missing"
        return "readable" if store.sha256_file(path) == sha256 else "corrupt"
    except OSError:
        return "missing"
