"""Code Space editing Phase 1+2 (local-binding write path + commit/push) —
code_workingtree_routes.py's file/commit/push/branch routes. Per the test-teeth
convention used across the local-source test modules, NOTHING is stubbed here —
every test drives a REAL temp git repo (mirrors tests/test_code_workingtree.py's
`local_repo` fixture), including a real bare "origin" for the push tests.
"""
import subprocess

import pytest

from portal_backend import code_space_routes as cs
from portal_backend import github_repo_browse_routes as browse
from portal_backend import local_git


@pytest.fixture(autouse=True)
def _clear_caches():
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()
    browse._REPO_SNAPSHOT_CACHE.clear()
    browse._REPO_SNAPSHOT_ORDER.clear()
    cs._SYMBOL_TREE_CACHE.clear()
    yield
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()
    browse._REPO_SNAPSHOT_CACHE.clear()
    browse._REPO_SNAPSHOT_ORDER.clear()
    cs._SYMBOL_TREE_CACHE.clear()


def _git(repo_dir, *args):
    subprocess.run(["git", "-C", str(repo_dir), *args], check=True, capture_output=True)


@pytest.fixture
def local_repo(tmp_path, monkeypatch):
    """A REAL git repo at tmp_path/repo: a root file + a subdir file, committed on
    branch "main". Returns the repo dir; ORCHA_LOCAL_REPO_DIR is monkeypatched for
    the duration of the test."""
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    _git(repo_dir, "init", "-q", "-b", "main")
    _git(repo_dir, "config", "user.email", "test@example.com")
    _git(repo_dir, "config", "user.name", "Test")

    (repo_dir / "README.md").write_text("hello local\n")
    (repo_dir / "src").mkdir()
    (repo_dir / "src" / "main.py").write_text("def foo():\n    pass\n")

    _git(repo_dir, "add", "-A")
    _git(repo_dir, "commit", "-q", "-m", "initial commit")

    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(repo_dir))
    return repo_dir


async def _bind_local(client, cid):
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "local"})
    assert r.status_code == 200, r.text
    return r


# =============================== local_git unit level ==================================

def test_worktree_file_hash_matches_sha256(local_repo):
    import hashlib
    expected = hashlib.sha256(b"hello local\n").hexdigest()
    assert local_git.worktree_file_hash("README.md") == expected


def test_worktree_file_hash_missing_file_is_none(local_repo):
    assert local_git.worktree_file_hash("nope.txt") is None


def test_write_worktree_file_creates_new_file(local_repo):
    assert local_git.write_worktree_file("brand_new.py", b"x = 1\n") is True
    assert (local_repo / "brand_new.py").read_bytes() == b"x = 1\n"


def test_write_worktree_file_creates_parent_dirs(local_repo):
    assert local_git.write_worktree_file("a/b/c.py", b"nested\n") is True
    assert (local_repo / "a" / "b" / "c.py").read_bytes() == b"nested\n"


def test_write_worktree_file_rejects_traversal(local_repo):
    assert local_git.write_worktree_file("../../etc/passwd", b"x") is False


def test_write_worktree_file_rejects_git_internal_path(local_repo):
    assert local_git.write_worktree_file(".git/config", b"x") is False


def test_stage_and_commit_returns_sha(local_repo):
    local_git.write_worktree_file("new.py", b"a = 1\n")
    result = local_git.stage_and_commit(["new.py"], "add new.py")
    assert result is not None
    assert len(result["sha"]) == 40
    assert result["short"] == result["sha"][:7]


def test_stage_and_commit_nothing_staged_is_none(local_repo):
    assert local_git.stage_and_commit(["README.md"], "no-op") is None


