"""Agent-worktree housekeeping on the host (orcha_cli/worktree_gc.py + notifier_worktree_gc.py,
cli_worktrees.py) — every test runs against REAL temporary git repositories.

Covered: classification (Embodent scaffolding and byte-identical copies of the main checkout
never count as changes; every state), safe removal (clean, has-output preserved to the task or
.orcha/saved-output first, unmerged never automatic, in-use / not-quorate / unregistered
refused, branches only deleted when merged), the automatic after-run clean-up and the setting
that turns it off, the sweep (first pass over PRE-EXISTING worktrees, the grace period counted
from the later of task end and first sight), the portal requests the daemon runs, the bulk
"clean up existing worktrees" preview-then-run flow, the CLI (--dry-run / clean), and worktree
reuse (per-task worktrees are reattached, per-wake ones never accumulate).
"""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

from orcha_cli import cli_worktrees
from orcha_cli import notifier_worktree_base as wbase
from orcha_cli import notifier_worktree_gc as ngc
from orcha_cli import notifier_worktree_stable as wstable
from orcha_cli import worktree_gc as gc

TASK = "1234abcd-5678-4def-8000-000000000001"


def _git(args, cwd, check=True):
    return subprocess.run(["git", *args], cwd=cwd, check=check, capture_output=True, text=True)


@pytest.fixture
def project(tmp_path):
    """A project checkout with Orcha installed the way `orcha init` leaves it."""
    base = tmp_path / "acme"
    base.mkdir()
    _git(["init", "-q", "-b", "main"], base)
    _git(["config", "user.email", "t@t"], base)
    _git(["config", "user.name", "t"], base)
    (base / "README.md").write_text("hello\n")
    (base / ".gitignore").write_text("node_modules/\n*.tsbuildinfo\n.env\n")
    _git(["add", "."], base)
    _git(["commit", "-qm", "init"], base)
    origin = tmp_path / "origin.git"
    _git(["init", "-q", "--bare", "-b", "main", str(origin)], tmp_path)
    _git(["remote", "add", "origin", str(origin)], base)
    _git(["push", "-q", "origin", "main"], base)
    _git(["fetch", "-q", "origin"], base)
    # untracked Orcha install (what the overlay / a handoff copies into worktrees)
    (base / ".claude" / "orcha-tabs").mkdir(parents=True)
    (base / ".claude" / "orcha.json").write_text('{"api_base_url": "http://127.0.0.1:9"}')
    (base / ".claude" / "settings.json").write_text("{}")
    (base / ".claude" / "orcha-tabs" / "Atlas.json").write_text("{}")
    (base / ".claude" / "commands").mkdir()
    (base / ".claude" / "commands" / "orcha-done.md").write_text("done")
    (base / ".agents" / "skills" / "orcha-done").mkdir(parents=True)
    (base / ".agents" / "skills" / "orcha-done" / "SKILL.md").write_text("skill")
    (base / "prototypes").mkdir()
    (base / "prototypes" / "shared.html").write_text("<p>in main too</p>")
    return base


def _scaffold(base: pathlib.Path, wt: pathlib.Path) -> None:
    """Everything Embodent puts into a worktree: the runtime overlay plus what a handoff out of
    the main checkout carries in (.orcha stack folder, wake logs, codex hooks, preferences)."""
    wbase.overlay_runtime_config(base, wt)
    (wt / ".claude" / ".orcha-wakes").mkdir(parents=True, exist_ok=True)
    (wt / ".claude" / ".orcha-wakes" / "Atlas-1.log").write_text("log")
    (wt / ".claude" / ".orcha-notifier.pid").write_text("1")
    (wt / ".orcha" / "migrations").mkdir(parents=True, exist_ok=True)
    (wt / ".orcha" / "migrations" / "001_init.sql").write_text("--")
    (wt / ".orcha" / "docker-compose.yml").write_text("services: {}")
    (wt / ".codex").mkdir(exist_ok=True)
    (wt / ".codex" / "hooks.json").write_text("{}")
    (wt / "docs").mkdir(exist_ok=True)
    (wt / "docs" / "orcha-project-preferences.md").write_text("prefs")


def _worktree(base: pathlib.Path, name: str, branch: str, *, scaffold=True) -> pathlib.Path:
    wt = base / ".orcha-worktrees" / name
    _git(["worktree", "add", "-q", "-b", branch, str(wt), "main"], base)
    if scaffold:
        _scaffold(base, wt)
    return wt


def _row(base, wt, **kw):
    rows = gc.inventory(str(base), include_process_cwds=False, **kw)
    return next(r for r in rows if gc._real(r["path"]) == gc._real(wt))


