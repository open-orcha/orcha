"""Working-tree changes + file history — code_workingtree_routes.py (Orcha Cloud
local run, agentic-era IDE features addendum). Per the test-teeth convention used
across the local-source test modules, NOTHING is stubbed here — every test drives a
REAL temp git repo (mirrors tests/test_local_git_source.py's `local_repo` fixture),
including making real uncommitted changes to it between the commit and the request.
"""
import subprocess

import pytest

from portal_backend import code_space_routes as cs
from portal_backend import code_workingtree_routes as wt
from portal_backend import github_repo_browse_routes as browse
from portal_backend import local_git


@pytest.fixture(autouse=True)
def _clear_caches():
    """Same module-dict caches test_local_git_source.py resets — a working-tree test
    binds the SAME (cid, ref)-shaped cache keys a browse/symbol test would."""
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()
    browse._REPO_SNAPSHOT_CACHE.clear()
    browse._LOCAL_REF_CACHE.clear()
    browse._REPO_SNAPSHOT_ORDER.clear()
    cs._SYMBOL_TREE_CACHE.clear()
    wt._WORKTREE_CACHE.clear()
    yield
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()
    browse._REPO_SNAPSHOT_CACHE.clear()
    browse._LOCAL_REF_CACHE.clear()
    browse._REPO_SNAPSHOT_ORDER.clear()
    cs._SYMBOL_TREE_CACHE.clear()
    wt._WORKTREE_CACHE.clear()


def _git(repo_dir, *args):
    subprocess.run(["git", "-C", str(repo_dir), *args], check=True, capture_output=True)


@pytest.fixture
def local_repo(tmp_path, monkeypatch):
    """A REAL git repo at tmp_path/repo: a root file + a subdir file, committed on
    branch "main". Returns the repo dir; ORCHA_LOCAL_REPO_DIR is monkeypatched for
    the duration of the test. Tests mutate the working tree AFTER this fixture runs
    to exercise the dirty-tree paths."""
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    _git(repo_dir, "init", "-q", "-b", "main")
    _git(repo_dir, "config", "user.email", "test@example.com")
    _git(repo_dir, "config", "user.name", "Test")

    (repo_dir / "README.md").write_text("hello local\n")
    (repo_dir / "src").mkdir()
    (repo_dir / "src" / "main.py").write_text("def foo():\n    pass\n")
    (repo_dir / "to_delete.txt").write_text("bye\n")

    _git(repo_dir, "add", "-A")
    _git(repo_dir, "commit", "-q", "-m", "initial commit")

    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(repo_dir))
    return repo_dir


async def _changes_settled(client, cid):
    """GET worktree/changes until the async first scan lands (scanning:false).

    The route NEVER computes inline on a total cache miss — it kicks a background
    single-flight scan and answers {scanning:true, files:[]} immediately (the big-
    repo Changes-tab fix) — so tests poll briefly for the settled payload."""
    import asyncio
    # Tests mutate the repo directly on disk between calls (no PUT/commit-side
    # invalidation) — drop any cached payload first so every settle observes the
    # CURRENT tree, never a previous step's cache.
    wt._cache_invalidate(cid)
    for _ in range(100):
        r = await client.get(f"/api/containers/{cid}/code/worktree/changes")
        assert r.status_code == 200, r.text
        if not r.json().get("scanning"):
            return r
        await asyncio.sleep(0.1)
    raise AssertionError("changes scan never settled")


async def _bind_local(client, cid):
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "local"})
    assert r.status_code == 200, r.text
    return r


# ================================ local_git unit level ===============================

def test_status_porcelain_clean_tree(local_repo):
    assert local_git.status_porcelain() == []


def test_status_porcelain_modified(local_repo):
    (local_repo / "README.md").write_text("hello local, changed\n")
    entries = local_git.status_porcelain()
    assert {"path": "README.md", "status": "M", "orig_path": None} in entries


def test_status_porcelain_added_staged(local_repo):
    (local_repo / "new_file.py").write_text("x = 1\n")
    _git(local_repo, "add", "new_file.py")
    entries = local_git.status_porcelain()
    assert {"path": "new_file.py", "status": "A", "orig_path": None} in entries


def test_status_porcelain_deleted(local_repo):
    (local_repo / "to_delete.txt").unlink()
    entries = local_git.status_porcelain()
    assert {"path": "to_delete.txt", "status": "D", "orig_path": None} in entries


