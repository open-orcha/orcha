"""PR 396 regressions against the selected Git and explicitly supplied Git versions.

Set ORCHA_TEST_GIT_BINARIES to an os.pathsep-separated list for the version matrix.
Every repository and PATH shim belongs to pytest's isolated fixture directory.
"""
from __future__ import annotations

import os
import argparse
import json
from pathlib import Path
import shutil
import subprocess

import pytest

from orcha_cli import cli_worktrees, worktree_cleanup as cleanup, worktree_git as query
from orcha_cli import worktree_lifecycle as lifecycle


BINARIES = list(dict.fromkeys(filter(None, os.environ.get(
    "ORCHA_TEST_GIT_BINARIES", shutil.which("git") or "git"
).split(os.pathsep))))


def git(base, *args):
    return subprocess.run(["git", *args], cwd=base, capture_output=True, check=True).stdout


@pytest.fixture(params=BINARIES, ids=lambda binary: Path(binary).parent.name)
def repository(request, tmp_path, monkeypatch):
    shim = tmp_path / "bin"
    shim.mkdir()
    (shim / "git").symlink_to(request.param)
    monkeypatch.setenv("PATH", str(shim) + os.pathsep + os.environ["PATH"])
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    base = tmp_path / "project"
    base.mkdir()
    git(base, "init", "-q")
    git(base, "symbolic-ref", "HEAD", "refs/heads/main")
    git(base, "config", "user.name", "Orcha test")
    git(base, "config", "user.email", "test@example.invalid")
    git(base, "config", "commit.gpgsign", "false")
    git(base, "commit", "--allow-empty", "-qm", "fixture")
    return base


def test_common_directory_and_cli_root_from_main_linked_and_external(repository):
    base = repository
    nested = base / "subfolder"
    nested.mkdir()
    linked = base / ".orcha-worktrees" / "linked"
    external = base.parent / "external"
    git(base, "worktree", "add", "-qb", "linked", str(linked))
    git(base, "worktree", "add", "-q", "--detach", str(external))
    for folder in (base, nested, linked, external):
        assert query.common_dir(folder) == base / ".git"
        assert cli_worktrees._project_root(str(folder)) == base


@pytest.mark.parametrize("name", ["space name", 'quote"name', "tab\tname", "line\nname", "carriage\rname"])
def test_registration_preserves_filename_bytes_and_locks(repository, name):
    wt = repository.parent / name
    git(repository, "worktree", "add", "-qb", "keep", str(wt))
    git(repository, "worktree", "lock", "--reason", "human hold", str(wt))
    rows = query.registrations(repository)
    row = next(row for row in rows if row["path"] == str(wt))
    assert row["locked"] and row["branch"] == "keep"
    plan = cleanup.preview(repository, lambda rows: {"complete": True, "busy": [], "contexts": {}})
    assert plan["candidate_count"] == 0
    assert plan["items"][0]["reason"] == "Locked worktree"


@pytest.mark.parametrize("raw", ["--path-format=absolute\n.git\n", "\n", ".git\0\n", ".git", "missing\n"])
def test_malformed_common_directory_never_creates_state_or_bypasses_guard(repository, monkeypatch, raw):
    real = query.gc.git
    monkeypatch.setattr(query.gc, "git", lambda args, cwd, **kw: (0, raw)
                        if args == ["rev-parse", "--git-common-dir"] else real(args, cwd, **kw))
    called = []

    @lifecycle.provisioning
    def provision(base):
        called.append(base)
        return None, None

    with pytest.raises(query.CleanupError):
        provision(repository)
    with pytest.raises(query.CleanupError):
        cleanup.preview(repository, lambda rows: {})
    with pytest.raises(query.CleanupError):
        cli_worktrees._project_root(str(repository))
    assert not called
    assert not (repository / ".git/orcha").exists()
    assert not (repository / "--path-format=absolute\n.git").exists()


