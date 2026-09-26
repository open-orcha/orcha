"""Local-or-GitHub code source — Orcha Cloud local run, Addendum 2
(docs/orcha-cloud-local-run.md). Covers:

  * `portal_backend.local_git` against a REAL temp git repo (init, commit files incl.
    a subdir + a binary blob) — available(), resolve_ref/branches, tree, file_bytes
    (text + binary), grep, archive_bytes, log1, path-traversal rejection.
  * the repo-binding sentinel "local": PUT/GET .../github accepts it (400 with an
    honest message when local_git isn't available), GET /api/github/repos prepends a
    local entry.
  * end-to-end via the REAL browse endpoints (repo="local"): tree/file/search shapes
    match the GitHub-path shapes exactly, snapshot/symbols indexing works off
    `git archive`.
  * the hub's graceful "local_source" degrade for issues/PRs/checks.

Per the test-teeth convention used across the GitHub test modules, NOTHING here stubs
`local_git` itself — every test drives it against a real filesystem git repo (the whole
point of this module is that it needs no network mocking at all). `ORCHA_LOCAL_REPO_DIR`
is monkeypatched per test to point at a fresh temp repo.
"""
import os
import subprocess
import uuid

import pytest

from portal_backend import code_space_routes as cs
from portal_backend import github_hub_routes as hub
from portal_backend import github_repo_browse_routes as browse
from portal_backend import github_routes
from portal_backend import local_git


# --------------------------------------------------------------------- fixtures ---

@pytest.fixture(autouse=True)
def _clear_caches():
    """Same module-dict caches test_repo_browser_api.py/test_code_space_api.py reset
    around every test — a local-repo test binds the SAME cid/ref-shaped cache keys a
    GitHub-repo test would, so a leak between test files (or between tests here) would
    otherwise be possible."""
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()
    browse._REPO_SNAPSHOT_CACHE.clear()
    browse._LOCAL_REF_CACHE.clear()
    browse._REPO_SNAPSHOT_ORDER.clear()
    cs._SYMBOL_TREE_CACHE.clear()
    yield
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()
    browse._REPO_SNAPSHOT_CACHE.clear()
    browse._LOCAL_REF_CACHE.clear()
    browse._REPO_SNAPSHOT_ORDER.clear()
    cs._SYMBOL_TREE_CACHE.clear()


def _git(repo_dir, *args):
    subprocess.run(["git", "-C", str(repo_dir), *args], check=True, capture_output=True)


PY_SOURCE = "def foo():\n    pass\n\n\nclass Widget:\n    pass\n"


@pytest.fixture
def local_repo(tmp_path, monkeypatch):
    """A REAL git repo at tmp_path/repo: a root file, a subdir file, and a binary
    blob, committed on a deterministic branch name (git's default init branch name
    varies by global config, so it's pinned explicitly via `-b main` for a stable
    `branches()`/HEAD assertion). Returns the repo dir; ORCHA_LOCAL_REPO_DIR is
    monkeypatched to point at it for the duration of the test."""
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    _git(repo_dir, "init", "-q", "-b", "main")
    _git(repo_dir, "config", "user.email", "test@example.com")
    _git(repo_dir, "config", "user.name", "Test")

    (repo_dir / "README.md").write_text("hello local\n")
    (repo_dir / "src").mkdir()
    (repo_dir / "src" / "main.py").write_text(PY_SOURCE)
    (repo_dir / "bin.dat").write_bytes(b"\x00\x01\x02binary-not-text")

    _git(repo_dir, "add", "-A")
    _git(repo_dir, "commit", "-q", "-m", "initial commit")

    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(repo_dir))
    return repo_dir


async def _bind_local(client, cid):
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "local"})
    assert r.status_code == 200, r.text
    return r


# ============================ local_git module — unit level =======================

def test_available_false_when_env_unset(monkeypatch):
    monkeypatch.delenv("ORCHA_LOCAL_REPO_DIR", raising=False)
    assert local_git.available() is False