def _branches(base):
    return set(_git(["branch", "--format=%(refname:short)"], base).stdout.split())


class Uploads:
    """A stand-in for the deliverables endpoint (records what would be attached)."""

    def __init__(self, ok=True):
        self.ok = ok
        self.calls = []

    def __call__(self, task_id, logical, full, run_id):
        self.calls.append((task_id, logical, pathlib.Path(full).read_bytes(), run_id))
        return self.ok


class FakePortal:
    """Records the notifier's POSTs and answers like agent_worktree_routes."""

    def __init__(self, *, settings=None, busy=(), actions=(), context=None):
        self.settings = settings or {"auto_cleanup": True, "grace_days": 7}
        self.busy = list(busy)
        self.actions = list(actions)
        self.context = context or {}
        self.posts = []

    def __call__(self, url, body, timeout=8.0):
        self.posts.append((url, body))
        if url.endswith("/claim"):
            actions, self.actions = self.actions, []
            return {"settings": self.settings, "busy_worktrees": self.busy, "actions": actions}
        if url.endswith("/context"):
            return {"items": {p: self.context[p] for p in body["paths"] if p in self.context}}
        return {"ok": True}

    def events(self):
        return [b for u, b in self.posts if u.endswith("/events")]

    def results(self):
        return [(u, b) for u, b in self.posts if u.endswith("/result")]


# ------------------------------------------------------------------ classification

def test_scaffolding_allow_list_matches_what_quorate_copies():
    for path in (".claude/orcha.json", ".claude/settings.json", ".claude/orcha-tabs/Atlas.json",
                 ".claude/commands/orcha-done.md", ".claude/.orcha-wakes/Atlas-1.log",
                 ".claude/.orcha-notifier.log", ".claude/.orcha-attachments/deliverables/x/v1.md",
                 ".agents/skills/orcha-done/SKILL.md", ".codex/hooks.json",
                 ".orcha/migrations/001_init.sql", ".orcha/portal/static/styles.css",
                 ".orcha/resident-logs/x.ndjson", "docs/orcha-project-preferences.md"):
        assert gc.is_scaffolding(path), path
    for path in ("prototypes/x.html", "qa-runs/r/1.png", "agent-live-test.md",
                 ".orcha/outputs/report.md", ".orcha/saved-output/x/y.md",
                 ".claude/commands/deploy.md", ".agents/skills/mine/SKILL.md", "docs/plan.md",
                 ".codex/config.toml", "src/app.ts"):
        assert not gc.is_scaffolding(path), path


def test_scaffolding_only_worktree_is_clean(project):
    wt = _worktree(project, "Atlas-1", "orcha/wk-Atlas-1790000000001")
    # also a byte-identical copy of a main-checkout file, an ignored build file and node_modules
    (wt / "prototypes").mkdir()
    (wt / "prototypes" / "shared.html").write_text("<p>in main too</p>")
    (wt / "app.tsbuildinfo").write_text("{}")
    (wt / "node_modules" / "left-pad").mkdir(parents=True)
    (wt / "node_modules" / "left-pad" / "index.js").write_text("x")
    # git itself calls it dirty
    assert _git(["status", "--porcelain"], wt).stdout.strip()
    row = _row(project, wt)
    assert row["state"] == gc.STATE_CLEAN, row
    assert row["kind"] == "wake" and row["agent"] == "Atlas"
    assert row["scaffolding_files"] >= 8 and row["copied_files"] == 1 and row["ignored_files"] == 1
    assert row["output"] == [] and row["size_bytes"] > 0 and row["age_seconds"] is not None