def test_repository_access_error_is_not_a_non_git_fallback(repository, monkeypatch):
    monkeypatch.setattr(query.gc, "git", lambda *a, **kw: (128, "fatal: detected dubious ownership\n"))

    @lifecycle.provisioning
    def provision(base):
        pytest.fail("must not provision without the cleanup guard")

    with pytest.raises(query.CleanupError):
        provision(repository)


def test_actual_non_git_project_keeps_original_fallback(repository):
    folder = repository.parent / "plain"
    folder.mkdir()

    @lifecycle.provisioning
    def provision(base):
        return "original", None

    assert provision(folder) == ("original", None)
    assert not (folder / "orcha").exists()


@pytest.mark.parametrize("raw", ["", "worktree /x\n", "worktree /x\0HEAD abc\0detached\0\0",
                                   "worktree /x\0HEAD " + "a" * 40 + "\0\0",
                                   "worktree /x\0bare\0worktree /y\0\0"])
def test_malformed_modern_records_are_rejected(raw):
    with pytest.raises(query.CleanupError):
        query._porcelain(raw)


def test_failed_listing_does_not_use_legacy_fallback(repository, monkeypatch):
    real = query.gc.git
    monkeypatch.setattr(query.gc, "git", lambda args, cwd, **kw: (128, "permission denied")
                        if args[:2] == ["worktree", "list"] else real(args, cwd, **kw))
    monkeypatch.setattr(query, "_legacy_registrations", lambda *a: pytest.fail("not an unsupported flag"))
    with pytest.raises(query.CleanupError):
        query.registrations(repository)


def test_lifecycle_contention_returns_immediately_and_recovers(repository):
    with lifecycle.locked(repository):
        with pytest.raises(query.CheckoutBusy, match="retry"):
            with lifecycle.locked(repository):
                pytest.fail("must not bypass a held lock")
    with lifecycle.locked(repository) as root:
        assert root.is_dir()


def test_legacy_job_lock_defers_startup_without_waiting(repository):
    from concurrent.futures import ThreadPoolExecutor
    from orcha_cli.job_store import JobStore

    store = JobStore(repository)
    with ThreadPoolExecutor(max_workers=1) as executor:
        with store.locked():
            attempt = executor.submit(lifecycle.checkout_available, repository, repository / "next")
            with pytest.raises(query.CheckoutBusy, match="retry"):
                attempt.result(timeout=1)
    assert lifecycle.checkout_available(repository, repository / "next")


def test_preview_cleanup_respects_dangling_retention_marker(repository):
    from orcha_cli.notifier_preview import _remove_worktree

    wt = repository.parent / "preview-kept"
    query.add_locked(repository, wt, "HEAD", "Orcha preview", run=query.gc.git)
    (wt / ".orcha-keep").symlink_to("missing")
    _remove_worktree(repository, str(wt))
    assert wt.is_dir()
    assert next(row for row in query.registrations(repository) if row["path"] == str(wt))["locked"]


def test_cli_interruption_is_discoverable_after_reopen_and_recovery(repository, monkeypatch):
    wt = repository.parent / "recoverable"
    git(repository, "worktree", "add", "-q", "--detach", str(wt))
    inactive = lambda rows: {"complete": True, "contexts": {}, "busy": []}
    assert cleanup.pending(repository) == {"ok": True, "plans": []}
    plan = cleanup.preview(repository, inactive)
    assert cleanup.pending(repository)["plans"] == []  # unconfirmed previews do not reserve work
    with monkeypatch.context() as patch:
        def interrupt(*args):
            raise KeyboardInterrupt("isolated interruption")
        patch.setattr(cleanup, "_preserve", interrupt)
        with pytest.raises(KeyboardInterrupt):
            cleanup.execute(repository, plan["plan_id"], inactive)
    saved = cleanup.pending(repository)["plans"]
    assert [p["plan_id"] for p in saved] == [plan["plan_id"]]
    assert saved[0]["status"] == "executing"
    assert not lifecycle.checkout_available(repository, wt)
    assert cleanup.execute(repository, saved[0]["plan_id"], inactive)["status"] == "done"
    assert cleanup.pending(repository)["plans"] == []
    assert lifecycle.checkout_available(repository, wt)


