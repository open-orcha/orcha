"""GitHub-bound Code Space editing (Phase 4) — code_github_edit_routes.py. Per the
test-teeth convention used across the GitHub-route test modules, the ONLY things
stubbed are the network leaves (`github_repo_browse_routes._gh_get` for reads —
resolved dynamically through the shared `_resolve_ref`/`_fetch_full_tree`/
`_resolve_default_branch` helpers, the SAME seam tests/test_repo_browser_api.py
patches for those exact helpers — and `code_github_edit_routes._gh_post` for the five
Git Data write calls) plus the installation-token file read — the routes, grant gate,
base/conflict resolution, branch naming, and error classification all run for real.
"""
import subprocess

import pytest

from portal_backend import code_github_edit_routes as edit
from portal_backend import github_repo_browse_routes as browse


@pytest.fixture(autouse=True)
def _clear_caches():
    """The tree/default-branch caches _resolve_ref/_fetch_full_tree lean on are plain
    module dicts on github_repo_browse_routes — reset around every test so one test's
    cached payload never leaks into the next (mirrors test_repo_browser_api.py's own
    fixture)."""
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()
    yield
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()


@pytest.fixture
def token_env(monkeypatch, tmp_path):
    """Wire a legacy single installation-token file so _resolve_repo_token yields a
    token (the multi-org map is absent). Identical to the browse/hub tests' fixture."""
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_hubtoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    return "ghs_hubtoken"


def _git(repo_dir, *args):
    subprocess.run(["git", "-C", str(repo_dir), *args], check=True, capture_output=True)


@pytest.fixture
def local_repo(tmp_path, monkeypatch):
    """A REAL git repo at tmp_path/repo — the local-binding degrade tests need
    ORCHA_LOCAL_REPO_DIR to resolve to a real repo for `PUT .../github {repo:"local"}`
    itself to succeed (local_git.available() gates the bind), mirroring
    tests/test_code_workingtree.py's own `local_repo` fixture."""
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    _git(repo_dir, "init", "-q", "-b", "main")
    _git(repo_dir, "config", "user.email", "test@example.com")
    _git(repo_dir, "config", "user.name", "Test")
    (repo_dir / "README.md").write_text("hello local\n")
    _git(repo_dir, "add", "-A")
    _git(repo_dir, "commit", "-q", "-m", "initial commit")
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(repo_dir))
    return repo_dir


async def _bind_repo(client, cid, repo="acme/site"):
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": repo})
    assert r.status_code == 200, r.text


async def _bind_local(client, cid):
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "local"})
    assert r.status_code == 200, r.text


BASE_COMMIT_SHA = "base0000sha"
BASE_TREE_SHA = "basetree0000sha"


def _default_gh_get(existing_paths_and_shas=None):
    """A fake `_gh_get` covering: default-branch resolution, the base commit fetch,
    and the recursive base-tree fetch (`_fetch_full_tree`). `existing_paths_and_shas`
    seeds the base tree with pre-existing blobs, e.g. {"a.py": "abc123"} — used by the
    drift/exists conflict tests."""
    existing = existing_paths_and_shas or {}

    def fake_get(path, token):
        assert token == "ghs_hubtoken"
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        if path == f"/repos/acme/site/git/commits/main":
            return {"sha": BASE_COMMIT_SHA, "tree": {"sha": BASE_TREE_SHA}}
        if path == f"/repos/acme/site/git/commits/{BASE_COMMIT_SHA}":
            return {"sha": BASE_COMMIT_SHA, "tree": {"sha": BASE_TREE_SHA}}
        if path == f"/repos/acme/site/git/trees/main?recursive=1":
            return {"tree": [
                {"path": p, "type": "blob", "sha": s} for p, s in existing.items()
            ], "truncated": False}
        if path == f"/repos/acme/site/git/trees/{BASE_COMMIT_SHA}?recursive=1":
            return {"tree": [
                {"path": p, "type": "blob", "sha": s} for p, s in existing.items()
            ], "truncated": False}
        raise AssertionError(f"unexpected _gh_get path {path}")

    return fake_get


