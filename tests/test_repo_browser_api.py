"""GitHub-backed repository file browser (tree/file/search) — read-only, gated exactly
like the GitHub hub (github_hub_routes.py). Per the test-teeth convention, the ONLY
thing stubbed is the network leaf (`github_repo_browse_routes._gh_get`, and for the
snapshot/tarball path, `_download_tarball_bytes` — a separate raw-bytes leaf) plus the
installation-token file read — the routes, grant gate, ref resolution, caching, and
error classification all run for real. Mirrors test_github_hub_routes.py's fixtures
and fake-GitHub-response idioms.
"""
import io
import tarfile
import uuid

import pytest

from portal_backend import github_repo_browse_routes as browse


@pytest.fixture(autouse=True)
def _clear_caches():
    """The tree/default-branch/snapshot caches are plain module dicts — reset around
    every test so one test's cached payload never leaks into the next (mirrors the
    hub's _clear_cache fixture)."""
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()
    browse._REPO_SNAPSHOT_CACHE.clear()
    browse._REPO_SNAPSHOT_ORDER.clear()
    yield
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()
    browse._REPO_SNAPSHOT_CACHE.clear()
    browse._REPO_SNAPSHOT_ORDER.clear()


def _make_tarball(files: dict, top_prefix: str = "acme-site-abc1234") -> bytes:
    """A real in-memory gzip tarball (tarfile.open on BytesIO), each `files` entry
    nested under `top_prefix/` — the same synthetic top-level directory shape GitHub's
    own tarball archives use."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for path, content in files.items():
            data = content if isinstance(content, bytes) else content.encode("utf-8")
            info = tarfile.TarInfo(name=f"{top_prefix}/{path}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


@pytest.fixture
def token_env(monkeypatch, tmp_path):
    """Wire a legacy single installation-token file so _resolve_repo_token yields a
    token (the multi-org map is absent). Identical to the hub tests' fixture."""
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_hubtoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    return "ghs_hubtoken"


async def _bind_repo(client, cid, repo="acme/site"):
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": repo})
    assert r.status_code == 200, r.text


# ------------------------- repo not connected / bad cid -------------------------

async def test_tree_repo_not_connected(client, container):
    r = await client.get(f"/api/containers/{container['id']}/github/browse/tree")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is False and body["reason"] == "repo_not_connected"


async def test_file_repo_not_connected(client, container):
    r = await client.get(
        f"/api/containers/{container['id']}/github/browse/file", params={"path": "a.py"})
    assert r.status_code == 200
    assert r.json()["reason"] == "repo_not_connected"


async def test_search_repo_not_connected(client, container):
    r = await client.get(
        f"/api/containers/{container['id']}/github/browse/search", params={"q": "x"})
    assert r.status_code == 200
    assert r.json()["reason"] == "repo_not_connected"


async def test_tree_bad_cid_400_and_unknown_404(client):
    r = await client.get("/api/containers/not-a-uuid/github/browse/tree")
    assert r.status_code == 400
    r = await client.get(f"/api/containers/{uuid.uuid4()}/github/browse/tree")
    assert r.status_code == 404


# ------------------------- tree: one directory level -------------------------

async def test_tree_default_branch_lists_directory(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []

    def fake_get(path, token):
        calls.append(path)
        assert token == "ghs_hubtoken"
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        if path.startswith("/repos/acme/site/contents?ref=main"):
            return [
                {"name": "src", "path": "src", "type": "dir"},
                {"name": "README.md", "path": "README.md", "type": "file", "size": 123},
            ]
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/browse/tree")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ref"] == "main"
    assert body["path"] == ""
    assert body["truncated"] is False
    # dirs sorted before files, alphabetically within each group
    assert body["entries"] == [
        {"name": "src", "path": "src", "type": "dir"},
        {"name": "README.md", "path": "README.md", "type": "file", "size": 123},
    ]


