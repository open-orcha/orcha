"""Real filesystem boundaries for private managed-command evidence."""

import concurrent.futures
import json
import os
import stat
import subprocess
from uuid import uuid4
from pathlib import Path

import pytest

from orcha_cli.job_store import (
    JobStorageError, JobStore, command_summary, jobs_root, worktree_teardown_guard,
)


def test_private_records_are_ignored_in_an_unconfigured_repository(tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    store = JobStore(tmp_path)
    job = str(uuid4())
    record = store.reserve(job, {"status": "reserved", "cwd": str(tmp_path)})
    store.checkpoint(job, record["version"], {"pending_messages": [str(uuid4())]})
    with store.open_output(job, "stdout") as output:
        output.write(b"private output fixture, never attached or staged\n")
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    staged = subprocess.check_output(["git", "diff", "--cached", "--name-only"], cwd=tmp_path)
    assert staged == b""
    for path in store.root.rglob("*"):
        assert stat.S_IMODE(path.stat().st_mode) == (0o700 if path.is_dir() else 0o600)
    assert stat.S_IMODE(store.root.stat().st_mode) == 0o700


def test_worktree_uses_root_storage_and_non_git_directory_is_supported(tmp_path):
    worktree = tmp_path / ".orcha-worktrees" / "task"
    worktree.mkdir(parents=True)
    (worktree / ".git").write_text(f"gitdir: {tmp_path}/.git/worktrees/task\n")
    assert jobs_root(worktree) == tmp_path / ".claude" / ".orcha-jobs"
    assert JobStore(worktree).root == JobStore(tmp_path).root


def test_concurrent_reservations_and_stale_checkpoint_cannot_overwrite(tmp_path):
    store = JobStore(tmp_path)
    job = str(uuid4())
    def reserve(n):
        return store.reserve(job, {"status": "reserved", "cwd": str(tmp_path), "attempt": n})
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(reserve, range(8)))
    assert all(record == records[0] for record in records)
    updated = store.checkpoint(job, 0, {"completed_steps": ["tests launched"]})
    with pytest.raises(JobStorageError):
        store.checkpoint(job, 0, {"completed_steps": ["stale worker"]})
    assert json.loads(Path(updated["checkpoint"]).read_text())["completed_steps"] == ["tests launched"]
    assert store.read(job)["version"] == 1


def test_checkpoint_pointer_never_precedes_durable_evidence(tmp_path, monkeypatch):
    store = JobStore(tmp_path)
    job = str(uuid4())
    store.reserve(job, {"status": "running", "cwd": str(tmp_path)})
    original = os.replace
    def fail_publish(source, destination):
        if destination.name == "record.json":
            raise OSError("simulated disk failure")
        original(source, destination)
    monkeypatch.setattr(os, "replace", fail_publish)
    with pytest.raises(OSError):
        store.checkpoint(job, 0, {"pending_messages": ["pending"]})
    assert "checkpoint" not in store.read(job)
    assert store.read(job)["version"] == 0
    assert (store.job_directory(job) / "checkpoint-1.json").is_file()


def test_live_unknown_and_unsaved_jobs_retain_the_worktree(tmp_path):
    store = JobStore(tmp_path)
    job = str(uuid4())
    store.reserve(job, {"status": "running", "cwd": str(tmp_path)})
    with store.locked():
        assert store.retains_worktree(tmp_path)
    store.update(job, 0, {"status": "completed", "termination_verified": True})
    with store.locked():
        assert store.retains_worktree(tmp_path)
    store.update(job, 1, {"result_saved": True})
    with store.locked():
        assert not store.retains_worktree(tmp_path)
    (store.job_directory(job) / "record.json").write_text("partial write")
    with store.locked():
        assert store.retains_worktree(tmp_path)


def test_symlink_storage_and_path_traversal_are_refused(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    claude = tmp_path / ".claude"
    claude.mkdir()
    (claude / ".orcha-jobs").symlink_to(outside, target_is_directory=True)
    with pytest.raises(JobStorageError):
        JobStore(tmp_path)
    assert list(outside.iterdir()) == []
    (claude / ".orcha-jobs").unlink()
    store = JobStore(tmp_path)
    with pytest.raises(JobStorageError):
        store.reserve("../../outside", {})


def test_command_metadata_omits_unrecognized_values():
    secret = "example-private-credential"
    summary = command_summary(["/usr/bin/python3", "-c", secret, "--password=" + secret])
    assert summary == "python3 [3 argument values omitted]"
    assert secret not in command_summary([secret, secret])


def test_job_registration_rechecks_directory_after_teardown_lock(tmp_path):
    cwd = tmp_path / "worktree"
    cwd.mkdir()
    store = JobStore(tmp_path)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        with worktree_teardown_guard(tmp_path, cwd) as retained:
            assert retained is None
            future = pool.submit(store.reserve, str(uuid4()), {"cwd": str(cwd), "status": "reserved"})
            cwd.rmdir()
        with pytest.raises(JobStorageError, match="directory is unavailable"):
            future.result(timeout=2)


def test_all_cleanup_paths_keep_a_clean_worktree_with_a_managed_job(tmp_path, monkeypatch):
    from orcha_cli import notifier, notifier_worktree_gc, worktree_gc

    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True)
    git("init", "-q", "-b", "main")
    git("config", "user.email", "test@example.invalid")
    git("config", "user.name", "Test")
    (tmp_path / "README").write_text("fixture")
    git("add", "README")
    git("commit", "-qm", "fixture")
    worktree = tmp_path / ".orcha-worktrees" / "Fixture-1"
    branch = "orcha/wk-Fixture-1790000000015"
    git("worktree", "add", "-q", "-b", branch, str(worktree))
    nested = worktree / "tests"
    nested.mkdir()
    store = JobStore(tmp_path)
    store.reserve(str(uuid4()), {"status": "running", "cwd": str(nested)})
    assert notifier._safe_teardown_worktree(str(tmp_path), str(worktree), branch) == "preserved-job"
    assert notifier._reclaim_task_worktree(str(tmp_path), str(worktree), branch) == "preserved-job"
    result = worktree_gc.remove_worktree(str(tmp_path), str(worktree), include_process_cwds=False)
    assert result["outcome"] == "refused"
    assert result["state"] == worktree_gc.STATE_IN_USE
    monkeypatch.setattr(notifier_worktree_gc.STATE, "settings", {"auto_cleanup": True})
    result = notifier_worktree_gc.after_run("http://unused.invalid", {
        "base_cwd": str(tmp_path), "worktree": str(worktree), "branch": branch,
    }, post=lambda *a: None, get=lambda *a: {})
    assert result["outcome"] == "refused"
    assert result["state"] == worktree_gc.STATE_IN_USE
    assert worktree.is_dir()
    git("show-ref", "--verify", "refs/heads/" + branch)