@pytest.mark.parametrize("terminal_receipt", [False, True])
def test_real_cli_recovers_saved_plan_with_damaged_checkout(
    repository, monkeypatch, capsys, terminal_receipt
):
    from orcha_cli import worktree_cleanup_activity
    from orcha_cli.job_store import atomic_json, read_json

    wt = repository.parent / "damaged-during-removal"
    git(repository, "worktree", "add", "-q", "--detach", str(wt))
    inactive = lambda rows: {"complete": True, "contexts": {}, "busy": []}
    monkeypatch.setattr(worktree_cleanup_activity, "provider", lambda *args: inactive)
    plan = cleanup.preview(repository, inactive)
    with monkeypatch.context() as patch:
        def interrupt(*args):
            raise KeyboardInterrupt("fixture controller interrupted")
        patch.setattr(cleanup, "_preserve", interrupt)
        with pytest.raises(KeyboardInterrupt):
            cleanup.execute(repository, plan["plan_id"], inactive)
    assert not lifecycle.checkout_available(repository, wt)
    # An interrupted Git removal can leave a directory whose pointer is gone.
    # Real CLI project discovery must still reach the saved recovery plan.
    (wt / ".git").unlink()
    if terminal_receipt:
        saved = repository / ".git/orcha/worktree-cleanup" / (plan["plan_id"] + ".json")
        receipt = read_json(saved)
        receipt["status"] = "done"
        receipt["items"][0].update(outcome="kept", reason="Fixture saved terminal receipt")
        atomic_json(saved, receipt)

    parser = argparse.ArgumentParser()
    cli_worktrees.register(parser.add_subparsers(), cli_worktrees.cmd_worktrees)

    def invoke(action, *args):
        parsed = parser.parse_args(["worktrees", action, *args, "--project", str(repository), "--json"])
        parsed.func(parsed)
        return json.loads(capsys.readouterr().out)

    assert [row["plan_id"] for row in invoke("pending")["plans"]] == [plan["plan_id"]]
    assert invoke("status", plan["plan_id"])["plan_id"] == plan["plan_id"]
    done = invoke("execute", plan["plan_id"])
    assert done["status"] == "done" and not done["removed"]
    assert done["items"][0]["outcome"] == "kept" and wt.is_dir()
    assert lifecycle.checkout_available(repository, wt)
    assert invoke("pending")["plans"] == []


def test_two_hundred_checkouts_on_each_supported_git(repository, monkeypatch, record_property):
    import time

    for n in range(200):
        git(repository, "worktree", "add", "-q", "--detach", str(repository.parent / f"old-{n}"))
    calls = []
    real = query.gc.git

    def measured(args, *pos, **kwargs):
        calls.append(args)
        return real(args, *pos, **kwargs)

    monkeypatch.setattr(query.gc, "git", measured)
    inactive = lambda rows: {"complete": True, "contexts": {}, "busy": []}
    started = time.monotonic()
    plan = cleanup.preview(repository, inactive)
    assert plan["candidate_count"] == 200
    done = cleanup.execute(repository, plan["plan_id"], inactive)
    elapsed = time.monotonic() - started
    assert {r["path"] for r in done["removed"]} == {r["path"] for r in plan["items"]}
    assert len(query.registrations(repository)) == 1
    head_queries = sum(bool(args and args[0].startswith("--git-dir=")) for args in calls)
    assert head_queries <= 3 * 200  # full preview plus two target-only checks per checkout
    record_property("git_version", git(repository, "--version").decode().strip())
    record_property("cleanup_seconds", round(elapsed, 2))
    record_property("git_subprocesses", len(calls))


