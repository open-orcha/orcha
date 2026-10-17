"""C01 / G05b / G13 / C18: a GitHub token saved ONLY in Settings (PUT
settings/github-pat, no ORCHA_GITHUB_PAT / App files) must drive every GitHub read and
write, not just the hub lists — Code Space browse (tree/file/search) and the
"Orcha started this" round-trip comment on Start. A bound repo with NO token reports
reason='no_token' (with the repo), never 'repo_not_connected'. A browse 404 is about the
repository / ref / path, never "issue or pull request".

Only network leaves are stubbed (`_gh_get` in the browse module, `_gh_post_comment`).
"""
import pytest

from portal_backend import github_repo_browse_routes as browse
from portal_backend import task_start_core as core

PAT = "ghp_SETTINGSONLY1234567890"


@pytest.fixture(autouse=True)
def _no_env_tokens(monkeypatch):
    for k in ("ORCHA_GITHUB_PAT", "ORCHA_GITHUB_TOKEN_FILE", "ORCHA_GITHUB_TOKENS_FILE"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()
    yield
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()


async def _setup(client, container, make_agent, *, save_pat=True):
    hid = (await make_agent("Operator", kind="human"))["agent_id"]
    cid = container["id"]
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/orcha-web"})
    assert r.status_code == 200, r.text
    if save_pat:
        r = await client.put(f"/api/containers/{cid}/settings/github-pat",
                             json={"actor_agent_id": hid, "token": PAT})
        assert r.status_code == 200, r.text
    return cid


def _fake_github(monkeypatch, seen):
    def fake(path, token):
        seen.append((path, token))
        if path == "/repos/acme/orcha-web":
            return {"default_branch": "main"}
        if path.startswith("/repos/acme/orcha-web/contents/README.md"):
            return {"type": "file", "name": "README.md", "path": "README.md", "size": 3,
                    "encoding": "base64", "content": "aGkK"}
        if path.startswith("/repos/acme/orcha-web/contents"):
            return [{"type": "file", "name": "README.md", "path": "README.md", "size": 3}]
        if path.startswith("/repos/acme/orcha-web/git/trees/"):
            return {"tree": [{"type": "blob", "path": "README.md", "size": 3}], "truncated": False}
        raise RuntimeError("github_status:404")
    monkeypatch.setattr(browse, "_gh_get", fake)


async def test_browse_uses_settings_saved_token(client, container, make_agent, monkeypatch):
    cid = await _setup(client, container, make_agent)
    seen = []
    _fake_github(monkeypatch, seen)
    tree = (await client.get(f"/api/containers/{cid}/github/browse/tree")).json()
    assert tree.get("available", True) is not False, tree
    assert [e["name"] for e in tree["entries"]] == ["README.md"]
    f = (await client.get(f"/api/containers/{cid}/github/browse/file", params={"path": "README.md"})).json()
    assert f.get("available", True) is not False and f["content"] == "hi\n", f
    s = (await client.get(f"/api/containers/{cid}/github/browse/search", params={"q": "READ"})).json()
    assert s.get("reason") != "repo_not_connected" and s.get("reason") != "no_token", s
    assert seen and all(tok == PAT for _, tok in seen)


async def test_bound_repo_without_token_says_no_token(client, container, make_agent):
    cid = await _setup(client, container, make_agent, save_pat=False)
    for url, params in (("browse/tree", {}), ("browse/file", {"path": "a.py"}),
                        ("browse/search", {"q": "x"}), ("issues", {}), ("pulls", {})):
        body = (await client.get(f"/api/containers/{cid}/github/{url}", params=params)).json()
        assert body["available"] is False and body["reason"] == "no_token", (url, body)
        assert body["repo"] == "acme/orcha-web"


async def test_browse_404_is_about_the_repository(client, container, make_agent, monkeypatch):
    cid = await _setup(client, container, make_agent)
    monkeypatch.setattr(browse, "_gh_get", lambda p, t: (_ for _ in ()).throw(RuntimeError("github_status:404")))
    body = (await client.get(f"/api/containers/{cid}/github/browse/tree", params={"ref": "main"})).json()
    assert body["reason"] == "not_found"
    assert "issue or pull request" not in body["detail"] and "repository" in body["detail"]


async def test_start_posts_round_trip_comment_with_settings_token(client, container, make_agent, monkeypatch):
    cid = await _setup(client, container, make_agent)
    calls = []
    monkeypatch.setattr(core, "_gh_post_comment",
                        lambda repo, number, token, body: calls.append((repo, number, token)))
    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 12, "title": "Fix login"})
    assert r.status_code == 201, r.text
    assert calls == [("acme/orcha-web", 12, PAT)]
