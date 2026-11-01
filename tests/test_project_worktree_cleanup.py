"""Real repositories for the confirmed project-wide cleanup (#392)."""
from pathlib import Path

import pytest

from orcha_cli import worktree_cleanup as cleanup
from orcha_cli import worktree_cleanup_scan as scan
from test_worktree_gc import project, _worktree, _git, _age, _row


def inactive(rows):
    return {"complete": True, "busy": [], "contexts": {}}


@pytest.mark.parametrize("marker", ["file", "dangling-link"])
def test_keep_marker_protects_legacy_and_project_cleanup(project, marker):
    from orcha_cli import notifier_worktree_gc as automatic

    wt = _worktree(project, "held", "orcha/wk-Atlas-1234567890123", scaffold=False)
    # Ignore the marker just as real projects do; Git sees an otherwise clean checkout.
    with (project / ".git/info/exclude").open("a") as stream:
        stream.write("\n.orcha-keep\n")
    hold = wt / ".orcha-keep"
    if marker == "file":
        hold.write_text("keep this checkout")
    else:
        hold.symlink_to("missing")
    _age(wt)
    row = _row(project, wt, measure=False)
    assert row["state"] == cleanup.gc.STATE_IN_USE
    assert automatic.plan_row(row, {}, {"auto_cleanup": True, "grace_days": 0}, 0, 2e9)[0] == "keep"
    for dry_run in (True, False):
        result = cleanup.gc.remove_worktree(project, str(wt), dry_run=dry_run, include_process_cwds=False)
        assert not result["ok"] and ".orcha-keep" in result["reason"]
    from orcha_cli.notifier_worktree_cleanup import teardown_worktree
    from test_worktree_gc import _Services
    assert teardown_worktree(str(project), str(wt), row["branch"], _Services(project)) == "preserved-job"
    assert cleanup.preview(project, inactive)["candidate_count"] == 0
    assert wt.exists()


def test_legacy_removal_rechecks_marker_after_saving(project, monkeypatch):
    wt = _worktree(project, "late-hold", "orcha/wk-Atlas-1234567890123", scaffold=False)
    (wt / "output.txt").write_text("real output")
    preserve = cleanup.gc.preserve_output

    def save_then_hold(*args, **kwargs):
        result = preserve(*args, **kwargs)
        (wt / ".orcha-keep").write_text("keep after saving")
        return result

    # Ignored markers must be checked again even when they do not appear in Git status.
    with (project / ".git/info/exclude").open("a") as stream:
        stream.write("\n.orcha-keep\n")
    monkeypatch.setattr(cleanup.gc, "preserve_output", save_then_hold)
    result = cleanup.gc.remove_worktree(project, str(wt), include_process_cwds=False)
    assert not result["ok"] and ".orcha-keep" in result["reason"]
    assert (wt / "output.txt").read_text() == "real output"


@pytest.mark.parametrize("stage", ["discovery", "preservation", "removal"])
def test_slow_cleanup_does_not_block_other_starts_or_checkpoints(project, monkeypatch, stage):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from uuid import uuid4
    from orcha_cli import notifier_worktree_stable as stable
    from orcha_cli.job_store import JobStore, JobStorageError
    from orcha_cli.notifier_preview import PreviewError, resolve_checkout
    from test_worktree_gc import _Services, TASK

    wt = _worktree(project, "live-Held", "orcha/live-Held", scaffold=False)
    store = JobStore(project)
    job = str(uuid4())
    store.reserve(job, {"cwd": str(project), "status": "running"})
    plan = cleanup.preview(project, inactive)
    entered, release = Event(), Event()
    target, name = (scan, "discover") if stage == "discovery" else (
        (cleanup, "_preserve") if stage == "preservation" else (cleanup.gc, "git"))
    original = getattr(target, name)

    def slow(*args, **kwargs):
        if stage != "removal" or args[0][:2] == ["worktree", "remove"]:
            entered.set()
            assert release.wait(10), "test did not release cleanup"
        return original(*args, **kwargs)

    monkeypatch.setattr(target, name, slow)
    with ThreadPoolExecutor(max_workers=3) as pool:
        operation = pool.submit(cleanup.preview, project, inactive) if stage == "discovery" else pool.submit(
            cleanup.execute, project, plan["plan_id"], inactive)
        try:
            assert entered.wait(5)
            services = _Services(project)
            worker = pool.submit(stable.provision_task, str(project), "Other", TASK, services)
            assert worker.result(timeout=3)[0]
            terminal = pool.submit(stable.provision_live, str(project), "Other", services)
            assert terminal.result(timeout=3)[0]
            checkpoint = pool.submit(store.checkpoint, job, 0, {"completed_steps": ["still responsive"]})
            assert checkpoint.result(timeout=2)["version"] == 1
            command = pool.submit(store.reserve, str(uuid4()), {"cwd": str(project), "status": "reserved"})
            assert command.result(timeout=2)["status"] == "reserved"
            if stage != "discovery":
                assert stable.provision_live(str(project), "Held", services) == (None, None)
                with pytest.raises(JobStorageError, match="reserved this checkout"):
                    store.reserve(str(uuid4()), {"cwd": str(wt), "status": "reserved"})
                with pytest.raises(PreviewError, match="reserved this checkout"):
                    resolve_checkout({"worktree": str(wt)}, str(project))
        finally:
            release.set()
        assert operation.result(timeout=10)["status"] in ("ready", "done")