def test_stage_and_commit_with_author_override(local_repo):
    local_git.write_worktree_file("author_test.py", b"z = 1\n")
    result = local_git.stage_and_commit(
        ["author_test.py"], "attributed commit",
        author_name="Portal Editor", author_email="editor@example.com")
    assert result is not None
    out = subprocess.run(
        ["git", "-C", str(local_repo), "log", "-1", "--format=%an <%ae>"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert out == "Portal Editor <editor@example.com>"


def test_branch_info_no_upstream(local_repo):
    info = local_git.branch_info()
    assert info is not None
    assert info["branch"] == "main"
    assert len(info["sha"]) == 7
    assert info["ahead"] is None
    assert info["behind"] is None
    assert info["remote"] is None


def test_push_current_branch_no_remote_fails_gracefully(local_repo):
    result = local_git.push_current_branch()
    assert result["ok"] is False
    assert result["detail"]


def test_push_current_branch_succeeds(tmp_path, local_repo):
    bare = tmp_path / "origin.git"
    bare.mkdir()
    _git(bare, "init", "-q", "--bare")
    _git(local_repo, "remote", "add", "origin", str(bare))
    result = local_git.push_current_branch()
    assert result["ok"] is True
    assert result["detail"] == ""
    # the bare repo's HEAD advanced to our commit
    local_sha = subprocess.run(
        ["git", "-C", str(local_repo), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=True).stdout.strip()
    bare_sha = subprocess.run(
        ["git", "-C", str(bare), "rev-parse", "main"],
        capture_output=True, text=True, check=True).stdout.strip()
    assert local_sha == bare_sha


# ================================= route: worktree/file (GET) ==========================

async def test_get_worktree_file_existing(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/code/worktree/file", params={"path": "README.md"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert body["exists"] is True
    assert body["content"] == "hello local\n"
    assert body["binary"] is False
    assert body["truncated"] is False
    assert body["content_hash"] == local_git.worktree_file_hash("README.md")


async def test_get_worktree_file_missing(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/code/worktree/file", params={"path": "nope.txt"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert body["exists"] is False
    assert body["content"] == ""
    assert body["content_hash"] is None


async def test_get_worktree_file_unsafe_path_400(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(
        f"/api/containers/{cid}/code/worktree/file", params={"path": "../../../etc/passwd"})
    assert r.status_code == 400


async def test_get_worktree_file_github_binding_degrades(client, container):
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/site"})
    r = await client.get(f"/api/containers/{cid}/code/worktree/file", params={"path": "README.md"})
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "github_source"


# ================================= route: worktree/file (PUT) ==========================

async def test_put_worktree_file_write_read_roundtrip(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.put(
        f"/api/containers/{cid}/code/worktree/file",
        json={"path": "brand_new.py", "content": "x = 1\n", "base_hash": None},
    )
    assert r.status_code == 200, r.text
    put_body = r.json()
    assert put_body["ok"] is True
    assert put_body["content_hash"]

    r = await client.get(f"/api/containers/{cid}/code/worktree/file", params={"path": "brand_new.py"})
    get_body = r.json()
    assert get_body["exists"] is True
    assert get_body["content"] == "x = 1\n"
    assert get_body["content_hash"] == put_body["content_hash"]


async def test_put_worktree_file_create_over_existing_refused(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.put(
        f"/api/containers/{cid}/code/worktree/file",
        json={"path": "README.md", "content": "clobber\n", "base_hash": None},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    assert body["reason"] == "exists"
    assert body["current_hash"] == local_git.worktree_file_hash("README.md")
    # the on-disk file must be untouched
    assert (local_repo / "README.md").read_text() == "hello local\n"


async def test_put_worktree_file_drift_then_success(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/code/worktree/file", params={"path": "README.md"})
    stale_hash = r.json()["content_hash"]

    # an agent (or a concurrent editor) modifies the file on disk directly
    (local_repo / "README.md").write_text("modified out from under the editor\n")

    r = await client.put(
        f"/api/containers/{cid}/code/worktree/file",
        json={"path": "README.md", "content": "editor wins?\n", "base_hash": stale_hash},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    assert body["reason"] == "drift"
    current_hash = body["current_hash"]
    assert current_hash == local_git.worktree_file_hash("README.md")
    # the file was NOT overwritten by the stale-hash PUT
    assert (local_repo / "README.md").read_text() == "modified out from under the editor\n"

    # retrying with the CURRENT hash succeeds
    r = await client.put(
        f"/api/containers/{cid}/code/worktree/file",
        json={"path": "README.md", "content": "editor wins now\n", "base_hash": current_hash},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert (local_repo / "README.md").read_text() == "editor wins now\n"


async def test_put_worktree_file_unsafe_path_400(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.put(
        f"/api/containers/{cid}/code/worktree/file",
        json={"path": "../../../etc/passwd", "content": "x", "base_hash": None},
    )
    assert r.status_code == 400


async def test_put_worktree_file_git_internal_path_400(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.put(
        f"/api/containers/{cid}/code/worktree/file",
        json={"path": ".git/config", "content": "x", "base_hash": None},
    )
    assert r.status_code == 400


async def test_put_worktree_file_too_large_refused(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    huge = "a" * (2_000_001)
    r = await client.put(
        f"/api/containers/{cid}/code/worktree/file",
        json={"path": "huge.txt", "content": huge, "base_hash": None},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    assert body["reason"] == "too_large"
    assert not (local_repo / "huge.txt").exists()


async def test_put_worktree_file_github_binding_degrades(client, container):
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/site"})
    r = await client.put(
        f"/api/containers/{cid}/code/worktree/file",
        json={"path": "README.md", "content": "x", "base_hash": None},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "github_source"


# ================================= route: worktree/commit ===============================

async def test_post_worktree_commit_success(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.put(
        f"/api/containers/{cid}/code/worktree/file",
        json={"path": "committed.py", "content": "y = 2\n", "base_hash": None},
    )
    assert r.json()["ok"] is True

    r = await client.post(
        f"/api/containers/{cid}/code/worktree/commit",
        json={"paths": ["committed.py"], "message": "add committed.py"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert len(body["sha"]) == 40
    assert body["short"] == body["sha"][:7]


async def test_post_worktree_commit_with_author_override(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    await client.put(
        f"/api/containers/{cid}/code/worktree/file",
        json={"path": "attributed.py", "content": "z = 3\n", "base_hash": None},
    )
    r = await client.post(
        f"/api/containers/{cid}/code/worktree/commit",
        json={
            "paths": ["attributed.py"], "message": "attributed via portal",
            "author_name": "Portal Editor", "author_email": "editor@example.com",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    out = subprocess.run(
        ["git", "-C", str(local_repo), "log", "-1", "--format=%an <%ae>"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert out == "Portal Editor <editor@example.com>"


async def test_post_worktree_commit_nothing_committed(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.post(
        f"/api/containers/{cid}/code/worktree/commit",
        json={"paths": ["README.md"], "message": "no-op commit"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    assert body["reason"] == "nothing_committed"


async def test_post_worktree_commit_empty_paths_400(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.post(
        f"/api/containers/{cid}/code/worktree/commit",
        json={"paths": [], "message": "x"},
    )
    assert r.status_code == 422  # pydantic min_length=1 rejection


async def test_post_worktree_commit_blank_message_400(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.post(
        f"/api/containers/{cid}/code/worktree/commit",
        json={"paths": ["README.md"], "message": "   "},
    )
    assert r.status_code == 400


async def test_post_worktree_commit_unsafe_path_400(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.post(
        f"/api/containers/{cid}/code/worktree/commit",
        json={"paths": ["../../../etc/passwd"], "message": "x"},
    )
    assert r.status_code == 400


async def test_post_worktree_commit_github_binding_degrades(client, container):
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/site"})
    r = await client.post(
        f"/api/containers/{cid}/code/worktree/commit",
        json={"paths": ["README.md"], "message": "x"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "github_source"


# =================================== route: worktree/push ===============================

async def test_post_worktree_push_success(client, container, tmp_path, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    bare = tmp_path / "origin.git"
    bare.mkdir()
    _git(bare, "init", "-q", "--bare")
    _git(local_repo, "remote", "add", "origin", str(bare))
    await client.put(
        f"/api/containers/{cid}/code/worktree/file",
        json={"path": "pushed.py", "content": "p = 1\n", "base_hash": None},
    )
    await client.post(
        f"/api/containers/{cid}/code/worktree/commit",
        json={"paths": ["pushed.py"], "message": "add pushed.py"},
    )
    r = await client.post(f"/api/containers/{cid}/code/worktree/push")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["detail"] == ""
    local_sha = subprocess.run(
        ["git", "-C", str(local_repo), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=True).stdout.strip()
    bare_sha = subprocess.run(
        ["git", "-C", str(bare), "rev-parse", "main"],
        capture_output=True, text=True, check=True).stdout.strip()
    assert local_sha == bare_sha


async def test_post_worktree_push_no_remote_fails_honestly(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.post(f"/api/containers/{cid}/code/worktree/push")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    assert body["detail"]


async def test_post_worktree_push_github_binding_degrades(client, container):
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/site"})
    r = await client.post(f"/api/containers/{cid}/code/worktree/push")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "github_source"


# ================================== route: worktree/branch ===============================

async def test_get_worktree_branch_no_upstream(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/code/worktree/branch")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert body["branch"] == "main"
    assert len(body["sha"]) == 7
    assert body["ahead"] is None
    assert body["behind"] is None
    assert body["remote"] is None


async def test_get_worktree_branch_with_remote(client, container, tmp_path, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    bare = tmp_path / "origin.git"
    bare.mkdir()
    _git(bare, "init", "-q", "--bare")
    _git(local_repo, "remote", "add", "origin", str(bare))
    r = await client.get(f"/api/containers/{cid}/code/worktree/branch")
    body = r.json()
    assert body["remote"] == str(bare)


async def test_get_worktree_branch_github_binding_degrades(client, container):
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/site"})
    r = await client.get(f"/api/containers/{cid}/code/worktree/branch")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "github_source"


async def test_get_worktree_branch_bad_uuid_400(client):
    r = await client.get("/api/containers/not-a-uuid/code/worktree/branch")
    assert r.status_code == 400