def test_available_false_when_dir_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(tmp_path / "does-not-exist"))
    assert local_git.available() is False


def test_available_false_when_dir_has_no_git(monkeypatch, tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(plain))
    assert local_git.available() is False


def test_available_true_for_real_repo(local_repo):
    assert local_git.available() is True


def test_resolve_ref_head_and_branch(local_repo):
    sha = local_git.resolve_ref()
    assert sha is not None and len(sha) == 40
    assert local_git.resolve_ref("HEAD") == sha
    assert local_git.resolve_ref("main") == sha


def test_resolve_ref_bad_ref_returns_none(local_repo):
    assert local_git.resolve_ref("no-such-branch") is None
    assert local_git.resolve_ref("../../etc/passwd") is None


def test_branches_marks_head(local_repo):
    branches = local_git.branches()
    assert branches == [{"name": "main", "is_head": True}]


def test_tree_shape_matches_github_path(local_repo):
    sha = local_git.resolve_ref()
    entries = local_git.tree(sha)
    by_path = {e["path"]: e for e in entries}
    assert by_path["README.md"]["type"] == "blob"
    assert by_path["README.md"]["size"] == len("hello local\n")
    assert by_path["src"]["type"] == "tree"
    assert by_path["src/main.py"]["type"] == "blob"
    assert by_path["bin.dat"]["type"] == "blob"
    # every blob entry carries a sha (used for the outdated/blob_match chip)
    assert all(e.get("sha") for e in entries)


def test_tree_bad_ref_returns_none(local_repo):
    assert local_git.tree("no-such-ref") is None


def test_file_bytes_text_and_binary(local_repo):
    sha = local_git.resolve_ref()
    assert local_git.file_bytes(sha, "README.md") == b"hello local\n"
    assert local_git.file_bytes(sha, "src/main.py") == PY_SOURCE.encode("utf-8")
    assert local_git.file_bytes(sha, "bin.dat") == b"\x00\x01\x02binary-not-text"


def test_file_bytes_missing_path_returns_none(local_repo):
    sha = local_git.resolve_ref()
    assert local_git.file_bytes(sha, "nope.txt") is None


def test_file_bytes_rejects_path_traversal(local_repo):
    sha = local_git.resolve_ref()
    assert local_git.file_bytes(sha, "../outside.txt") is None
    assert local_git.file_bytes(sha, "/etc/passwd") is None
    assert local_git.file_bytes(sha, "src/../../etc/passwd") is None
    assert local_git.file_bytes(sha, "-rf") is None


def test_grep_finds_matches(local_repo):
    sha = local_git.resolve_ref()
    results = local_git.grep(sha, "def foo")
    assert results == [{"path": "src/main.py", "line": 1, "text": "def foo():"}]


def test_grep_no_matches_is_empty_list(local_repo):
    sha = local_git.resolve_ref()
    assert local_git.grep(sha, "no_such_symbol_anywhere") == []


def test_archive_bytes_round_trips_via_tarfile(local_repo):
    import io
    import tarfile

    sha = local_git.resolve_ref()
    data = local_git.archive_bytes(sha)
    assert data is not None
    with tarfile.open(fileobj=io.BytesIO(data), mode="r") as tar:
        names = {m.name for m in tar.getmembers() if m.isfile()}
    # local archive members are ALREADY repo-relative — no synthetic top-level dir
    assert "README.md" in names
    assert "src/main.py" in names
    assert "bin.dat" in names


def test_log1_returns_sha_and_committed_at(local_repo):
    sha = local_git.resolve_ref()
    info = local_git.log1()
    assert info["sha"] == sha
    assert info["committed_at"]  # non-empty ISO string


def test_workspace_name_is_dir_basename(local_repo):
    assert local_git.workspace_name() == "repo"


# ---------------------- origin_repo(): local-binding + GitHub-origin fall-through ----