def test_every_state(project):
    clean = _worktree(project, "Vault-1", "orcha/wk-Vault-1790000000002")
    out = _worktree(project, f"task-Atlas-{TASK[:12]}", f"orcha/task-Atlas-{TASK[:12]}")
    (out / "qa-runs").mkdir()
    (out / "qa-runs" / "report.md").write_text("# findings")
    (out / ".orcha" / "outputs").mkdir(parents=True)
    (out / ".orcha" / "outputs" / ".gitignore").write_text("*\n")
    (out / ".orcha" / "outputs" / "audit.md").write_text("audit")
    mod = _worktree(project, "Probe-1", "orcha/wk-Probe-1790000000003")
    (mod / "README.md").write_text("changed\n")
    ahead = _worktree(project, "Ferry-1", "orcha/wk-Ferry-1790000000004")
    (ahead / "feature.txt").write_text("x")
    _git(["add", "feature.txt"], ahead)
    _git(["commit", "-qm", "feature"], ahead)
    busy = _worktree(project, "live-Atlas", "orcha/live-Atlas")
    stranger = project / ".orcha-worktrees" / "human-branch"
    _git(["worktree", "add", "-q", "-b", "feat/truck-card-profit", str(stranger), "main"], project)
    (project / ".orcha-worktrees" / "stray-folder").mkdir()

    rows = {r["name"]: r for r in gc.inventory(str(project), busy={str(busy)},
                                               include_process_cwds=False)}
    assert rows["Vault-1"]["state"] == gc.STATE_CLEAN
    o = rows[f"task-Atlas-{TASK[:12]}"]
    assert o["state"] == gc.STATE_HAS_OUTPUT and o["kind"] == "task" and o["task_ref"] == TASK[:12]
    assert sorted(o["output"]) == [".orcha/outputs/audit.md", "qa-runs/report.md"]
    assert rows["Probe-1"]["state"] == gc.STATE_HAS_OUTPUT and rows["Probe-1"]["modified"] == ["README.md"]
    assert rows["Ferry-1"]["state"] == gc.STATE_UNMERGED and rows["Ferry-1"]["unmerged_commits"] == 1
    assert rows["live-Atlas"]["state"] == gc.STATE_IN_USE and rows["live-Atlas"]["kind"] == "live"
    assert rows["human-branch"]["state"] == gc.STATE_NOT_QUORATE
    assert rows["stray-folder"]["state"] == gc.STATE_NOT_QUORATE
    assert "not registered" in rows["stray-folder"]["reason"]
    assert gc.reclaimable_bytes(rows.values()) == sum(
        rows[n]["size_bytes"] for n in ("Vault-1", f"task-Atlas-{TASK[:12]}", "Probe-1"))


def test_worktree_outside_orcha_worktrees_is_never_listed_or_removed(project, tmp_path):
    outside = tmp_path / "elsewhere"
    _git(["worktree", "add", "-q", "-b", "orcha/wk-Atlas-1790000000009", str(outside), "main"], project)
    assert all(gc._real(r["path"]) != gc._real(outside)
               for r in gc.inventory(str(project), include_process_cwds=False))
    res = gc.remove_worktree(str(project), str(outside), include_process_cwds=False)
    assert res["outcome"] == "refused" and outside.exists()


def test_a_running_process_inside_the_worktree_makes_it_in_use(project):
    wt = _worktree(project, "Atlas-2", "orcha/wk-Atlas-1790000000010")
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], cwd=wt)
    try:
        for _ in range(20):
            if any(c.startswith(str(gc._real(wt))) for c in gc.process_cwds()):
                break
            time.sleep(0.1)
        rows = gc.inventory(str(project))
        assert next(r for r in rows if r["name"] == "Atlas-2")["state"] == gc.STATE_IN_USE
        res = gc.remove_worktree(str(project), str(wt))
        assert res["outcome"] == "refused" and wt.exists()
    finally:
        proc.kill()
        proc.wait()


# ------------------------------------------------------------------ removal

def test_clean_worktree_is_removed_and_its_branch_deleted(project):
    wt = _worktree(project, "Atlas-3", "orcha/wk-Atlas-1790000000011")
    res = gc.remove_worktree(str(project), str(wt), include_process_cwds=False)
    assert res["outcome"] == "removed", res
    assert not wt.exists() and res["branch_deleted"] and res["freed_bytes"] > 0
    assert "orcha/wk-Atlas-1790000000011" not in _branches(project)
    # main checkout untouched
    assert (project / ".claude" / "orcha.json").exists() and (project / "README.md").exists()


def test_has_output_is_attached_to_the_task_or_saved_before_removal(project):
    wt = _worktree(project, f"task-Atlas-{TASK[:12]}", f"orcha/task-Atlas-{TASK[:12]}")
    (wt / "qa-runs").mkdir()
    (wt / "qa-runs" / "report.md").write_text("# findings")
    (wt / "qa-runs" / "trace.zip").write_bytes(b"PK\x03\x04zip")       # not a deliverable type
    (wt / "README.md").write_text("changed by the agent\n")
    uploads = Uploads()
    # the automatic path refuses output while it is in its grace period…
    res = gc.remove_worktree(str(project), str(wt), allow_output=False, include_process_cwds=False)
    assert res["outcome"] == "refused" and wt.exists()
    # …a removal saves it first
    res = gc.remove_worktree(str(project), str(wt), task_id=TASK, upload=uploads,
                             include_process_cwds=False)
    assert res["outcome"] == "removed", res
    attached = {c[1]: c[2] for c in uploads.calls}
    assert attached == {"qa-runs/report.md": b"# findings", "README.md": b"changed by the agent\n"}
    saved = gc.saved_output_dir(project, f"orcha/task-Atlas-{TASK[:12]}")
    assert (saved / "qa-runs" / "trace.zip").read_bytes() == b"PK\x03\x04zip"
    assert res["preserved"]["saved_to"] == str(saved)
    assert (project / ".orcha" / "saved-output" / ".gitignore").read_text() == "*\n"


