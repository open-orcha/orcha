"""Worktree ownership mirroring — root-daemon boxes must birth writable worktrees.

Field bug (Warden, 2026-08-01): the notifier daemon runs as root on cloud boxes
while sandboxes run as uid 1000, so `git worktree add` created root-owned trees
(and root-owned .git/worktrees/<name> admin dirs) the agent could not write —
hard-blocking every task worktree at birth. `mirror_base_ownership` re-owns a
fresh worktree (and its admin dir) to match the BASE workspace's owner, which
provisioning already sets to the runner uid. It rides at the END of
`overlay_runtime_config`, the shared last step of every creation path
(disposable, resident, live, task), so no lane can miss it.

Each test carries a mutation note: revert the named production line → RED.
"""
import os
import pathlib

from orcha_cli import notifier_worktree_base as wt

_BASE_UID, _BASE_GID = 1000, 1000


def _collect_chowns(monkeypatch):
    calls = []
    def fake_chown(path, uid, gid):
        calls.append((str(path), uid, gid))
    # _chown_tree resolves lchown-else-chown at call time
    monkeypatch.setattr(wt.os, "lchown", fake_chown, raising=False)
    return calls


def _fake_base_stat(monkeypatch):
    real_stat = os.stat
    def fake_stat(path, *a, **k):
        st = list(real_stat(".", *a, **k))
        class S:
            st_uid, st_gid = _BASE_UID, _BASE_GID
        return S()
    monkeypatch.setattr(wt.os, "stat", fake_stat)


def test_noop_when_daemon_is_workspace_owner(tmp_path, monkeypatch):
    """Local self-host: daemon uid == workspace owner → nothing chowned.
    Mutation: drop the `uid == os.geteuid()` early return → RED."""
    calls = _collect_chowns(monkeypatch)
    _fake_base_stat(monkeypatch)
    monkeypatch.setattr(wt.os, "geteuid", lambda: _BASE_UID)
    wt.mirror_base_ownership(tmp_path, tmp_path / "wtree")
    assert calls == []


def test_root_daemon_mirrors_base_owner_onto_worktree(tmp_path, monkeypatch):
    """The incident shape: daemon euid 0, workspace owned by 1000 → every file
    in the worktree is chowned to the base owner. Mutation: drop the
    `_chown_tree(worktree, ...)` call → RED."""
    calls = _collect_chowns(monkeypatch)
    _fake_base_stat(monkeypatch)
    monkeypatch.setattr(wt.os, "geteuid", lambda: 0)
    monkeypatch.setattr(wt, "run_git", lambda *a, **k: (1, ""))  # no admin dir half
    tree = tmp_path / "wtree"
    (tree / "sub").mkdir(parents=True)
    (tree / "sub" / "file.txt").write_text("x")
    wt.mirror_base_ownership(tmp_path, tree)
    chowned = {c[0] for c in calls}
    assert str(tree) in chowned
    assert str(tree / "sub" / "file.txt") in chowned
    assert all((uid, gid) == (_BASE_UID, _BASE_GID) for _, uid, gid in calls)


def test_git_admin_dir_is_mirrored_too(tmp_path, monkeypatch):
    """HEAD/index live under .git/worktrees/<name> in the MAIN repo — a fixed
    worktree with a root-owned admin dir is still broken (second half of the
    incident). Mutation: drop the rev-parse/_chown_tree(admin) half → RED."""
    calls = _collect_chowns(monkeypatch)
    _fake_base_stat(monkeypatch)
    monkeypatch.setattr(wt.os, "geteuid", lambda: 0)
    admin = tmp_path / ".git" / "worktrees" / "task-x"
    admin.mkdir(parents=True)
    (admin / "HEAD").write_text("ref: x")
    monkeypatch.setattr(wt, "run_git", lambda *a, **k: (0, str(admin) + "\n"))
    tree = tmp_path / "wtree"
    tree.mkdir()
    wt.mirror_base_ownership(tmp_path, tree)
    chowned = {c[0] for c in calls}
    assert str(admin) in chowned
    assert str(admin / "HEAD") in chowned


def test_overlay_runs_mirror_as_last_step(tmp_path, monkeypatch):
    """Every creation path ends in overlay_runtime_config → the mirror must ride
    there so no lane (disposable/resident/live/task) can miss it. Mutation:
    remove the mirror_base_ownership call from overlay_runtime_config → RED."""
    seen = {}
    monkeypatch.setattr(wt, "mirror_base_ownership",
                        lambda base, tree: seen.setdefault("called", (base, tree)))
    base = tmp_path / "base"
    (base / ".claude").mkdir(parents=True)
    tree = tmp_path / "wtree"
    tree.mkdir()
    wt.overlay_runtime_config(base, tree)
    assert seen.get("called") == (base, tree)