def test_preview_lock_creation_works_with_old_and_current_git(repository):
    wt = repository.parent / "preview"
    query.add_locked(repository, wt, "HEAD", "Orcha preview", run=query.gc.git)
    row = next(r for r in query.registrations(repository) if r["path"] == str(wt))
    assert row["locked"]
    admin = git(wt, "rev-parse", "--absolute-git-dir").decode().rstrip("\n")
    assert (Path(admin) / "locked").read_text() == "Orcha preview\n"


def test_foreign_lock_is_preserved_during_preview_creation(repository):
    wt = repository.parent / "preview"

    def intervening_git(args, cwd):
        code, out = query.gc.git(args, cwd)
        if not code:
            admin = git(wt, "rev-parse", "--absolute-git-dir").decode().rstrip("\n")
            (Path(admin) / "locked").write_text("human hold\n")
        return code, out

    with pytest.raises(query.CleanupError, match="another lock"):
        query.add_locked(repository, wt, "HEAD", "Orcha preview", run=intervening_git)
    admin = git(wt, "rev-parse", "--absolute-git-dir").decode().rstrip("\n")
    assert (Path(admin) / "locked").read_text() == "human hold\n"


@pytest.mark.parametrize("raw", ["--path-format=absolute\n--no-optional-locks\n--git-common-dir\n",
                                 "--path-format=absolute\n.git\n", "missing\n", ""])
def test_automatic_cleanup_state_never_forms_a_path_from_bad_output(repository, monkeypatch, raw):
    """Overnight step 4: automatic cleanup created a folder named from echoed options."""
    real = query.gc.git
    monkeypatch.setattr(query.gc, "git", lambda args, cwd, **kw: (0, raw)
                        if args == ["rev-parse", "--git-common-dir"] else real(args, cwd, **kw))
    before = sorted(p.name for p in repository.iterdir())
    assert query.gc.state_path(repository) is None
    query.gc.save_state(repository, {"first_seen": {"x": 1}})
    assert query.gc.load_state(repository) == {}
    assert sorted(p.name for p in repository.iterdir()) == before
    assert not (repository / ".git/orcha").exists()


@pytest.mark.parametrize("change", ["dropped", "rewritten"])
@pytest.mark.parametrize("second_guard_only", [False, True])
def test_incomplete_worktree_list_never_offers_a_locked_checkout(repository, monkeypatch, change,
                                                                  second_guard_only):
    """Overnight step 7: a list missing a locked checkout's record made it look like a leftover."""
    wt = repository / ".orcha-worktrees" / "held"
    git(repository, "worktree", "add", "-qb", "held", str(wt))
    git(repository, "worktree", "lock", "--reason", "human hold", str(wt))
    inactive = lambda rows: {"complete": True, "busy": [], "contexts": {}}
    first = cleanup.preview(repository, inactive)
    assert first["candidate_count"] == 0
    real = query.gc.git
    head = git(repository, "rev-parse", "HEAD").decode().strip()
    # Modern (-z) output, supplied directly so every Git version runs the modern parser.
    listed = "worktree %s\0HEAD %s\0branch refs/heads/main\0\0" % (repository, head)
    if change == "rewritten":
        listed += "worktree %s\0HEAD %s\0branch refs/heads/held\0locked\0\0" % (
            repository.parent / "moved", head)

    def fake(args, cwd, **kw):
        if args == ["worktree", "list", "--porcelain", "-z"]:
            return 0, listed
        return real(args, cwd, **kw)

    monkeypatch.setattr(query.gc, "git", fake)
    if second_guard_only:
        monkeypatch.setattr(query, "_require_recorded", lambda rows, common: None)
        plan = cleanup.preview(repository, inactive)
        assert plan["candidate_count"] == 0
        item = next(i for i in plan["items"] if i.get("path") == str(wt))
        assert "Git still records this folder" in item["reason"], item
    else:
        with pytest.raises(query.CleanupError, match="left out a registered checkout"):
            query.registrations(repository)
        with pytest.raises(query.CleanupError):
            cleanup.preview(repository, inactive)
    assert wt.is_dir() and (repository / ".git/worktrees/held/locked").exists()