def test_without_a_task_output_goes_to_saved_output(project):
    wt = _worktree(project, "resident-c0ffee", "orcha/resident-c0ffee")
    (wt / "agent-live-test.md").write_text("live notes")
    res = gc.remove_worktree(str(project), str(wt), include_process_cwds=False)
    assert res["outcome"] == "removed", res
    assert (gc.saved_output_dir(project, "orcha/resident-c0ffee") / "agent-live-test.md").read_text() == "live notes"


def test_failed_upload_falls_back_to_a_local_copy(project):
    wt = _worktree(project, "Atlas-4", "orcha/wk-Atlas-1790000000012")
    (wt / "notes.md").write_text("n")
    res = gc.remove_worktree(str(project), str(wt), task_id=TASK, upload=Uploads(ok=False),
                             include_process_cwds=False)
    assert res["outcome"] == "removed"
    assert (gc.saved_output_dir(project, "orcha/wk-Atlas-1790000000012") / "notes.md").read_text() == "n"


def test_unmerged_is_never_removed_without_a_human_confirm(project):
    wt = _worktree(project, "Ferry-2", "orcha/wk-Ferry-1790000000013")
    (wt / "f.txt").write_text("x")
    _git(["add", "f.txt"], wt)
    _git(["commit", "-qm", "work"], wt)
    res = gc.remove_worktree(str(project), str(wt), include_process_cwds=False)
    assert res["outcome"] == "refused" and "never removed automatically" in res["reason"]
    assert wt.exists()
    # a human confirmed + keep branch → the worktree goes, the commits stay
    res = gc.remove_worktree(str(project), str(wt), allow_unmerged=True, keep_branch=True,
                             include_process_cwds=False)
    assert res["outcome"] == "removed" and not wt.exists()
    assert "orcha/wk-Ferry-1790000000013" in _branches(project)


def test_merged_commits_do_not_block_and_the_branch_goes(project):
    wt = _worktree(project, "Ferry-3", "orcha/wk-Ferry-1790000000014")
    (wt / "g.txt").write_text("x")
    _git(["add", "g.txt"], wt)
    _git(["commit", "-qm", "work"], wt)
    _git(["merge", "-q", "--ff-only", "orcha/wk-Ferry-1790000000014"], project)
    assert _row(project, wt)["state"] == gc.STATE_CLEAN
    res = gc.remove_worktree(str(project), str(wt), include_process_cwds=False)
    assert res["outcome"] == "removed" and res["branch_deleted"]


def test_non_orcha_branch_and_unregistered_folder_are_never_touched(project):
    stranger = project / ".orcha-worktrees" / "truck"
    _git(["worktree", "add", "-q", "-b", "feat/truck-card-profit", str(stranger), "main"], project)
    stray = project / ".orcha-worktrees" / "stray"
    stray.mkdir()
    (stray / "keep.txt").write_text("k")
    assert gc.remove_worktree(str(project), str(stranger), include_process_cwds=False)["outcome"] == "refused"
    assert gc.remove_worktree(str(project), str(stray), include_process_cwds=False)["outcome"] == "refused"
    assert stranger.exists() and (stray / "keep.txt").exists()
    assert "feat/truck-card-profit" in _branches(project)


# ------------------------------------------------------------------ the daemon: after a run

@pytest.fixture
def gc_state(monkeypatch):
    state = ngc.GcState()
    monkeypatch.setattr(ngc, "STATE", state)
    return state


def _worker(project, wt, branch, *, task_id=None):
    return {"worktree": str(wt), "branch": branch, "base_cwd": str(project), "run_id": "r1",
            "respawn_ctx": {"task_id": task_id}, "proc": SimpleNamespace(poll=lambda: 0)}


def test_after_run_removes_a_clean_wake_worktree_and_logs_it(project, gc_state):
    gc_state.settings = {"auto_cleanup": True, "grace_days": 7}
    gc_state.cid = "c1"
    wt = _worktree(project, "Atlas-5", "orcha/wk-Atlas-1790000000015")
    gc_state.remote_busy = {str(wt)}  # stale: fetched while this very run was running
    portal = FakePortal()
    res = ngc.after_run("http://portal", _worker(project, wt, "orcha/wk-Atlas-1790000000015"),
                        {}, post=portal)
    assert res["outcome"] == "removed" and not wt.exists()
    ev = portal.events()
    assert ev and ev[0]["kind"] == "removed" and ev[0]["trigger"] == "after_run"
    assert ev[0]["branch"] == "orcha/wk-Atlas-1790000000015" and ev[0]["freed_bytes"] > 0