def test_interrupted_claim_fences_reuse_until_same_plan_recovers(project, monkeypatch):
    from uuid import uuid4
    from orcha_cli.job_store import JobStore, JobStorageError

    wt = _worktree(project, "one", "one", scaffold=False)
    plan = cleanup.preview(project, inactive)
    preserve = cleanup._preserve

    def interrupted(*args):
        raise KeyboardInterrupt("simulated process interruption")

    monkeypatch.setattr(cleanup, "_preserve", interrupted)
    with pytest.raises(KeyboardInterrupt):
        cleanup.execute(project, plan["plan_id"], inactive)
    with pytest.raises(JobStorageError):
        JobStore(project).reserve(str(uuid4()), {"cwd": str(wt), "status": "reserved"})
    assert cleanup.preview(project, inactive)["candidate_count"] == 0
    monkeypatch.setattr(cleanup, "_preserve", preserve)
    assert len(cleanup.execute(project, plan["plan_id"], inactive)["removed"]) == 1


def test_external_detached_and_other_branches_keep_commits_and_private_files(project, tmp_path):
    wt = tmp_path / "external review"
    _git(["worktree", "add", "--detach", str(wt), "main"], project)
    (wt / "committed.txt").write_text("unique commit")
    _git(["add", "."], wt)
    _git(["commit", "-qm", "unique"], wt)
    head = _git(["rev-parse", "HEAD"], wt).stdout.strip()
    (wt / ".env").write_text("private fixture, never an attachment")
    (wt / "README.md").write_text("staged version")
    _git(["add", "README.md"], wt)
    (wt / "README.md").write_text("unstaged version")
    other = _worktree(project, "different", "feature/keep-me", scaffold=False)
    plan = cleanup.preview(project, inactive)
    assert plan["status"] == "ready" and plan["candidate_count"] == 2
    done = cleanup.execute(project, plan["plan_id"], inactive)
    assert len(done["removed"]) == 2, done
    assert not wt.exists() and not other.exists()
    saved = Path(next(r for r in done["items"] if r["path"] == str(wt))["saved_to"])
    assert (saved / "files/.env").read_text() == "private fixture, never an attachment"
    assert (saved / "files/README.md").read_text() == "unstaged version"
    refs = _git(["for-each-ref", "--format=%(objectname)", "refs/orcha/cleanup"], project).stdout
    assert head in refs
    assert _git(["show", "feature/keep-me:README.md"], project).returncode == 0
    index_refs = _git(["for-each-ref", "--format=%(refname)", "refs/orcha/cleanup"], project).stdout.splitlines()
    assert any(_git(["show", ref + ":README.md"], project, check=False).stdout == "staged version"
               for ref in index_refs if ref.endswith("/index"))
    assert cleanup.execute(project, plan["plan_id"], inactive) == done