def test_status_porcelain_untracked(local_repo):
    (local_repo / "untracked.py").write_text("y = 2\n")
    entries = local_git.status_porcelain()
    assert {"path": "untracked.py", "status": "??", "orig_path": None} in entries


def test_status_porcelain_renamed(local_repo):
    _git(local_repo, "mv", "to_delete.txt", "renamed.txt")
    entries = local_git.status_porcelain()
    matches = [e for e in entries if e["status"] == "R"]
    assert len(matches) == 1
    assert matches[0]["path"] == "renamed.txt"
    assert matches[0]["orig_path"] == "to_delete.txt"


def test_status_porcelain_none_when_unavailable(monkeypatch):
    monkeypatch.delenv("ORCHA_LOCAL_REPO_DIR", raising=False)
    assert local_git.status_porcelain() is None


def test_diff_numstat_tracked_modification(local_repo):
    (local_repo / "README.md").write_text("hello local\nplus a line\n")
    entries = local_git.diff_numstat()
    row = next(e for e in entries if e["path"] == "README.md")
    assert row["additions"] == 1
    assert row["deletions"] == 0


def test_diff_numstat_untracked_lists_without_line_counts(local_repo):
    # Untracked rows deliberately carry NO line count (additions None): computing
    # one was a full file read over the bind mount per untracked file — seconds
    # in aggregate for a cosmetic number (the Changes-tab perf fix, 2026-09-01).
    (local_repo / "untracked.py").write_text("a\nb\nc\n")
    entries = local_git.diff_numstat()
    row = next(e for e in entries if e["path"] == "untracked.py")
    assert row["additions"] is None
    assert row["deletions"] == 0


def test_diff_numstat_clean_tree_is_empty(local_repo):
    assert local_git.diff_numstat() == []


def test_diff_unified_whole_tree(local_repo):
    (local_repo / "README.md").write_text("hello local\nplus a line\n")
    diff = local_git.diff_unified()
    assert diff is not None
    assert "README.md" in diff
    assert "+plus a line" in diff


def test_diff_unified_single_file(local_repo):
    (local_repo / "README.md").write_text("hello local\nplus a line\n")
    (local_repo / "src" / "main.py").write_text("def foo():\n    return 1\n")
    diff = local_git.diff_unified("README.md")
    assert "README.md" in diff
    assert "main.py" not in diff


def test_diff_unified_untracked_file_is_whole_file_add(local_repo):
    (local_repo / "untracked.py").write_text("x = 1\n")
    diff = local_git.diff_unified("untracked.py")
    assert diff is not None
    assert "+x = 1" in diff
    assert "/dev/null" in diff


def test_diff_unified_unchanged_file_is_empty_string(local_repo):
    diff = local_git.diff_unified("README.md")
    assert diff == ""


def test_diff_unified_path_traversal_rejected(local_repo):
    assert local_git.diff_unified("../../etc/passwd") is None


def test_log_follow_returns_commit(local_repo):
    commits = local_git.log_follow("README.md")
    assert len(commits) == 1
    assert len(commits[0]["sha"]) == 40
    assert commits[0]["summary"] == "initial commit"
    assert commits[0]["author"] == "Test"


def test_log_follow_follows_renames(local_repo):
    _git(local_repo, "mv", "to_delete.txt", "renamed.txt")
    _git(local_repo, "commit", "-q", "-m", "rename it")
    commits = local_git.log_follow("renamed.txt")
    summaries = [c["summary"] for c in commits]
    assert "rename it" in summaries
    assert "initial commit" in summaries


def test_log_follow_bad_path_no_history(local_repo):
    assert local_git.log_follow("never_existed.txt") == []


def test_log_follow_bad_ref_returns_none(local_repo):
    assert local_git.log_follow("README.md", ref="not-a-real-ref") is None


def test_log_follow_path_traversal_rejected(local_repo):
    assert local_git.log_follow("../../etc/passwd") is None


# =================================== route: worktree/changes =========================