def test_origin_repo_none_when_no_origin_remote(local_repo):
    # local_repo (the fixture) never configures an `origin` remote.
    assert local_git.origin_repo() is None


def test_origin_repo_parses_https_form(local_repo):
    _git(local_repo, "remote", "add", "origin", "https://github.com/acme/site.git")
    assert local_git.origin_repo() == "acme/site"


def test_origin_repo_parses_https_form_without_dotgit_suffix(local_repo):
    _git(local_repo, "remote", "add", "origin", "https://github.com/acme/site")
    assert local_git.origin_repo() == "acme/site"


def test_origin_repo_parses_ssh_form(local_repo):
    _git(local_repo, "remote", "add", "origin", "git@github.com:acme/site.git")
    assert local_git.origin_repo() == "acme/site"


def test_origin_repo_parses_ssh_form_without_dotgit_suffix(local_repo):
    _git(local_repo, "remote", "add", "origin", "git@github.com:acme/site")
    assert local_git.origin_repo() == "acme/site"


def test_origin_repo_none_for_non_github_https_host(local_repo):
    _git(local_repo, "remote", "add", "origin", "https://gitlab.com/acme/site.git")
    assert local_git.origin_repo() is None


def test_origin_repo_none_for_non_github_ssh_host(local_repo):
    _git(local_repo, "remote", "add", "origin", "git@gitlab.com:acme/site.git")
    assert local_git.origin_repo() is None


def test_origin_repo_none_for_local_filesystem_origin(local_repo, tmp_path):
    other = tmp_path / "other-repo"
    other.mkdir()
    _git(local_repo, "remote", "add", "origin", str(other))
    assert local_git.origin_repo() is None


def test_origin_repo_none_when_local_source_unavailable(monkeypatch):
    monkeypatch.delenv("ORCHA_LOCAL_REPO_DIR", raising=False)
    assert local_git.origin_repo() is None


def test_unavailable_functions_degrade_to_none(monkeypatch):
    monkeypatch.delenv("ORCHA_LOCAL_REPO_DIR", raising=False)
    assert local_git.resolve_ref() is None
    assert local_git.tree() is None
    assert local_git.branches() == []
    assert local_git.file_bytes("HEAD", "a.py") is None
    assert local_git.archive_bytes() is None
    assert local_git.log1() is None
    assert local_git.origin_repo() is None


# ============================ binding: PUT/GET + repos list =======================

async def test_put_local_binding_requires_availability(client, container, monkeypatch):
    monkeypatch.delenv("ORCHA_LOCAL_REPO_DIR", raising=False)
    cid = container["id"]
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "local"})
    assert r.status_code == 400, r.text
    assert "local" in r.text.lower()
    # nothing persisted on the rejected write
    assert (await client.get(f"/api/containers/{cid}/github")).json() == {"repo": None}


async def test_put_local_binding_succeeds_when_available(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/github")
    assert r.status_code == 200 and r.json() == {"repo": "local"}


async def test_local_binding_can_be_rebound_to_github_and_back(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/site"})
    assert r.json() == {"repo": "acme/site"}
    await _bind_local(client, cid)
    assert (await client.get(f"/api/containers/{cid}/github")).json() == {"repo": "local"}


async def test_repos_list_prepends_local_entry_when_available(client, local_repo, monkeypatch):
    monkeypatch.delenv("ORCHA_GITHUB_TOKEN_FILE", raising=False)
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    monkeypatch.delenv("ORCHA_GITHUB_PAT", raising=False)
    r = await client.get("/api/github/repos")
    assert r.status_code == 200, r.text
    body = r.json()
    # available flips true on the strength of the local entry alone, even with
    # ZERO GitHub token sources configured.
    assert body["available"] is True
    assert body["repos"] == [
        {"full_name": "local", "name": "repo", "source_kind": "local",
         "private": False, "description": None, "html_url": None},
    ]


async def test_repos_list_no_local_entry_when_unavailable(client, monkeypatch):
    monkeypatch.delenv("ORCHA_LOCAL_REPO_DIR", raising=False)
    monkeypatch.delenv("ORCHA_GITHUB_TOKEN_FILE", raising=False)
    r = await client.get("/api/github/repos")
    assert r.status_code == 200
    assert r.json() == {"available": False, "repos": []}


async def test_repos_list_prepends_local_ahead_of_github_app_repos(client, local_repo, monkeypatch, tmp_path):
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_testtoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))

    def fake_fetch(token):
        return [{"full_name": "acme/site", "private": True, "description": None,
                  "html_url": "https://github.com/acme/site"}]

    monkeypatch.setattr(github_routes, "_fetch_installation_repos", fake_fetch)
    r = await client.get("/api/github/repos")
    body = r.json()
    assert body["available"] is True
    assert body["repos"][0]["full_name"] == "local"
    assert body["repos"][1]["full_name"] == "acme/site"
    assert body["source"] == "app"  # unchanged meaning: describes the GitHub half only