async def test_tree_explicit_ref_and_path(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path.startswith("/repos/acme/site/contents/src?ref=feat-x"):
            return [{"name": "main.py", "path": "src/main.py", "type": "file", "size": 10}]
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/tree",
        params={"ref": "feat-x", "path": "src"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ref"] == "feat-x"
    assert body["path"] == "src"
    assert body["entries"] == [{"name": "main.py", "path": "src/main.py", "type": "file", "size": 10}]


async def test_tree_pr_ref_resolves_to_head_sha(client, container, token_env, monkeypatch):
    """ref=pr/<number> resolves to that PR's head sha via the same /pulls/{number}
    fetch idiom github_hub_routes' PR-detail route uses, BEFORE the contents call."""
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []

    def fake_get(path, token):
        calls.append(path)
        if path == "/repos/acme/site/pulls/42":
            return {"number": 42, "head": {"sha": "deadbeef123"}}
        if path.startswith("/repos/acme/site/contents?ref=deadbeef123"):
            return [{"name": "a.py", "path": "a.py", "type": "file", "size": 5}]
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/tree", params={"ref": "pr/42"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ref"] == "deadbeef123"
    assert any(c == "/repos/acme/site/pulls/42" for c in calls)


async def test_tree_pr_ref_not_found_404(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        raise RuntimeError("github_status:404")

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/tree", params={"ref": "pr/999"})
    assert r.status_code == 200
    assert r.json()["reason"] == "not_found"


async def test_tree_bad_pr_ref_400(client, container, token_env):
    cid = container["id"]
    await _bind_repo(client, cid)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/tree", params={"ref": "pr/notanumber"})
    assert r.status_code == 400


async def test_tree_path_is_a_file_400(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        # GitHub returns a single dict (not a list) when `path` names a file.
        return {"name": "a.py", "path": "a.py", "type": "file", "size": 3}

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/tree", params={"path": "a.py"})
    assert r.status_code == 400


async def test_tree_default_branch_cached(client, container, token_env, monkeypatch):
    """The default-branch resolution is cached — two ref-less tree requests only fetch
    /repos/{repo} once."""
    cid = container["id"]
    await _bind_repo(client, cid)
    repo_calls = {"n": 0}

    def fake_get(path, token):
        if path == "/repos/acme/site":
            repo_calls["n"] += 1
            return {"default_branch": "main"}
        return []

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    await client.get(f"/api/containers/{cid}/github/browse/tree")
    await client.get(f"/api/containers/{cid}/github/browse/tree")
    assert repo_calls["n"] == 1


# ------------------------- file: content cap + binary -------------------------

async def test_file_returns_decoded_content(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    content = "print('hi')\n"

    def fake_get(path, token):
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        assert path.startswith("/repos/acme/site/contents/src/a.py?ref=main")
        return {
            "size": len(content.encode("utf-8")),
            "encoding": "base64",
            "content": _b64_sync(content),
        }

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/file", params={"path": "src/a.py"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ref"] == "main"
    assert body["path"] == "src/a.py"
    assert body["content"] == content
    assert body["truncated"] is False
    assert body["binary"] is False
    assert body["encoding"] == "utf-8"


def _b64_sync(text: str) -> str:
    import base64
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


async def test_file_missing_path_422(client, container):
    cid = container["id"]
    r = await client.get(f"/api/containers/{cid}/github/browse/file")
    assert r.status_code == 422


async def test_file_cap_truncates_large_content(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    big_text = "a" * (browse.FILE_CONTENT_CAP_BYTES + 1000)

    def fake_get(path, token):
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        return {"size": len(big_text), "encoding": "base64", "content": _b64_sync(big_text)}

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/file", params={"path": "big.txt"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["truncated"] is True
    assert len(body["content"]) == browse.FILE_CONTENT_CAP_BYTES
    assert body["binary"] is False


async def test_file_binary_via_nul_byte_sniff(client, container, token_env, monkeypatch):
    """A file that decodes fine as base64 but whose bytes contain a NUL is flagged
    binary with NO content field."""
    cid = container["id"]
    await _bind_repo(client, cid)
    binary_bytes = b"\x89PNG\x00\x01\x02"

    def fake_get(path, token):
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        import base64
        return {
            "size": len(binary_bytes), "encoding": "base64",
            "content": base64.b64encode(binary_bytes).decode("ascii"),
        }

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/file", params={"path": "logo.png"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["binary"] is True
    assert "content" not in body
    assert body["size"] == len(binary_bytes)


async def test_file_binary_via_non_base64_encoding(client, container, token_env, monkeypatch):
    """GitHub omits/varies encoding+content for files too large/non-inline-able for the
    contents API — treated as binary-shaped rather than a crash."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        return {"size": 999999, "encoding": "none"}

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/file", params={"path": "huge.bin"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["binary"] is True
    assert "content" not in body


async def test_file_path_is_a_directory_400(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        return [{"name": "a.py", "path": "src/a.py", "type": "file"}]

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/file", params={"path": "src"})
    assert r.status_code == 400


async def test_file_pr_ref_resolution(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path == "/repos/acme/site/pulls/7":
            return {"number": 7, "head": {"sha": "cafef00d"}}
        if path.startswith("/repos/acme/site/contents/a.py?ref=cafef00d"):
            return {"size": 5, "encoding": "base64", "content": _b64_sync("hello")}
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/file",
        params={"path": "a.py", "ref": "pr/7"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["ref"] == "cafef00d"
    assert r.json()["content"] == "hello"


# ------------------------- search: names -------------------------

async def test_search_names_filters_case_insensitively(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []

    def fake_get(path, token):
        calls.append(path)
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        if path == "/repos/acme/site/git/trees/main?recursive=1":
            return {
                "tree": [
                    {"path": "src/Main.py", "type": "blob"},
                    {"path": "src/utils.py", "type": "blob"},
                    {"path": "docs", "type": "tree"},
                    {"path": "README.md", "type": "blob"},
                ],
                "truncated": False,
            }
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/search",
        params={"q": "main", "mode": "names"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ref"] == "main"
    assert body["truncated"] is False
    paths = {e["path"] for e in body["results"]}
    assert paths == {"src/Main.py"}
    assert body["results"][0]["type"] == "file"


async def test_search_names_caps_at_200_results(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        return {
            "tree": [{"path": f"file{i}.txt", "type": "blob"} for i in range(500)],
            "truncated": False,
        }

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/search",
        params={"q": "file", "mode": "names"},
    )
    assert r.status_code == 200, r.text
    assert len(r.json()["results"]) == browse.NAMES_SEARCH_MAX_RESULTS


async def test_search_names_flags_truncated_tree(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        return {"tree": [{"path": "a.py", "type": "blob"}], "truncated": True}

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/search",
        params={"q": "a", "mode": "names"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["truncated"] is True


async def test_search_names_tree_cached_60s(client, container, token_env, monkeypatch):
    """The full recursive tree fetch is cached per (cid, ref) for 60s — a second
    search-as-you-type keystroke against the same ref doesn't refire the heavy
    recursive fetch."""
    cid = container["id"]
    await _bind_repo(client, cid)
    tree_calls = {"n": 0}

    def fake_get(path, token):
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        if path == "/repos/acme/site/git/trees/main?recursive=1":
            tree_calls["n"] += 1
            return {"tree": [{"path": "a.py", "type": "blob"},
                              {"path": "b.py", "type": "blob"}], "truncated": False}
        raise AssertionError(path)

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    await client.get(f"/api/containers/{cid}/github/browse/search",
                     params={"q": "a", "mode": "names"})
    await client.get(f"/api/containers/{cid}/github/browse/search",
                     params={"q": "b", "mode": "names"})
    assert tree_calls["n"] == 1

    # Past the TTL, GitHub is hit again.
    base = browse.time.monotonic()
    monkeypatch.setattr(browse.time, "monotonic", lambda: base + browse.TREE_CACHE_TTL_SECONDS + 1)
    await client.get(f"/api/containers/{cid}/github/browse/search",
                     params={"q": "a", "mode": "names"})
    assert tree_calls["n"] == 2


async def test_search_names_pr_ref(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path == "/repos/acme/site/pulls/3":
            return {"number": 3, "head": {"sha": "sha3"}}
        if path == "/repos/acme/site/git/trees/sha3?recursive=1":
            return {"tree": [{"path": "x.py", "type": "blob"}], "truncated": False}
        raise AssertionError(path)

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/search",
        params={"q": "x", "mode": "names", "ref": "pr/3"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["ref"] == "sha3"


async def test_search_bad_mode_400(client, container, token_env):
    cid = container["id"]
    await _bind_repo(client, cid)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/search", params={"q": "x", "mode": "bogus"})
    assert r.status_code == 400


async def test_search_missing_q_422(client, container):
    cid = container["id"]
    r = await client.get(f"/api/containers/{cid}/github/browse/search")
    assert r.status_code == 422


# ------------------------- search: contents (code search) -------------------------

async def test_search_contents_maps_results(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []

    def fake_get(path, token):
        calls.append(path)
        assert path.startswith("/search/code?q=")
        assert "repo%3Aacme%2Fsite" in path or "repo:acme/site" in path
        return {
            "items": [
                {
                    "path": "src/a.py",
                    "text_matches": [
                        {"fragment": "def foo():\n    return needle\n",
                         "matches": [{"indices": [16, 22]}]},
                    ],
                },
            ],
        }

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/search",
        params={"q": "needle", "mode": "contents"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["default_branch_only"] is True
    assert body["results"] == [
        {"path": "src/a.py", "matches": [{"line": 2, "text": "def foo():\n    return needle\n"}]},
    ]
    assert len(calls) == 1


async def test_search_contents_caps_at_50_results(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        return {"items": [
            {"path": f"f{i}.py", "text_matches": []} for i in range(200)
        ]}

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/search",
        params={"q": "x", "mode": "contents"},
    )
    assert r.status_code == 200, r.text
    assert len(r.json()["results"]) == browse.CONTENTS_SEARCH_MAX_RESULTS


async def test_search_contents_ignores_ref(client, container, token_env, monkeypatch):
    """Code search never resolves `ref` via the PR/default-branch machinery — it's
    always GitHub's own default-branch-only index, so passing ref=pr/N must NOT
    trigger a /pulls fetch."""
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = []

    def fake_get(path, token):
        calls.append(path)
        return {"items": []}

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/search",
        params={"q": "x", "mode": "contents", "ref": "pr/5"},
    )
    assert r.status_code == 200, r.text
    assert all("/pulls/" not in c for c in calls)


# ------------------------- error ladder: not_connected / rate_limited / not_found ------

async def test_tree_rate_limited_403(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        raise RuntimeError("github_status:403")

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/browse/tree")
    assert r.status_code == 200
    assert r.json()["reason"] == "rate_limited"


async def test_file_rate_limited_403(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        raise RuntimeError("github_status:403")

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/file", params={"path": "a.py"})
    assert r.status_code == 200
    assert r.json()["reason"] == "rate_limited"


async def test_search_names_rate_limited_403(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        raise RuntimeError("github_status:403")

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/search",
        params={"q": "x", "mode": "names"},
    )
    assert r.status_code == 200
    assert r.json()["reason"] == "rate_limited"


async def test_search_contents_rate_limited_403(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        raise RuntimeError("github_status:403")

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/search",
        params={"q": "x", "mode": "contents"},
    )
    assert r.status_code == 200
    assert r.json()["reason"] == "rate_limited"


async def test_file_404_reads_as_not_found(client, container, token_env, monkeypatch):
    """A GitHub 404 for a specific file path is a not_found (the file/ref doesn't
    exist) — distinct from the whole-repo not_connected reading, mirroring the hub's
    detail-route 404 semantics (_detail_error_payload)."""
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        raise RuntimeError("github_status:404")

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/file", params={"path": "nope.py"})
    assert r.status_code == 200
    assert r.json()["reason"] == "not_found"


async def test_tree_404_reads_as_not_found(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        raise RuntimeError("github_status:404")

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/tree", params={"path": "nope"})
    assert r.status_code == 200
    assert r.json()["reason"] == "not_found"


# ------------------------- membership gating (trusted proxy lane) -------------------------

MALLORY = {"X-Auth-Request-User": "mallory"}
OCTO = {"X-Auth-Request-User": "octocat"}


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


async def _bind_owner(client, container, make_agent):
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    return r.json()["identity"]


async def test_tree_trusted_non_member_403(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/tree", headers=MALLORY)
    assert r.status_code == 403, r.text


async def test_file_trusted_non_member_403(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/file",
        params={"path": "a.py"}, headers=MALLORY)
    assert r.status_code == 403, r.text


async def test_search_trusted_non_member_403(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/search",
        params={"q": "x"}, headers=MALLORY)
    assert r.status_code == 403, r.text


async def test_tree_trusted_member_ok(client, container, make_agent, trust_proxy, token_env, monkeypatch):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path == "/repos/acme/site":
            return {"default_branch": "main"}
        return []

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    r = await client.get(
        f"/api/containers/{cid}/github/browse/tree", headers=OCTO)
    assert r.status_code == 200, r.text


# ============================ repo snapshot (tarball) cache ============================
#
# `_fetch_repo_snapshot` / `_download_tarball_bytes` / `_extract_source_files` have no
# route of their own yet (only code_space_routes' symbol indexer calls them) — these are
# direct unit-style tests of the browse module's own helpers, calling them exactly as
# code_space_routes does: `_fetch_repo_snapshot(repo, ref, token, cid, extensions, cap)`.

def test_extract_source_files_keeps_only_matching_extensions_under_cap():
    tarball = _make_tarball({
        "a.py": "x = 1\n",
        "README.md": "# not source\n",
        "big.py": "x" * 50,
    })
    files = browse._extract_source_files(tarball, (".py",), max_file_bytes=10)
    # big.py exceeds the 10-byte cap -> dropped; README.md isn't a matching extension.
    assert files == {"a.py": b"x = 1\n"}


def test_extract_source_files_strips_top_level_prefix():
    tarball = _make_tarball({"src/a.py": "x = 1\n"}, top_prefix="acme-site-0123abcd")
    files = browse._extract_source_files(tarball, (".py",), max_file_bytes=1000)
    assert files == {"src/a.py": b"x = 1\n"}


def test_extract_source_files_filters_traversal_and_absolute_members():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        good = b"def safe():\n    pass\n"
        info = tarfile.TarInfo(name="acme-site-abc1234/a.py")
        info.size = len(good)
        tar.addfile(info, io.BytesIO(good))

        evil = b"pwned"
        for evil_name in (
            "acme-site-abc1234/../../etc/evil.py",
            "../escape.py",
            "/etc/absolute.py",
        ):
            info = tarfile.TarInfo(name=evil_name)
            info.size = len(evil)
            tar.addfile(info, io.BytesIO(evil))
    tarball = buf.getvalue()

    files = browse._extract_source_files(tarball, (".py",), max_file_bytes=1000)
    assert files == {"a.py": good}
    assert not any("evil" in p or "escape" in p or "absolute" in p for p in files)


def test_extract_source_files_skips_symlink_members():
    """A symlink member's `name` could look like a perfectly ordinary path while its
    LINK TARGET is attacker-controlled — `_safe_tar_members` only yields regular files
    (`member.isfile()`), so a symlink is dropped outright regardless of its name."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        link = tarfile.TarInfo(name="acme-site-abc1234/link.py")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        tar.addfile(link)
    tarball = buf.getvalue()

    files = browse._extract_source_files(tarball, (".py",), max_file_bytes=1000)
    assert files == {}


def test_fetch_repo_snapshot_happy_path_caches_and_reuses(monkeypatch):
    tarball = _make_tarball({"a.py": "def fn():\n    pass\n"})
    calls = {"n": 0}

    def fake_download(repo, resolved_ref, token):
        calls["n"] += 1
        return tarball

    monkeypatch.setattr(browse, "_download_tarball_bytes", fake_download)
    files = browse._fetch_repo_snapshot("acme/site", "main", "tok", "cid-1", (".py",), 1000)
    assert files == {"a.py": b"def fn():\n    pass\n"}
    assert calls["n"] == 1

    # Second call within TTL reuses the cache — no second download.
    again = browse._fetch_repo_snapshot("acme/site", "main", "tok", "cid-1", (".py",), 1000)
    assert again == files
    assert calls["n"] == 1


def test_fetch_repo_snapshot_oversize_download_returns_none_never_caches(monkeypatch):
    monkeypatch.setattr(browse, "_download_tarball_bytes", lambda *a, **k: None)
    result = browse._fetch_repo_snapshot("acme/site", "main", "tok", "cid-2", (".py",), 1000)
    assert result is None
    assert browse._repo_snapshot_cache_get("cid-2", "main") is None


class _FakeResponse:
    """Mimics `urlopen`'s context-manager response object closely enough to exercise
    `_download_tarball_bytes`'s own bounded `response.read(cap + 1)` call for real —
    `full_body` is what a `read(n)` would return for that many bytes, exactly like a
    real HTTP body being read incrementally."""

    def __init__(self, full_body: bytes):
        self._body = full_body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, n=-1):
        if n is None or n < 0:
            return self._body
        return self._body[:n]


def test_download_tarball_bytes_reads_within_cap(monkeypatch):
    body = b"x" * 100
    monkeypatch.setattr(browse, "REPO_SNAPSHOT_MAX_BYTES", 1000)
    monkeypatch.setattr(browse.urllib.request, "urlopen", lambda *a, **k: _FakeResponse(body))
    data = browse._download_tarball_bytes("acme/site", "main", "tok")
    assert data == body


def test_download_tarball_bytes_over_cap_returns_none(monkeypatch):
    """A body strictly larger than REPO_SNAPSHOT_MAX_BYTES must come back as None (the
    "too big, fall back" signal) — never a silently-truncated partial tarball, which
    `tarfile` would fail to parse anyway but in a much less honest way."""
    monkeypatch.setattr(browse, "REPO_SNAPSHOT_MAX_BYTES", 100)
    body = b"x" * 101
    monkeypatch.setattr(browse.urllib.request, "urlopen", lambda *a, **k: _FakeResponse(body))
    data = browse._download_tarball_bytes("acme/site", "main", "tok")
    assert data is None


def test_download_tarball_bytes_exactly_at_cap_is_kept(monkeypatch):
    monkeypatch.setattr(browse, "REPO_SNAPSHOT_MAX_BYTES", 100)
    body = b"x" * 100
    monkeypatch.setattr(browse.urllib.request, "urlopen", lambda *a, **k: _FakeResponse(body))
    data = browse._download_tarball_bytes("acme/site", "main", "tok")
    assert data == body


def test_repo_snapshot_cache_evicts_oldest_beyond_max_cached(monkeypatch):
    tarball = _make_tarball({"a.py": "def fn():\n    pass\n"})
    monkeypatch.setattr(browse, "_download_tarball_bytes", lambda *a, **k: tarball)

    assert browse.REPO_SNAPSHOT_MAX_CACHED == 2
    browse._fetch_repo_snapshot("acme/site", "ref-1", "tok", "cid-evict", (".py",), 1000)
    browse._fetch_repo_snapshot("acme/site", "ref-2", "tok", "cid-evict", (".py",), 1000)
    browse._fetch_repo_snapshot("acme/site", "ref-3", "tok", "cid-evict", (".py",), 1000)

    assert browse._repo_snapshot_cache_get("cid-evict", "ref-1") is None  # evicted
    assert browse._repo_snapshot_cache_get("cid-evict", "ref-2") is not None
    assert browse._repo_snapshot_cache_get("cid-evict", "ref-3") is not None
    assert len(browse._REPO_SNAPSHOT_ORDER) == browse.REPO_SNAPSHOT_MAX_CACHED


def test_repo_snapshot_cache_keyed_per_cid_and_ref(monkeypatch):
    """Two different containers bound to the same ref name get independent snapshot
    cache entries — the key is (cid, ref), not ref alone."""
    tarball_a = _make_tarball({"a.py": "def from_a():\n    pass\n"})
    tarball_b = _make_tarball({"a.py": "def from_b():\n    pass\n"})

    monkeypatch.setattr(browse, "_download_tarball_bytes", lambda *a, **k: tarball_a)
    files_a = browse._fetch_repo_snapshot("acme/site", "main", "tok", "cid-a", (".py",), 1000)

    monkeypatch.setattr(browse, "_download_tarball_bytes", lambda *a, **k: tarball_b)
    files_b = browse._fetch_repo_snapshot("acme/site", "main", "tok", "cid-b", (".py",), 1000)

    assert files_a == {"a.py": b"def from_a():\n    pass\n"}
    assert files_b == {"a.py": b"def from_b():\n    pass\n"}


def test_fetch_repo_snapshot_ttl_expiry_refetches(monkeypatch):
    tarball = _make_tarball({"a.py": "def fn():\n    pass\n"})
    calls = {"n": 0}

    def fake_download(repo, resolved_ref, token):
        calls["n"] += 1
        return tarball

    monkeypatch.setattr(browse, "_download_tarball_bytes", fake_download)
    browse._fetch_repo_snapshot("acme/site", "main", "tok", "cid-ttl", (".py",), 1000)
    assert calls["n"] == 1

    base = browse.time.monotonic()
    monkeypatch.setattr(browse.time, "monotonic", lambda: base + browse.REPO_SNAPSHOT_TTL_SECONDS + 1)
    browse._fetch_repo_snapshot("acme/site", "main", "tok", "cid-ttl", (".py",), 1000)
    assert calls["n"] == 2


def test_download_tarball_bytes_maps_http_error_to_github_status(monkeypatch):
    """`_download_tarball_bytes` raises the SAME RuntimeError("github_status:<code>")
    contract `_gh_get` uses, so callers can reuse the existing error-payload mapping
    without a parallel error ladder for the tarball leaf."""
    import urllib.error

    class _FakeHTTPError(urllib.error.HTTPError):
        def __init__(self):
            super().__init__("url", 403, "forbidden", {}, None)

    def fake_urlopen(*a, **k):
        raise _FakeHTTPError()

    monkeypatch.setattr(browse.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(RuntimeError, match="github_status:403"):
        browse._download_tarball_bytes("acme/site", "main", "tok")