def test_after_run_attaches_output_and_keeps_the_worktree(project, gc_state):
    gc_state.settings = {"auto_cleanup": True, "grace_days": 7}
    branch = f"orcha/task-Atlas-{TASK[:12]}"
    wt = _worktree(project, f"task-Atlas-{TASK[:12]}", branch)
    (wt / "prototypes").mkdir(exist_ok=True)
    (wt / "prototypes" / "new.md").write_text("design")
    uploads = Uploads()
    res = ngc.after_run("http://portal", _worker(project, wt, branch, task_id=TASK), {},
                        post=FakePortal(), upload=uploads)
    assert res["outcome"] == "preserved" and wt.exists()
    assert [(c[0], c[1], c[3]) for c in uploads.calls] == [(TASK, "prototypes/new.md", "r1")]
    # a second run end re-sends nothing that is unchanged
    ngc.after_run("http://portal", _worker(project, wt, branch, task_id=TASK), {},
                  post=FakePortal(), upload=uploads)
    assert len(uploads.calls) == 1


def test_after_run_keeps_a_clean_task_worktree_while_the_task_is_open(project, gc_state):
    gc_state.settings = {"auto_cleanup": True, "grace_days": 7}
    branch = f"orcha/task-Atlas-{TASK[:12]}"
    wt = _worktree(project, f"task-Atlas-{TASK[:12]}", branch)
    open_task = lambda url, timeout=8.0: {"id": TASK, "status": "in_progress"}  # noqa: E731
    assert ngc.after_run("http://p", _worker(project, wt, branch, task_id=TASK), {},
                         post=FakePortal(), get=open_task) is None
    assert wt.exists()
    done_task = lambda url, timeout=8.0: {"id": TASK, "status": "completed"}  # noqa: E731
    res = ngc.after_run("http://p", _worker(project, wt, branch, task_id=TASK), {},
                        post=FakePortal(), get=done_task)
    assert res["outcome"] == "removed" and not wt.exists()


def test_auto_cleanup_off_changes_nothing(project, gc_state):
    gc_state.settings = {"auto_cleanup": False, "grace_days": 7}
    wt = _worktree(project, "Atlas-6", "orcha/wk-Atlas-1790000000016")
    assert ngc.after_run("http://p", _worker(project, wt, "orcha/wk-Atlas-1790000000016"), {},
                         post=FakePortal()) is None
    portal = FakePortal(settings={"auto_cleanup": False, "grace_days": 7})
    t = [1000.0]
    gc_state.started = 0.0
    ngc.service_worktrees("http://p", "c1", gc_state, str(project), post=portal, clock=lambda: t[0])
    assert wt.exists() and not portal.events()
    # the inventory is still reported so Settings can show it
    assert any(u.endswith("/inventory") for u, _ in portal.posts)


def test_reaper_completion_calls_the_after_run_hook(monkeypatch):
    from orcha_cli import notifier_reaper_completion as rc

    seen = []
    monkeypatch.setattr(rc.notifier_worktree_gc, "after_run",
                        lambda api, worker, live, quiet=True: seen.append(worker))
    assert "notifier_worktree_gc.after_run" in pathlib.Path(rc.__file__).read_text()
    assert callable(rc.notifier_worktree_gc.after_run)


# ------------------------------------------------------------------ the sweep (incl. pre-existing)