def _resolve_ref_via_default_branch(monkeypatch, existing=None):
    """_resolve_ref(base_ref='') resolves via the default branch ('main'), which
    _gh_get is never asked to turn into a sha (browse._resolve_default_branch just
    returns the branch NAME 'main' — the base sha in this whole flow IS the string
    'main' resolved straight through as a ref, exactly like every other ref-less
    caller in this portal). So the git/commits/{sha} call actually asks for
    git/commits/main. Patched on `browse` (github_repo_browse_routes), the module
    whose global `_gh_get` the shared `_resolve_ref`/`_fetch_full_tree`/
    `_resolve_default_branch` helpers actually call — see the module docstring."""
    monkeypatch.setattr(browse, "_gh_get", _default_gh_get(existing))


# ------------------------- editable gate -------------------------

async def test_editable_repo_not_connected(client, container):
    r = await client.get(f"/api/containers/{container['id']}/code/github/editable")
    assert r.status_code == 200, r.text
    assert r.json() == {"available": False, "reason": "repo_not_connected",
                        "detail": "no GitHub repo is connected to this project"}


async def test_editable_local_binding_degrades(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.get(f"/api/containers/{cid}/code/github/editable")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "local_source"


async def test_editable_true_when_token_resolves(client, container, token_env):
    cid = container["id"]
    await _bind_repo(client, cid)
    r = await client.get(f"/api/containers/{cid}/code/github/editable")
    assert r.status_code == 200, r.text
    assert r.json() == {"available": True}


async def test_editable_false_when_no_token(client, container):
    cid = container["id"]
    await _bind_repo(client, cid)
    r = await client.get(f"/api/containers/{cid}/code/github/editable")
    assert r.status_code == 200, r.text
    assert r.json() == {"available": False}


# ------------------------- propose: degrades -------------------------

async def test_propose_repo_not_connected(client, container):
    r = await client.post(
        f"/api/containers/{container['id']}/code/github/propose",
        json={"base_ref": None, "message": "add a file",
              "files": [{"path": "a.py", "content": "x = 1\n"}]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "repo_not_connected"


async def test_propose_local_binding_degrades(client, container, local_repo):
    cid = container["id"]
    await _bind_local(client, cid)
    r = await client.post(
        f"/api/containers/{cid}/code/github/propose",
        json={"base_ref": None, "message": "add a file",
              "files": [{"path": "a.py", "content": "x = 1\n"}]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "local_source"
    assert "save/commit flow" in body["detail"]


# ------------------------- propose: input validation (400s) -------------------------

async def test_propose_blank_message_400(client, container, token_env):
    cid = container["id"]
    await _bind_repo(client, cid)
    r = await client.post(
        f"/api/containers/{cid}/code/github/propose",
        json={"base_ref": None, "message": "   ",
              "files": [{"path": "a.py", "content": "x = 1\n"}]},
    )
    assert r.status_code == 400


async def test_propose_empty_files_422(client, container, token_env):
    cid = container["id"]
    await _bind_repo(client, cid)
    r = await client.post(
        f"/api/containers/{cid}/code/github/propose",
        json={"base_ref": None, "message": "add a file", "files": []},
    )
    # The schema's min_length=1 on `files` rejects this at the FastAPI validation
    # layer before the route body even runs.
    assert r.status_code == 422


async def test_propose_unsafe_path_400(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    r = await client.post(
        f"/api/containers/{cid}/code/github/propose",
        json={"base_ref": None, "message": "add a file",
              "files": [{"path": "../../etc/passwd", "content": "x\n"}]},
    )
    assert r.status_code == 400


async def test_propose_git_internal_path_400(client, container, token_env):
    cid = container["id"]
    await _bind_repo(client, cid)
    r = await client.post(
        f"/api/containers/{cid}/code/github/propose",
        json={"base_ref": None, "message": "add a file",
              "files": [{"path": ".git/hooks/pre-commit", "content": "x\n"}]},
    )
    assert r.status_code == 400


# ------------------------- propose: happy path -------------------------

async def test_propose_happy_path_full_call_sequence(client, container, token_env, monkeypatch):
    """Asserts the EXACT Git Data call sequence + payloads: blobs (b64 content) ->
    tree (base_tree + entries) -> commit (parents) -> ref (branch name) -> PR
    (head/base/body footer)."""
    cid = container["id"]
    await _bind_repo(client, cid)
    _resolve_ref_via_default_branch(monkeypatch)

    calls = []

    def fake_post(path, token, payload):
        assert token == "ghs_hubtoken"
        calls.append((path, payload))
        if path == "/repos/acme/site/git/blobs":
            return {"sha": f"blob-{payload['content'][:6]}"}
        if path == "/repos/acme/site/git/trees":
            return {"sha": "newtree0000sha"}
        if path == "/repos/acme/site/git/commits":
            return {"sha": "newcommit0000sha"}
        if path == "/repos/acme/site/git/refs":
            return {"ref": payload["ref"]}
        if path == "/repos/acme/site/pulls":
            return {"number": 7, "html_url": "https://github.com/acme/site/pull/7"}
        raise AssertionError(f"unexpected _gh_post path {path}")

    monkeypatch.setattr(edit, "_gh_post", fake_post)

    r = await client.post(
        f"/api/containers/{cid}/code/github/propose",
        json={
            "base_ref": None,
            "message": "Add greeting\n\nSome extra body detail.",
            "files": [{"path": "greet.py", "content": "print('hi')\n", "base_hash": None}],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {
        "available": True, "ok": True,
        "pr_number": 7,
        "pr_url": "https://github.com/acme/site/pull/7",
        "branch": body["branch"],  # asserted in detail below
        "commit_sha": "newcommit0000sha",
    }
    assert body["branch"].startswith("codespace/member-")

    call_paths = [c[0] for c in calls]
    assert call_paths == [
        "/repos/acme/site/git/blobs",
        "/repos/acme/site/git/trees",
        "/repos/acme/site/git/commits",
        "/repos/acme/site/git/refs",
        "/repos/acme/site/pulls",
    ]

    blob_payload = calls[0][1]
    import base64
    assert base64.b64decode(blob_payload["content"]).decode("utf-8") == "print('hi')\n"
    assert blob_payload["encoding"] == "base64"

    tree_payload = calls[1][1]
    assert tree_payload["base_tree"] == BASE_TREE_SHA
    assert tree_payload["tree"] == [
        {"path": "greet.py", "mode": "100644", "type": "blob",
         "sha": f"blob-{blob_payload['content'][:6]}"}
    ]

    commit_payload = calls[2][1]
    # base_ref was omitted -> _resolve_ref resolves through the default branch, which
    # is the branch NAME "main" (not a fabricated sha) — commit parents are keyed on
    # whatever _resolve_ref actually returned, exactly as the real Git Data API
    # sequence would use it.
    assert commit_payload["parents"] == ["main"]
    assert commit_payload["tree"] == "newtree0000sha"
    assert commit_payload["message"] == "Add greeting\n\nSome extra body detail."

    ref_payload = calls[3][1]
    assert ref_payload["ref"] == f"refs/heads/{body['branch']}"
    assert ref_payload["sha"] == "newcommit0000sha"

    pr_payload = calls[4][1]
    assert pr_payload["head"] == body["branch"]
    assert pr_payload["base"] == "main"
    assert pr_payload["title"] == "Add greeting"
    assert "Some extra body detail." in pr_payload["body"]
    assert "Proposed from Orcha Code Space by a project member." in pr_payload["body"]


async def test_propose_branch_name_sanitizes_login(client, container, make_agent, monkeypatch, token_env):
    """Under proxy trust with a resolvable github_login, the branch name uses the
    sanitized (lowercase, [\\w-]-only) login instead of the "member" fallback, while
    the PR footer carries the RAW login unchanged."""
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    headers = {"X-Auth-Request-User": "Octo-Cat"}
    # Bind the member's github_login via GET /me (mirrors test_github_hub_routes.py's
    # _bind_owner idiom).
    r = await client.get(f"/api/me?cid={cid}", headers=headers)
    assert r.status_code == 200, r.text

    await _bind_repo(client, cid)
    _resolve_ref_via_default_branch(monkeypatch)

    def fake_post(path, token, payload):
        if path == "/repos/acme/site/git/blobs":
            return {"sha": "blobsha"}
        if path == "/repos/acme/site/git/trees":
            return {"sha": "treesha"}
        if path == "/repos/acme/site/git/commits":
            return {"sha": "commitsha"}
        if path == "/repos/acme/site/git/refs":
            return {"ref": payload["ref"]}
        if path == "/repos/acme/site/pulls":
            assert "Proposed from Orcha Code Space by Octo-Cat." in payload["body"]
            return {"number": 1, "html_url": "https://github.com/acme/site/pull/1"}
        raise AssertionError(path)

    monkeypatch.setattr(edit, "_gh_post", fake_post)
    r = await client.post(
        f"/api/containers/{cid}/code/github/propose",
        json={"base_ref": None, "message": "hi",
              "files": [{"path": "a.py", "content": "x = 1\n"}]},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["branch"].startswith("codespace/octo-cat-")


# ------------------------- propose: conflict refusals -------------------------

async def test_propose_drift_refused_no_write_calls(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    _resolve_ref_via_default_branch(monkeypatch, existing={"a.py": "current-sha-123"})

    write_calls = []
    monkeypatch.setattr(edit, "_gh_post", lambda *a, **k: write_calls.append(a) or {})

    r = await client.post(
        f"/api/containers/{cid}/code/github/propose",
        json={"base_ref": None, "message": "edit a.py",
              "files": [{"path": "a.py", "content": "y = 2\n", "base_hash": "stale-sha"}]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {"available": True, "ok": False, "reason": "drift", "paths": ["a.py"]}
    assert write_calls == []


async def test_propose_null_base_hash_is_no_claim_over_existing_file(client, container, token_env, monkeypatch):
    """null base_hash = NO CLAIM about the base — accepted even over an existing
    path. The editor sends null whenever it has no blob sha for the loaded
    content (older cached payloads, "Reload base" fallback); refusing those as
    "exists" made every ordinary edit un-proposable. Real drift protection rides
    the blob_sha the browse/file payload now carries (base_hash set → compared)."""
    cid = container["id"]
    await _bind_repo(client, cid)
    _resolve_ref_via_default_branch(monkeypatch, existing={"new.py": "already-there-sha"})

    calls = []

    def fake_post(path, token, payload):
        calls.append((path, payload))
        if path.endswith("/git/blobs"):
            return {"sha": "blob0000sha"}
        if path.endswith("/git/trees"):
            return {"sha": "newtree0000sha"}
        if path.endswith("/git/commits"):
            return {"sha": "newcommit0000sha"}
        if path.endswith("/git/refs"):
            return {"ref": payload["ref"]}
        if path.endswith("/pulls"):
            return {"number": 9, "html_url": "https://github.com/acme/site/pull/9"}
        raise AssertionError(f"unexpected _gh_post path {path}")

    monkeypatch.setattr(edit, "_gh_post", fake_post)

    r = await client.post(
        f"/api/containers/{cid}/code/github/propose",
        json={"base_ref": None, "message": "edit new.py",
              "files": [{"path": "new.py", "content": "z = 3\n", "base_hash": None}]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True, body
    # the write sequence actually ran (blob → … → pull)
    assert any("/git/blobs" in c[0] for c in calls)
    assert any("/pulls" in c[0] for c in calls)


async def test_propose_matching_base_hash_not_flagged_as_drift(client, container, token_env, monkeypatch):
    """A base_hash that DOES match the base tree's current blob sha for that path is
    not a conflict — this is the ordinary "edit a known file" case."""
    cid = container["id"]
    await _bind_repo(client, cid)
    _resolve_ref_via_default_branch(monkeypatch, existing={"a.py": "matching-sha"})

    def fake_post(path, token, payload):
        if path == "/repos/acme/site/git/blobs":
            return {"sha": "newblob"}
        if path == "/repos/acme/site/git/trees":
            return {"sha": "newtree"}
        if path == "/repos/acme/site/git/commits":
            return {"sha": "newcommit"}
        if path == "/repos/acme/site/git/refs":
            return {"ref": payload["ref"]}
        if path == "/repos/acme/site/pulls":
            return {"number": 2, "html_url": "https://github.com/acme/site/pull/2"}
        raise AssertionError(path)

    monkeypatch.setattr(edit, "_gh_post", fake_post)
    r = await client.post(
        f"/api/containers/{cid}/code/github/propose",
        json={"base_ref": None, "message": "edit a.py",
              "files": [{"path": "a.py", "content": "y = 2\n", "base_hash": "matching-sha"}]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True


# ------------------------- propose: github error mid-sequence -------------------------

async def test_propose_github_error_mid_sequence_stops_before_ref_and_pr(
    client, container, token_env, monkeypatch,
):
    """A 422 on the tree POST -> ok:false github_error, and NO ref/PR calls happen
    after the failure (the blob call(s) before it are allowed to have happened)."""
    cid = container["id"]
    await _bind_repo(client, cid)
    _resolve_ref_via_default_branch(monkeypatch)

    calls = []

    def fake_post(path, token, payload):
        calls.append(path)
        if path == "/repos/acme/site/git/blobs":
            return {"sha": "blobsha"}
        if path == "/repos/acme/site/git/trees":
            raise RuntimeError("github_status:422:{\"message\":\"Validation failed\"}")
        raise AssertionError(f"should not reach {path}")

    monkeypatch.setattr(edit, "_gh_post", fake_post)
    r = await client.post(
        f"/api/containers/{cid}/code/github/propose",
        json={"base_ref": None, "message": "add a file",
              "files": [{"path": "a.py", "content": "x = 1\n"}]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert body["ok"] is False
    assert body["reason"] == "github_error"
    assert "422" in body["detail"]
    assert "/repos/acme/site/git/refs" not in calls
    assert "/repos/acme/site/pulls" not in calls


async def test_propose_github_error_on_base_resolution(client, container, token_env, monkeypatch):
    """A failure resolving the base ref/commit (before any conflict check or write
    call) also degrades to github_error, never a 5xx."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        raise RuntimeError("github_status:404")

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    write_calls = []
    monkeypatch.setattr(edit, "_gh_post", lambda *a, **k: write_calls.append(a) or {})

    r = await client.post(
        f"/api/containers/{cid}/code/github/propose",
        json={"base_ref": "some-branch", "message": "add a file",
              "files": [{"path": "a.py", "content": "x = 1\n"}]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    assert body["reason"] == "github_error"
    assert write_calls == []


async def test_propose_pr_open_failure_after_ref_created(client, container, token_env, monkeypatch):
    """A failure on the FINAL PR-open call still reports github_error even though the
    branch/ref was already created successfully (no rollback attempt)."""
    cid = container["id"]
    await _bind_repo(client, cid)
    _resolve_ref_via_default_branch(monkeypatch)

    def fake_post(path, token, payload):
        if path == "/repos/acme/site/git/blobs":
            return {"sha": "blobsha"}
        if path == "/repos/acme/site/git/trees":
            return {"sha": "treesha"}
        if path == "/repos/acme/site/git/commits":
            return {"sha": "commitsha"}
        if path == "/repos/acme/site/git/refs":
            return {"ref": payload["ref"]}
        if path == "/repos/acme/site/pulls":
            raise RuntimeError("github_status:422:{\"message\":\"no commits between main and branch\"}")
        raise AssertionError(path)

    monkeypatch.setattr(edit, "_gh_post", fake_post)
    r = await client.post(
        f"/api/containers/{cid}/code/github/propose",
        json={"base_ref": None, "message": "add a file",
              "files": [{"path": "a.py", "content": "x = 1\n"}]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    assert body["reason"] == "github_error"


async def test_propose_explicit_base_ref_used_as_pr_base(client, container, token_env, monkeypatch):
    """When base_ref names a real branch, the PR's base is that branch name (not the
    default branch)."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        # `_resolve_ref` passes a real branch name straight through UNCHANGED (never
        # resolved to a sha) — so `base_sha` here is literally "feature-x", and both
        # the commit and tree lookups are keyed on that ref name, not a sha.
        if path == "/repos/acme/site/git/commits/feature-x":
            return {"sha": "featurebasesha", "tree": {"sha": "featuretreesha"}}
        if path == "/repos/acme/site/git/trees/feature-x?recursive=1":
            return {"tree": [], "truncated": False}
        raise AssertionError(path)

    monkeypatch.setattr(browse, "_gh_get", fake_get)

    def fake_post(path, token, payload):
        if path == "/repos/acme/site/git/blobs":
            return {"sha": "blobsha"}
        if path == "/repos/acme/site/git/trees":
            assert payload["base_tree"] == "featuretreesha"
            return {"sha": "treesha"}
        if path == "/repos/acme/site/git/commits":
            # parents=[base_sha] uses the RESOLVED ref string ("feature-x"), not the
            # base commit object's own `sha` field — see the module docstring: the
            # route never re-fetches a sha from the commit object, it commits on top
            # of whatever `_resolve_ref` handed back.
            assert payload["parents"] == ["feature-x"]
            return {"sha": "commitsha"}
        if path == "/repos/acme/site/git/refs":
            return {"ref": payload["ref"]}
        if path == "/repos/acme/site/pulls":
            assert payload["base"] == "feature-x"
            return {"number": 9, "html_url": "https://github.com/acme/site/pull/9"}
        raise AssertionError(path)

    monkeypatch.setattr(edit, "_gh_post", fake_post)
    r = await client.post(
        f"/api/containers/{cid}/code/github/propose",
        json={"base_ref": "feature-x", "message": "add a file",
              "files": [{"path": "a.py", "content": "x = 1\n"}]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