# ================================ browse: end-to-end ================================

async def test_browse_tree_root_matches_github_shape(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/github/browse/tree")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ref"] == local_git.resolve_ref()
    assert body["path"] == ""
    assert body["truncated"] is False
    entries_by_name = {e["name"]: e for e in body["entries"]}
    assert entries_by_name["src"]["type"] == "dir"
    assert entries_by_name["README.md"]["type"] == "file"
    assert entries_by_name["README.md"]["size"] == len("hello local\n")
    # dirs sorted before files, alphabetically within each group (same as GitHub path)
    assert [e["type"] for e in body["entries"]][0] == "dir"


async def test_browse_tree_subdirectory(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/github/browse/tree", params={"path": "src"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["path"] == "src"
    assert body["entries"] == [
        {"name": "main.py", "path": "src/main.py", "type": "file", "size": len(PY_SOURCE)},
    ]


async def test_browse_tree_nested_subdirectory(client, container, local_repo):
    """A directory two levels deep must show up as a SINGLE collapsed 'dir' entry at
    its parent level (not its own descendants leaking through) — proves
    `_local_tree_level`'s multi-level filtering, not just a one-level-deep repo."""
    cid = container["id"]
    (local_repo / "src" / "nested").mkdir()
    (local_repo / "src" / "nested" / "deep.py").write_text("x = 1\n")
    _git(local_repo, "add", "-A")
    _git(local_repo, "commit", "-q", "-m", "add nested dir")
    await _bind_local(client, cid)

    r = await client.get(f"/api/containers/{cid}/github/browse/tree", params={"path": "src"})
    assert r.status_code == 200, r.text
    entries_by_name = {e["name"]: e for e in r.json()["entries"]}
    assert entries_by_name["nested"]["type"] == "dir"
    assert entries_by_name["nested"]["path"] == "src/nested"
    assert "deep" not in entries_by_name  # descendant, not a direct child

    r2 = await client.get(
        f"/api/containers/{cid}/github/browse/tree", params={"path": "src/nested"})
    assert r2.status_code == 200, r2.text
    assert r2.json()["entries"] == [
        {"name": "deep.py", "path": "src/nested/deep.py", "type": "file", "size": len("x = 1\n")},
    ]


async def test_browse_tree_explicit_ref_sha(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    sha = local_git.resolve_ref()
    r = await client.get(f"/api/containers/{cid}/github/browse/tree", params={"ref": sha})
    assert r.status_code == 200
    assert r.json()["ref"] == sha


async def test_browse_file_text(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/file", params={"path": "README.md"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["binary"] is False
    assert body["content"] == "hello local\n"
    assert body["truncated"] is False
    assert body["size"] == len("hello local\n")


async def test_browse_file_binary(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/file", params={"path": "bin.dat"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["binary"] is True
    assert "content" not in body
    assert body["size"] == len(b"\x00\x01\x02binary-not-text")


async def test_browse_file_missing_returns_not_found(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/file", params={"path": "nope.txt"})
    assert r.status_code == 200
    assert r.json()["reason"] == "not_found"


async def test_browse_file_on_directory_400(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/file", params={"path": "src"})
    assert r.status_code == 400, r.text


async def test_browse_search_names(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/search", params={"q": "main"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    paths = {res["path"] for res in body["results"]}
    assert "src/main.py" in paths


async def test_browse_search_contents_grep(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/search",
        params={"q": "def foo", "mode": "contents"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert body["default_branch_only"] is False
    assert body["results"] == [{"path": "src/main.py", "line": 1, "text": "def foo():"}]


async def test_browse_not_connected_when_unbound(client, container, local_repo):
    r = await client.get(f"/api/containers/{container['id']}/github/browse/tree")
    assert r.status_code == 200
    assert r.json()["reason"] == "repo_not_connected"


# ============================ code space: snapshot + symbols ========================

async def test_symbols_index_via_git_archive_snapshot(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/code/symbols")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert body["indexing"] is False
    assert body["indexed"] == body["total"]
    names = {s["name"] for s in body["results"]}
    assert {"foo", "Widget"} <= names


async def test_outline_local_file(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(
        f"/api/containers/{cid}/code/outline", params={"path": "src/main.py"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["language"] == "python"
    names = {s["name"] for s in body["symbols"]}
    assert {"foo", "Widget"} <= names


async def test_code_thread_anchors_to_local_sha(client, container, make_agent, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    agent = await make_agent("Dev", kind="ai")
    r = await client.post(
        f"/api/containers/{cid}/code/threads",
        json={
            "actor_agent_id": agent["agent_id"], "path": "src/main.py",
            "start_line": 1, "end_line": 2, "kind": "question", "body": "why?",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["repo"] == "local"
    assert body["sha"] == local_git.resolve_ref()


async def test_code_thread_list_blob_match_true_for_local(client, container, make_agent, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    agent = await make_agent("Dev", kind="ai")
    await client.post(
        f"/api/containers/{cid}/code/threads",
        json={
            "actor_agent_id": agent["agent_id"], "path": "src/main.py",
            "start_line": 1, "end_line": 2, "kind": "question", "body": "why?",
        },
    )
    r = await client.get(f"/api/containers/{cid}/code/threads", params={"path": "src/main.py"})
    assert r.status_code == 200, r.text
    threads = r.json()["threads"]
    assert len(threads) == 1
    assert threads[0]["blob_match"] is True


# ================================ hub: local_source degrade ==========================

async def test_hub_issues_local_source_reason(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/github/issues")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "local_source"
    # no `origin` remote configured on the fixture repo -> no origin detected.
    assert body["origin_detected"] is None


async def test_hub_pulls_local_source_reason(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/github/pulls")
    assert r.status_code == 200
    body = r.json()
    assert body["reason"] == "local_source"
    assert body["origin_detected"] is None


async def test_hub_checks_local_source_reason(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/github/checks", params={"numbers": "1,2"})
    assert r.status_code == 200
    body = r.json()
    assert body["reason"] == "local_source"
    assert body["origin_detected"] is None


async def test_hub_pull_detail_local_source_reason(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/github/pulls/1")
    assert r.status_code == 200
    body = r.json()
    assert body["reason"] == "local_source"
    assert body["origin_detected"] is None


async def test_hub_issue_detail_local_source_reason(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/github/issues/1")
    assert r.status_code == 200
    body = r.json()
    assert body["reason"] == "local_source"
    assert body["origin_detected"] is None


# ============ hub: local-binding + GitHub-origin fall-through (simultaneous local
# binding + GitHub hub) — the working tree is LOCAL-bound but its `origin` remote
# points at a GitHub repo; when a token is ALSO resolvable for that origin, the hub
# routes serve GitHub data against the origin transparently. `_gh_get` is stubbed
# (never real network), matching test_github_hub_routes.py's own convention. =========

async def test_hub_issues_falls_through_to_origin_when_token_present(
        client, container, local_repo, monkeypatch):
    cid = container["id"]
    _git(local_repo, "remote", "add", "origin", "https://github.com/acme/site.git")
    await _bind_local(client, cid)

    token_file_dir = local_repo.parent
    token_file = token_file_dir / "github-token"
    token_file.write_text("ghs_origintoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)

    def fake_get(path, token):
        assert token == "ghs_origintoken"
        assert path.startswith("/repos/acme/site/issues")
        return [{"number": 5, "title": "from origin", "labels": [], "assignee": None,
                  "updated_at": "2026-07-01T00:00:00Z",
                  "html_url": "https://github.com/acme/site/issues/5", "body": ""}]

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/issues")
    assert r.status_code == 200, r.text
    body = r.json()
    # served exactly as if the container had been bound to "acme/site" directly:
    # available:true, `repo` echoes the ORIGIN (never the "local" sentinel), real data.
    assert body["available"] is True
    assert body["repo"] == "acme/site"
    assert body["issues"][0]["title"] == "from origin"


async def test_hub_pulls_falls_through_to_origin_when_token_present(
        client, container, local_repo, monkeypatch):
    cid = container["id"]
    _git(local_repo, "remote", "add", "origin", "git@github.com:acme/site.git")
    await _bind_local(client, cid)

    token_file = local_repo.parent / "github-token"
    token_file.write_text("ghs_origintoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)

    def fake_get(path, token):
        assert path.startswith("/repos/acme/site/pulls")
        return [{"number": 9, "title": "origin PR", "head": {"ref": "feat/x", "sha": "a" * 40},
                  "draft": False, "updated_at": "2026-07-01T00:00:00Z",
                  "html_url": "https://github.com/acme/site/pull/9",
                  "requested_reviewers": [], "mergeable_state": "clean"}]

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert body["repo"] == "acme/site"
    assert body["pulls"][0]["title"] == "origin PR"


async def test_hub_pull_detail_falls_through_to_origin_when_token_present(
        client, container, local_repo, monkeypatch):
    cid = container["id"]
    _git(local_repo, "remote", "add", "origin", "https://github.com/acme/site.git")
    await _bind_local(client, cid)

    token_file = local_repo.parent / "github-token"
    token_file.write_text("ghs_origintoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)

    def fake_get(path, token):
        if path == "/repos/acme/site/pulls/9":
            return {"number": 9, "title": "origin PR", "state": "open", "draft": False,
                     "body": "", "user": {"login": "octocat"}, "base": {"ref": "main"},
                     "head": {"ref": "feat/x", "sha": "a" * 40},
                     "updated_at": "2026-07-01T00:00:00Z", "created_at": "2026-07-01T00:00:00Z",
                     "html_url": "https://github.com/acme/site/pull/9",
                     "mergeable_state": "clean", "assignees": [], "requested_reviewers": [],
                     "comments": 0, "review_comments": 0, "changed_files": 0}
        if "status" in path:
            return {"statuses": []}
        if "check-runs" in path:
            return {"check_runs": []}
        if "files" in path:
            return []
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls/9")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert body["repo"] == "acme/site"
    assert body["pull"]["title"] == "origin PR"


async def test_hub_issue_detail_falls_through_to_origin_when_token_present(
        client, container, local_repo, monkeypatch):
    cid = container["id"]
    _git(local_repo, "remote", "add", "origin", "https://github.com/acme/site.git")
    await _bind_local(client, cid)

    token_file = local_repo.parent / "github-token"
    token_file.write_text("ghs_origintoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)

    def fake_get(path, token):
        if path == "/repos/acme/site/issues/3":
            return {"number": 3, "title": "origin issue", "state": "open", "body": "",
                     "user": {"login": "octocat"}, "labels": [], "assignee": None,
                     "assignees": [], "updated_at": "2026-07-01T00:00:00Z",
                     "created_at": "2026-07-01T00:00:00Z",
                     "html_url": "https://github.com/acme/site/issues/3", "comments": 0}
        if "comments" in path:
            return []
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/issues/3")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert body["repo"] == "acme/site"
    assert body["issue"]["title"] == "origin issue"


async def test_hub_checks_falls_through_to_origin_when_token_present(
        client, container, local_repo, monkeypatch):
    cid = container["id"]
    _git(local_repo, "remote", "add", "origin", "https://github.com/acme/site.git")
    await _bind_local(client, cid)

    token_file = local_repo.parent / "github-token"
    token_file.write_text("ghs_origintoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)

    def fake_get(path, token):
        if path.startswith("/repos/acme/site/pulls?"):
            return [{"number": 9, "title": "origin PR", "head": {"ref": "feat/x", "sha": "b" * 40},
                      "draft": False, "updated_at": "2026-07-01T00:00:00Z",
                      "html_url": "https://github.com/acme/site/pull/9",
                      "requested_reviewers": [], "mergeable_state": "clean"}]
        if "status" in path:
            return {"statuses": []}
        if "check-runs" in path:
            return {"check_runs": []}
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/checks", params={"numbers": "9"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert "9" in body["checks"]


async def test_hub_issues_degrades_with_origin_detected_when_origin_but_no_token(
        client, container, local_repo, monkeypatch):
    """An origin exists, but NOTHING resolves a token for it — degrades exactly like
    the no-origin case, EXCEPT `origin_detected` names the repo so the frontend can
    render the more specific "add GitHub access" wording."""
    cid = container["id"]
    _git(local_repo, "remote", "add", "origin", "https://github.com/acme/site.git")
    await _bind_local(client, cid)
    monkeypatch.delenv("ORCHA_GITHUB_TOKEN_FILE", raising=False)
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    monkeypatch.delenv("ORCHA_GITHUB_PAT", raising=False)

    r = await client.get(f"/api/containers/{cid}/github/issues")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "local_source"
    assert body["origin_detected"] == "acme/site"


async def test_hub_issues_degrades_with_origin_detected_none_when_no_origin(
        client, container, local_repo):
    """No `origin` remote at all -> origin_detected stays None, distinguishing this
    from the "origin but no token" case above."""
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/github/issues")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "local_source"
    assert body["origin_detected"] is None


async def test_hub_issues_no_fallthrough_for_non_github_https_origin(
        client, container, local_repo, monkeypatch):
    """A non-GitHub https origin (e.g. GitLab) never falls through — origin_repo()
    itself returns None for it, so this degrades exactly like the no-origin case."""
    cid = container["id"]
    _git(local_repo, "remote", "add", "origin", "https://gitlab.com/acme/site.git")
    await _bind_local(client, cid)
    token_file = local_repo.parent / "github-token"
    token_file.write_text("ghs_origintoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)

    r = await client.get(f"/api/containers/{cid}/github/issues")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "local_source"
    assert body["origin_detected"] is None


# =============================== path traversal at the route layer ====================

async def test_browse_file_path_traversal_rejected(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/file", params={"path": "../../../etc/passwd"})
    assert r.status_code == 200
    # normalized by strip("/") upstream to a relative-looking path that still can't
    # escape the repo — local_git.file_bytes rejects the ".." segment outright, so
    # this reads as "not found", never a leaked file from outside the repo.
    assert r.json()["reason"] == "not_found"


# ==================== BLAZING-fast local reads: snapshot-served file =================
# docs/orcha-cloud-local-run.md addendum — `_local_file_response` tries the cached
# repo snapshot FIRST (`_snapshot_bytes_for_path`) and only falls back to
# `local_git.file_bytes` (a `git show` subprocess) when the snapshot has no entry for
# the path. These tests assert the fast path is actually taken (no subprocess call)
# when a snapshot is warm, and that the fallback still works correctly when it isn't.

async def test_browse_file_served_from_warm_snapshot_no_subprocess(client, container, local_repo, monkeypatch):
    cid = container["id"]
    await _bind_local(client, cid)
    sha = local_git.resolve_ref()
    # Warm the snapshot the same way the background warmer does (same cache key).
    r = await client.get(f"/api/containers/{cid}/code/symbols")
    assert r.status_code == 200, r.text
    assert browse._repo_snapshot_cache_get(cid, sha) is not None

    def _boom(*args, **kwargs):
        raise AssertionError("local_git.file_bytes must not be called when the snapshot is warm")
    monkeypatch.setattr(local_git, "file_bytes", _boom)

    r = await client.get(
        f"/api/containers/{cid}/github/browse/file", params={"path": "src/main.py"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["binary"] is False
    assert body["content"] == PY_SOURCE


async def test_browse_file_falls_back_to_git_show_when_snapshot_cold(client, container, local_repo):
    """README.md is a snapshot MISS (only source extensions the symbol indexer cares
    about are kept — see LANGUAGE_BY_EXTENSION), so even with a warm snapshot the
    fallback path must still serve it correctly."""
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/code/symbols")
    assert r.status_code == 200, r.text
    r = await client.get(
        f"/api/containers/{cid}/github/browse/file", params={"path": "README.md"})
    assert r.status_code == 200, r.text
    assert r.json()["content"] == "hello local\n"


async def test_browse_file_snapshot_miss_before_any_snapshot_built(client, container, local_repo):
    """No symbol search has ever run for this cid/ref — `_snapshot_bytes_for_path`
    must return None (no cache entry at all) rather than error, and the route falls
    back to git show cleanly."""
    cid = container["id"]
    await _bind_local(client, cid)
    sha = local_git.resolve_ref()
    assert browse._repo_snapshot_cache_get(cid, sha) is None
    r = await client.get(
        f"/api/containers/{cid}/github/browse/file", params={"path": "src/main.py"})
    assert r.status_code == 200, r.text
    assert r.json()["content"] == PY_SOURCE


# ====================== BLAZING-fast local reads: in-memory search ====================
# `browse_search(mode="contents")` tries `_in_memory_grep` over the warm snapshot first
# and only shells out to `local_git.grep` when no snapshot is cached yet.

async def test_browse_search_contents_served_in_memory_no_subprocess(client, container, local_repo, monkeypatch):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/code/symbols")
    assert r.status_code == 200, r.text

    def _boom(*args, **kwargs):
        raise AssertionError("local_git.grep must not be called when the snapshot is warm")
    monkeypatch.setattr(local_git, "grep", _boom)

    r = await client.get(
        f"/api/containers/{cid}/github/browse/search",
        params={"q": "def foo", "mode": "contents"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert body["default_branch_only"] is False
    assert body["results"] == [{"path": "src/main.py", "line": 1, "text": "def foo():"}]


async def test_browse_search_contents_falls_back_to_git_grep_when_snapshot_cold(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/search",
        params={"q": "def foo", "mode": "contents"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["results"] == [{"path": "src/main.py", "line": 1, "text": "def foo():"}]


async def test_in_memory_grep_case_insensitive_and_capped(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/code/symbols")
    assert r.status_code == 200, r.text
    sha = local_git.resolve_ref()
    results = browse._in_memory_grep(cid, sha, "CLASS WIDGET")
    assert results == [{"path": "src/main.py", "line": 5, "text": "class Widget:"}]


async def test_in_memory_grep_returns_none_when_no_snapshot_cached(container):
    # No client call ever warmed the snapshot for this (cid, ref) — the caller's
    # signal to fall back to local_git.grep.
    assert browse._in_memory_grep(container["id"], "deadbeef" * 5, "anything") is None