async def test_worktree_changes_clean(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await _changes_settled(client, cid)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert body["dirty"] is False
    assert body["files"] == []
    assert body["summary"] == {"files": 0, "additions": 0, "deletions": 0}


async def test_worktree_changes_mixed_dirty_states(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    (local_repo / "README.md").write_text("hello local\nplus a line\n")
    (local_repo / "to_delete.txt").unlink()
    (local_repo / "brand_new.py").write_text("z = 1\n")
    r = await _changes_settled(client, cid)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert body["dirty"] is True
    by_path = {f["path"]: f for f in body["files"]}
    assert by_path["README.md"]["status"] == "M"
    assert by_path["README.md"]["additions"] == 1
    assert by_path["to_delete.txt"]["status"] == "D"
    assert by_path["brand_new.py"]["status"] == "??"
    # untracked rows list without line counts — see test_diff_numstat_untracked_*
    assert by_path["brand_new.py"]["additions"] is None
    assert body["summary"]["files"] == 3


async def test_worktree_changes_staged_add(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    (local_repo / "staged.py").write_text("a = 1\n")
    _git(local_repo, "add", "staged.py")
    r = await _changes_settled(client, cid)
    body = r.json()
    by_path = {f["path"]: f for f in body["files"]}
    assert by_path["staged.py"]["status"] == "A"


async def test_worktree_changes_github_binding_honest_degrade(client, container):
    cid = container["id"]
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/site"})
    assert r.status_code == 200, r.text
    r = await _changes_settled(client, cid)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "github_source"


async def test_worktree_changes_unbound_container(client, container, local_repo):
    cid = container["id"]
    r = await _changes_settled(client, cid)
    assert r.status_code == 200
    assert r.json()["reason"] == "repo_not_connected"


async def test_worktree_changes_bad_uuid(client):
    r = await client.get("/api/containers/not-a-uuid/code/worktree/changes")
    assert r.status_code == 400


# ==================================== route: worktree/diff ============================

async def test_worktree_diff_modified_file(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    (local_repo / "README.md").write_text("hello local\nplus a line\n")
    r = await client.get(f"/api/containers/{cid}/code/worktree/diff", params={"path": "README.md"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert body["path"] == "README.md"
    assert "+plus a line" in body["diff"]
    assert body["binary"] is False


async def test_worktree_diff_untracked_file(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    (local_repo / "untracked.py").write_text("x = 1\n")
    r = await client.get(f"/api/containers/{cid}/code/worktree/diff", params={"path": "untracked.py"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert "+x = 1" in body["diff"]


async def test_worktree_diff_deleted_file(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    (local_repo / "to_delete.txt").unlink()
    r = await client.get(f"/api/containers/{cid}/code/worktree/diff", params={"path": "to_delete.txt"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert "-bye" in body["diff"]


async def test_worktree_diff_github_binding_honest_degrade(client, container):
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/site"})
    r = await client.get(f"/api/containers/{cid}/code/worktree/diff", params={"path": "README.md"})
    assert r.status_code == 200
    assert r.json()["reason"] == "github_source"


async def test_worktree_diff_missing_path_400(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/code/worktree/diff")
    assert r.status_code == 422  # FastAPI's required-query-param rejection


async def test_worktree_diff_path_traversal_rejected(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(
        f"/api/containers/{cid}/code/worktree/diff", params={"path": "../../../etc/passwd"})
    assert r.status_code == 200
    assert r.json()["reason"] == "not_found"


# =================================== route: file/history ==============================

async def test_file_history_returns_commits(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/code/file/history", params={"path": "README.md"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert len(body["commits"]) == 1
    assert body["commits"][0]["summary"] == "initial commit"


async def test_file_history_follows_renames(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    _git(local_repo, "mv", "to_delete.txt", "renamed.txt")
    _git(local_repo, "commit", "-q", "-m", "rename it")
    r = await client.get(f"/api/containers/{cid}/code/file/history", params={"path": "renamed.txt"})
    assert r.status_code == 200, r.text
    summaries = [c["summary"] for c in r.json()["commits"]]
    assert "rename it" in summaries
    assert "initial commit" in summaries


async def test_file_history_respects_n(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    for i in range(3):
        (local_repo / "README.md").write_text(f"revision {i}\n")
        _git(local_repo, "add", "README.md")
        _git(local_repo, "commit", "-q", "-m", f"revision {i}")
    r = await client.get(
        f"/api/containers/{cid}/code/file/history", params={"path": "README.md", "n": 2})
    assert r.status_code == 200, r.text
    assert len(r.json()["commits"]) == 2


async def test_file_history_github_binding_honest_degrade(client, container):
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/site"})
    r = await client.get(f"/api/containers/{cid}/code/file/history", params={"path": "README.md"})
    assert r.status_code == 200
    assert r.json()["reason"] == "github_source"


async def test_file_history_missing_path_422(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/code/file/history")
    assert r.status_code == 422


async def test_file_history_path_traversal_rejected(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(
        f"/api/containers/{cid}/code/file/history", params={"path": "../../../etc/passwd"})
    assert r.status_code == 200
    assert r.json()["reason"] == "not_found"