def test_active_task_between_runs_and_locked_and_hold_retained(project):
    task = _worktree(project, "task-Atlas-1234abcd-567", "renamed", scaffold=False)
    held = _worktree(project, "held", "hold", scaffold=False)
    (held / ".orcha-keep").write_text("release signing configuration")
    locked = _worktree(project, "locked", "locked", scaffold=False)
    _git(["worktree", "lock", str(locked)], project)
    def facts(rows):
        return {"complete": True, "busy": [], "contexts": {str(task): {
            "task_id": "1234abcd-5678-4def-8000-000000000001", "task_status": "in_progress"}}}
    plan = cleanup.preview(project, facts)
    assert plan["candidate_count"] == 0
    assert all(p.exists() for p in [task, held, locked])


@pytest.mark.parametrize("change", ["files", "commit", "busy"])
def test_changed_preview_is_retained(project, change):
    wt = _worktree(project, "candidate", "candidate", scaffold=False)
    plan = cleanup.preview(project, inactive)
    facts = inactive
    if change == "files":
        (wt / ".env").write_text("new configuration")
    elif change == "commit":
        _git(["commit", "--allow-empty", "-qm", "new commit"], wt)
    else:
        facts = lambda rows: {"complete": True, "busy": [str(wt)], "contexts": {}}
    done = cleanup.execute(project, plan["plan_id"], facts)
    assert not done["removed"] and wt.exists()
    assert done["items"][0]["outcome"] == "kept"


def test_unknown_orphan_nested_repository_and_symlink_retained(project, tmp_path):
    root = project / ".orcha-worktrees"
    root.mkdir()
    orphan = root / "not-owned"
    orphan.mkdir()
    nested = _worktree(project, "nested", "nested", scaffold=False)
    _git(["init", "-q", str(nested / "separate")], project)
    external = tmp_path / "foreign"
    external.mkdir()
    (root / "link").symlink_to(external, target_is_directory=True)
    plan = cleanup.preview(project, inactive)
    assert plan["candidate_count"] == 0
    assert orphan.exists() and external.exists() and nested.exists()


def test_previously_observed_orphan_is_preserved_then_removed(project):
    wt = _worktree(project, "orphan", "orphan", scaffold=False)
    cleanup.preview(project, inactive)
    # Simulate lost Git registration without deleting the checkout or its output.
    import shutil
    admin = scan.checked_git(wt, "rev-parse", "--absolute-git-dir")
    shutil.rmtree(admin)
    (wt / "unsaved.txt").write_text("keep this")
    plan = cleanup.preview(project, inactive)
    assert plan["candidate_count"] == 1
    done = cleanup.execute(project, plan["plan_id"], inactive)
    assert len(done["removed"]) == 1, done
    saved = Path(done["removed"][0]["saved_to"])
    assert (saved / "files/unsaved.txt").read_text() == "keep this"


def test_unavailable_activity_fails_closed_and_progress_is_incremental(project):
    _worktree(project, "one", "one", scaffold=False)
    _worktree(project, "two", "two", scaffold=False)
    failed = cleanup.preview(project, lambda rows: None)
    assert failed["status"] == "failed"
    reports = []
    plan = cleanup.preview(project, inactive, progress=lambda p: reports.append(p["scanned"]), measure=lambda p: None)
    assert reports == [0, 1, 2, 2]
    assert plan["unknown_sizes"] == 2


def test_failed_preservation_keeps_checkout(project, monkeypatch):
    wt = _worktree(project, "one", "one", scaffold=False)
    plan = cleanup.preview(project, inactive)
    def fail(*args):
        raise OSError("disk full")
    monkeypatch.setattr(cleanup, "_preserve", fail)
    done = cleanup.execute(project, plan["plan_id"], inactive)
    assert wt.exists() and not done["removed"]


def test_cli_execute_dry_run_never_removes_previewed_checkout(project, capsys):
    from test_worktree_gc import _cli

    wt = _worktree(project, "candidate", "candidate", scaffold=False)
    plan = cleanup.preview(project, inactive)
    code, output = _cli(["worktrees", "execute", plan["plan_id"], "--dry-run",
                         "--project", str(project), "--json"], capsys)
    assert code == 1 and "without removing folders" in output
    assert wt.exists()
    assert cleanup.status(project, plan["plan_id"])["status"] == "ready"