def test_first_sweep_handles_pre_existing_worktrees(project, gc_state):
    """Worktrees made before the upgrade: the clean ones go on the first pass, output is saved
    right away, and the grace period starts NOW — nothing with output vanishes on upgrade."""
    old = time.time() - 30 * 86400
    clean = _worktree(project, "Vault-2", "orcha/wk-Vault-1790000000017")
    done_task_wt = _worktree(project, f"task-Atlas-{TASK[:12]}", f"orcha/task-Atlas-{TASK[:12]}")
    (done_task_wt / "qa-runs").mkdir()
    (done_task_wt / "qa-runs" / "r.md").write_text("result")
    no_task = _worktree(project, "resident-abc", "orcha/resident-abc")
    (no_task / "agent-live-test.md").write_text("notes")
    ahead = _worktree(project, "Ferry-4", "orcha/wk-Ferry-1790000000018")
    (ahead / "h.txt").write_text("x")
    _git(["add", "h.txt"], ahead)
    _git(["commit", "-qm", "w"], ahead)
    for wt in (clean, done_task_wt, no_task, ahead):
        for dirpath, dirs, files in os.walk(wt):
            for n in dirs + files:
                os.utime(os.path.join(dirpath, n), (old, old), follow_symlinks=False)
        os.utime(wt, (old, old))
    portal = FakePortal(context={str(done_task_wt): {
        "task_id": TASK, "task_status": "completed",
        "task_ended_at": "2026-08-01T00:00:00+00:00", "run_id": "r9", "run_task_id": TASK}})
    uploads = Uploads(ok=False)  # the task is completed → its deliverables are frozen
    gc_state.settings = {"auto_cleanup": True, "grace_days": 7}
    now = time.time()
    summary = ngc.sweep("http://p", "c1", str(project), gc_state, set(), post=portal,
                        upload=uploads, now=now)
    assert not clean.exists()
    assert done_task_wt.exists() and no_task.exists() and ahead.exists()
    assert (gc.saved_output_dir(project, f"orcha/task-Atlas-{TASK[:12]}") / "qa-runs" / "r.md").read_text() == "result"
    assert (gc.saved_output_dir(project, "orcha/resident-abc") / "agent-live-test.md").read_text() == "notes"
    assert summary["removed"] == [str(clean)]
    # 6 days later: still inside the grace period that started at first sight
    ngc.sweep("http://p", "c1", str(project), gc_state, set(), post=portal, upload=uploads,
              now=now + 6 * 86400)
    assert done_task_wt.exists() and no_task.exists()
    # 8 days later: past it → removed (output was saved first); unmerged never
    ngc.sweep("http://p", "c1", str(project), gc_state, set(), post=portal, upload=uploads,
              now=now + 8 * 86400)
    assert not done_task_wt.exists() and not no_task.exists()
    assert ahead.exists()
    removed = {e["path"] for e in portal.events() if e["kind"] == "removed"}
    assert removed == {str(clean), str(done_task_wt), str(no_task)}


def test_grace_counts_from_task_end_when_that_is_later(project, gc_state):
    wt = _worktree(project, f"task-Atlas-{TASK[:12]}", f"orcha/task-Atlas-{TASK[:12]}")
    (wt / "out.md").write_text("o")
    now = time.time()
    gc.first_seen(project, [{"path": str(wt)}], now=now - 20 * 86400)
    ended = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(now - 2 * 86400))
    portal = FakePortal(context={str(wt): {"task_id": TASK, "task_status": "cancelled",
                                           "task_ended_at": ended}})
    gc_state.settings = {"auto_cleanup": True, "grace_days": 7}
    ngc.sweep("http://p", "c1", str(project), gc_state, set(), post=portal, upload=Uploads(), now=now)
    assert wt.exists()
    ngc.sweep("http://p", "c1", str(project), gc_state, set(), post=portal, upload=Uploads(),
              now=now + 6 * 86400)
    assert not wt.exists()


def test_open_task_worktree_with_output_is_never_removed_by_the_sweep(project, gc_state):
    wt = _worktree(project, f"task-Atlas-{TASK[:12]}", f"orcha/task-Atlas-{TASK[:12]}")
    (wt / "out.md").write_text("o")
    gc.first_seen(project, [{"path": str(wt)}], now=time.time() - 60 * 86400)
    portal = FakePortal(context={str(wt): {"task_id": TASK, "task_status": "in_progress"}})
    gc_state.settings = {"auto_cleanup": True, "grace_days": 0}
    uploads = Uploads()
    ngc.sweep("http://p", "c1", str(project), gc_state, set(), post=portal, upload=uploads)
    assert wt.exists() and [c[1] for c in uploads.calls] == ["out.md"]


def test_service_loop_first_pass_then_hourly(project, gc_state):
    wt = _worktree(project, "Atlas-7", "orcha/wk-Atlas-1790000000019")
    portal = FakePortal()
    t = [0.0]
    gc_state.started = 0.0
    ngc.service_worktrees("http://p", "c1", gc_state, str(project), post=portal, clock=lambda: t[0])
    assert wt.exists()  # first pass waits a few seconds after start
    t[0] = ngc.FIRST_SWEEP_DELAY_S + 1
    gc_state.last_claim = -100
    ngc.service_worktrees("http://p", "c1", gc_state, str(project), post=portal, clock=lambda: t[0])
    assert not wt.exists()
    inv = [b for u, b in portal.posts if u.endswith("/inventory")]
    assert inv and inv[-1]["items"] == []
    wt2 = _worktree(project, "Atlas-8", "orcha/wk-Atlas-1790000000020")
    t[0] += 60
    ngc.service_worktrees("http://p", "c1", gc_state, str(project), post=portal, clock=lambda: t[0])
    assert wt2.exists()  # not due yet
    t[0] += ngc.SWEEP_EVERY_S
    ngc.service_worktrees("http://p", "c1", gc_state, str(project), post=portal, clock=lambda: t[0])
    assert not wt2.exists()