def test_preview_start_reserves_reused_checkout_before_process_starts(project):
    from orcha_cli.notifier_preview import resolve_checkout

    wt = _worktree(project, "candidate", "candidate", scaffold=False)
    resolve_checkout({"worktree": str(wt)}, str(project))
    plan = cleanup.preview(project, inactive)
    assert plan["candidate_count"] == 0 and wt.exists()
    assert "starting" in plan["items"][0]["reason"]


def test_merge_rehearsal_is_protected_between_git_commands(project):
    from orcha_cli.worktree_bringin import _TempWorktree

    with _TempWorktree(str(project), "HEAD") as temporary:
        plan = cleanup.preview(project, inactive)
        assert plan["candidate_count"] == 0
        assert plan["items"][0]["path"] == str(Path(temporary).resolve())
        assert plan["items"][0]["reason"] == "Locked worktree"


def test_changed_content_during_preservation_is_not_removed(project, monkeypatch):
    wt = _worktree(project, "one", "one", scaffold=False)
    plan = cleanup.preview(project, inactive)
    preserve = cleanup._preserve
    def save_then_edit(*args):
        saved = preserve(*args)
        (wt / 'README.md').write_text('new work after copying')
        return saved
    monkeypatch.setattr(cleanup, '_preserve', save_then_edit)
    result = cleanup.execute(project, plan['plan_id'], inactive)
    assert wt.exists() and not result['removed']
    assert (wt / 'README.md').read_text() == 'new work after copying'


def test_recovery_after_removal_does_not_remove_new_work(project, monkeypatch):
    wt = _worktree(project, 'one', 'one', scaffold=False)
    plan = cleanup.preview(project, inactive)
    git = cleanup.gc.git
    def crash_after_remove(args, *pos, **kwargs):
        result = git(args, *pos, **kwargs)
        if args[:2] == ['worktree', 'remove'] and result[0] == 0:
            raise KeyboardInterrupt('simulated crash after deletion')
        return result
    monkeypatch.setattr(cleanup.gc, 'git', crash_after_remove)
    with pytest.raises(KeyboardInterrupt):
        cleanup.execute(project, plan['plan_id'], inactive)
    monkeypatch.setattr(cleanup.gc, 'git', git)
    done = cleanup.execute(project, plan['plan_id'], inactive)
    assert len(done['removed']) == 1
    _git(['worktree', 'add', str(wt), 'one'], project)
    (wt / 'new-work.txt').write_text('created after the completed cleanup')
    assert cleanup.execute(project, plan['plan_id'], inactive) == done
    assert (wt / 'new-work.txt').is_file()


def test_dependency_cache_does_not_hide_private_config_or_foreign_repo(project):
    wt = _worktree(project, 'cache', 'cache', scaffold=False)
    cache = wt / 'node_modules'
    cache.mkdir()
    (cache / '.package-lock.json').write_text('{}')
    (cache / 'generated.js').write_text('dependency')
    (cache / '.env').write_text('private fixture')
    plan = cleanup.preview(project, inactive)
    result = cleanup.execute(project, plan['plan_id'], inactive)
    assert len(result['removed']) == 1, result
    saved = Path(result['removed'][0]['saved_to']) / 'files'
    assert (saved / 'node_modules/.env').read_text() == 'private fixture'
    assert not (saved / 'node_modules/generated.js').exists()
    wt = _worktree(project, 'nested-cache', 'nested-cache', scaffold=False)
    cache = wt / 'node_modules'
    cache.mkdir()
    (cache / '.package-lock.json').write_text('{}')
    _git(['init', '-q', str(cache / 'foreign')], project)
    assert cleanup.preview(project, inactive)['candidate_count'] == 0


def test_two_hundred_stale_worktrees_preview_matches_removal(project):
    for n in range(200):
        _worktree(project, f'old-{n}', f'feature/old-{n}', scaffold=False)
    progress = []
    plan = cleanup.preview(project, inactive, progress=lambda p: progress.append(p['scanned']))
    assert plan['candidate_count'] == 200
    assert progress[0] == 0 and 100 in progress and progress[-1] == 200
    done = cleanup.execute(project, plan['plan_id'], inactive)
    assert {r['path'] for r in done['removed']} == {r['path'] for r in plan['items']}
    assert len(scan.registrations(project)) == 1  # main stays