def test_busy_worktree_from_the_portal_or_a_live_worker_is_skipped(project, gc_state):
    a = _worktree(project, "Atlas-9", "orcha/wk-Atlas-1790000000021")
    b = _worktree(project, "Probe-9", "orcha/wk-Probe-1790000000022")
    portal = FakePortal(busy=[str(a)])
    t = [ngc.FIRST_SWEEP_DELAY_S + 1]
    gc_state.started = 0.0
    ngc.service_worktrees("http://p", "c1", gc_state, str(project), post=portal, clock=lambda: t[0],
                          live_workers={"x": {"worktree": str(b)}})
    assert a.exists() and b.exists()


# ------------------------------------------------------------------ portal requests

def test_requests_from_settings_are_run_and_reported(project, gc_state):
    clean = _worktree(project, "Atlas-10", "orcha/wk-Atlas-1790000000023")
    out = _worktree(project, "Probe-10", "orcha/wk-Probe-1790000000024")
    (out / "notes.md").write_text("n")
    ahead = _worktree(project, "Ferry-10", "orcha/wk-Ferry-1790000000025")
    (ahead / "k.txt").write_text("x")
    _git(["add", "k.txt"], ahead)
    _git(["commit", "-qm", "w"], ahead)
    portal = FakePortal(settings={"auto_cleanup": False, "grace_days": 7}, actions=[
        {"id": "a1", "action": "save_output", "path": str(out)},
        {"id": "a2", "action": "remove", "path": str(ahead), "confirm_unmerged": True,
         "keep_branch": True},
        {"id": "a3", "action": "remove", "path": str(clean)},
    ])
    gc_state.started = 0.0
    ngc.service_worktrees("http://p", "c1", gc_state, str(project), post=portal, clock=lambda: 100.0)
    results = {u.split("/")[-2]: b for u, b in portal.results()}
    assert results["a1"]["status"] == "done" and results["a1"]["result"]["saved"] == ["notes.md"]
    assert out.exists()
    assert results["a2"]["status"] == "done" and not ahead.exists()
    assert "orcha/wk-Ferry-1790000000025" in _branches(project)
    assert results["a3"]["status"] == "done" and not clean.exists()


def test_bulk_clean_up_previews_then_runs(project, gc_state):
    clean = _worktree(project, "Atlas-11", "orcha/wk-Atlas-1790000000026")
    out = _worktree(project, "Probe-11", "orcha/wk-Probe-1790000000027")
    (out / "notes.md").write_text("n")
    keep = _worktree(project, "Ferry-11", "orcha/wk-Ferry-1790000000028")
    opt_in = _worktree(project, "Ferry-12", "orcha/wk-Ferry-1790000000029")
    for wt in (keep, opt_in):
        (wt / "c.txt").write_text(wt.name)
        _git(["add", "c.txt"], wt)
        _git(["commit", "-qm", "w"], wt)
    busy = _worktree(project, "live-Atlas", "orcha/live-Atlas")
    rows = gc.inventory(str(project), busy={str(busy)}, include_process_cwds=False)
    preview = ngc.bulk_clean(str(project), rows, {}, {str(busy)},
                             unmerged_paths=[str(opt_in)], dry_run=True)
    assert {e["name"] for e in preview["removed"]} == {"Atlas-11", "Probe-11", "Ferry-12"}
    assert next(e for e in preview["removed"] if e["name"] == "Probe-11")["saves"] == ["notes.md"]
    assert next(e for e in preview["removed"] if e["name"] == "Ferry-12")["keep_branch"] is True
    assert [e["name"] for e in preview["kept"]] == ["Ferry-11"]
    assert [e["name"] for e in preview["skipped"]] == ["live-Atlas"]
    assert all(wt.exists() for wt in (clean, out, keep, opt_in, busy))  # the preview changed nothing

    portal = FakePortal(actions=[{"id": "b1", "action": "clean_up", "include_output": True,
                                  "unmerged_paths": [str(opt_in)]}],
                        busy=[str(busy)], settings={"auto_cleanup": False, "grace_days": 7})
    gc_state.started = 0.0
    ngc.service_worktrees("http://p", "c1", gc_state, str(project), post=portal, clock=lambda: 100.0)
    result = portal.results()[0][1]
    assert result["status"] == "done"
    assert {e["name"] for e in result["result"]["removed"]} == {"Atlas-11", "Probe-11", "Ferry-12"}
    assert result["result"]["freed_bytes"] > 0
    assert not clean.exists() and not out.exists() and not opt_in.exists()
    assert keep.exists() and busy.exists()
    assert "orcha/wk-Ferry-1790000000029" in _branches(project)  # branch kept
    assert (gc.saved_output_dir(project, "orcha/wk-Probe-1790000000027") / "notes.md").exists()
    assert len([e for e in portal.events() if e["kind"] == "removed"]) == 3


# ------------------------------------------------------------------ CLI

def _cli(argv, capsys):
    from orcha_cli.__main__ import build_parser

    args = build_parser().parse_args(argv)
    try:
        args.func(args)
        code = 0
    except SystemExit as exc:
        code = exc.code
    return code, capsys.readouterr().out


def test_cli_dry_run_then_clean(project, capsys):
    clean = _worktree(project, "Atlas-12", "orcha/wk-Atlas-1790000000030")
    out = _worktree(project, "Probe-12", "orcha/wk-Probe-1790000000031")
    (out / "notes.md").write_text("n")
    ahead = _worktree(project, "Ferry-13", "orcha/wk-Ferry-1790000000032")
    (ahead / "c.txt").write_text("x")
    _git(["add", "c.txt"], ahead)
    _git(["commit", "-qm", "w"], ahead)

    code, text = _cli(["worktrees", "list", "--json", "--offline", "--project", str(project)], capsys)
    listing = json.loads(text)
    assert code == 0 and {i["name"]: i["state"] for i in listing["items"]} == {
        "Atlas-12": "clean", "Probe-12": "has-output", "Ferry-13": "unmerged"}

    code, text = _cli(["worktrees", "clean", "--dry-run", "--offline", "--project", str(project)], capsys)
    assert code == 0 and "Would remove 2 worktree(s)" in text and "saves · notes.md" in text
    assert "dry run" in text and clean.exists() and out.exists()

    code, text = _cli(["worktrees", "clean", "--json", "--offline", "--project", str(project)], capsys)
    res = json.loads(text)
    assert {e["name"] for e in res["removed"]} == {"Atlas-12", "Probe-12"}
    assert not clean.exists() and not out.exists() and ahead.exists()

    code, text = _cli(["worktrees", "remove", str(ahead), "--offline", "--project", str(project)], capsys)
    assert code == 1 and "--confirm-unmerged" in text and ahead.exists()
    code, text = _cli(["worktrees", "remove", str(ahead), "--offline", "--keep-branch",
                       "--confirm-unmerged", "orcha/wk-Ferry-1790000000032", "--project", str(project)], capsys)
    assert code == 0 and not ahead.exists()
    assert "orcha/wk-Ferry-1790000000032" in _branches(project)


# ------------------------------------------------------------------ reuse

class _Services:
    _run_git = staticmethod(wbase.run_git)
    _safe_ref = staticmethod(wbase.safe_ref)
    _overlay_runtime_config = staticmethod(wbase.overlay_runtime_config)

    def __init__(self, base):
        self.base = base

    def _ensure_worktree_exclude(self, base_cwd):
        wbase.ensure_exclude(base_cwd, self)


def test_per_task_worktree_is_reused_not_multiplied(project):
    """Per-task isolation IS the reuse: the same agent+task reattaches one worktree."""
    services = _Services(project)
    first, branch = wstable.provision_task(str(project), "Atlas", TASK, services)
    again, branch2 = wstable.provision_task(str(project), "Atlas", TASK, services)
    assert first == again and branch == branch2
    assert len([r for r in gc.inventory(str(project), include_process_cwds=False)]) == 1


def test_per_wake_worktrees_do_not_accumulate(project, gc_state):
    """Per-wake worktrees are created fresh (handoff ownership is keyed by checkout path), but
    with the scaffolding fix each clean one is removed when its run ends — so a stream of wakes
    leaves none behind instead of one per wake."""
    gc_state.settings = {"auto_cleanup": True, "grace_days": 7}
    services = _Services(project)
    for _ in range(3):
        wt, branch = wbase.provision_disposable(str(project), "Atlas", services)
        assert wt and branch.startswith("orcha/wk-Atlas-")
        _scaffold(project, pathlib.Path(wt))
        ngc.after_run("http://p", _worker(project, wt, branch), {}, post=FakePortal())
        time.sleep(0.002)
    assert gc.inventory(str(project), include_process_cwds=False) == []
