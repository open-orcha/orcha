"""Per-container GitHub personal access token — Orcha Cloud local run gap #1 (GitHub
access without the App). Covers:

  * CRUD + masking on GET/PUT/DELETE .../settings/github-pat (mirrors test_provider_keys.py)
  * env override (ORCHA_GITHUB_PAT) shadowing the stored token
  * POST .../settings/github-pat/test (network leaf stubbed, per the test-teeth convention
    the other github tests use — never live GitHub)
  * token resolution precedence: token map / legacy token file (App) beat the PAT; the PAT
    is used only when no App source resolves
  * GET /api/github/repos PAT fallback: listing shape + "source" field

Per the test-teeth convention, only the network leaves
(`github_pat_routes._test_pat`, `github_routes._fetch_installation_repos`,
`github_routes._fetch_user_repos`, `github_hub_routes._gh_get`) are stubbed — routes,
schema validation, grants, and token-file/DB reads all run for real.
"""
import urllib.error

import pytest

from portal_backend import github_hub_routes, github_pat_routes, github_routes

PAT = "ghp_EXAMPLE1234567890abcd"


async def _human(make_agent):
    h = await make_agent("Operator", kind="human")
    return h["agent_id"]


async def _ai(make_agent):
    a = await make_agent("Bot", kind="ai")
    return a["agent_id"]


# ---------- GET/PUT/DELETE CRUD + masking ----------

async def test_get_unconfigured(client, container, monkeypatch):
    monkeypatch.delenv("ORCHA_GITHUB_PAT", raising=False)
    r = await client.get(f"/api/containers/{container['id']}/settings/github-pat")
    assert r.status_code == 200, r.text
    assert r.json() == {"configured": False, "source": None, "masked": None, "set_at": None}


async def test_put_then_get_round_trip(client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_GITHUB_PAT", raising=False)
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    cid = container["id"]
    r = await client.put(f"/api/containers/{cid}/settings/github-pat",
                         json={"actor_agent_id": hid, "token": PAT})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] is True
    assert body["source"] == "db"
    assert body["masked"] == "ghp_...abcd"
    # the plaintext never rides the response
    assert PAT not in r.text

    got = await client.get(f"/api/containers/{cid}/settings/github-pat")
    assert got.status_code == 200, got.text
    gbody = got.json()
    assert gbody["configured"] is True and gbody["source"] == "db"
    assert gbody["masked"] == "ghp_...abcd"
    assert gbody["set_at"] is not None


async def test_put_replaces_not_appends(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/settings/github-pat",
                     json={"actor_agent_id": hid, "token": PAT})
    r = await client.put(f"/api/containers/{cid}/settings/github-pat",
                         json={"actor_agent_id": hid, "token": "ghp_SECOND0000wxyz"})
    assert r.status_code == 200, r.text
    assert r.json()["masked"] == "ghp_...wxyz"
    got = await client.get(f"/api/containers/{cid}/settings/github-pat")
    assert got.json()["masked"] == "ghp_...wxyz"


async def test_put_requires_human(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    aid = await _ai(make_agent)
    r = await client.put(f"/api/containers/{container['id']}/settings/github-pat",
                         json={"actor_agent_id": aid, "token": PAT})
    assert r.status_code == 403, r.text


async def test_put_blank_token_400(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    r = await client.put(f"/api/containers/{container['id']}/settings/github-pat",
                         json={"actor_agent_id": hid, "token": "   "})
    assert r.status_code == 400, r.text


async def test_put_without_master_key_503(client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_SECRET_KEY", raising=False)
    monkeypatch.delenv("ORCHA_GITHUB_PAT", raising=False)
    hid = await _human(make_agent)
    r = await client.put(f"/api/containers/{container['id']}/settings/github-pat",
                         json={"actor_agent_id": hid, "token": PAT})
    assert r.status_code == 503, r.text


async def test_delete_clears_stored_token(client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_GITHUB_PAT", raising=False)
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/settings/github-pat",
                     json={"actor_agent_id": hid, "token": PAT})
    d = await client.request("DELETE", f"/api/containers/{cid}/settings/github-pat",
                             json={"actor_agent_id": hid})
    assert d.status_code == 200, d.text
    assert d.json() == {"configured": False, "source": None, "masked": None}
    got = await client.get(f"/api/containers/{cid}/settings/github-pat")
    assert got.json()["configured"] is False


async def test_delete_requires_human(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    aid = await _ai(make_agent)
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/settings/github-pat",
                     json={"actor_agent_id": hid, "token": PAT})
    d = await client.request("DELETE", f"/api/containers/{cid}/settings/github-pat",
                             json={"actor_agent_id": aid})
    assert d.status_code == 403, d.text


async def test_unknown_container_404(client):
    import uuid
    cid = str(uuid.uuid4())
    r = await client.get(f"/api/containers/{cid}/settings/github-pat")
    assert r.status_code == 404, r.text
    r = await client.get("/api/containers/not-a-uuid/settings/github-pat")
    assert r.status_code == 400, r.text


# ---------- env override shadowing ----------

async def test_env_override_shadows_stored_token(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/settings/github-pat",
                     json={"actor_agent_id": hid, "token": PAT})
    monkeypatch.setenv("ORCHA_GITHUB_PAT", "ghp_ENVOVERRIDE0009999")
    got = await client.get(f"/api/containers/{cid}/settings/github-pat")
    body = got.json()
    assert body["configured"] is True
    assert body["source"] == "env"
    assert body["masked"] == "ghp_...9999"
    assert body["set_at"] is None


async def test_delete_falls_back_to_env_after_clearing_db(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/settings/github-pat",
                     json={"actor_agent_id": hid, "token": PAT})
    monkeypatch.setenv("ORCHA_GITHUB_PAT", "ghp_ENVOVERRIDE0009999")
    d = await client.request("DELETE", f"/api/containers/{cid}/settings/github-pat",
                             json={"actor_agent_id": hid})
    assert d.status_code == 200, d.text
    body = d.json()
    assert body["configured"] is True and body["source"] == "env"
    assert body["masked"] == "ghp_...9999"


# ---------- POST .../github-pat/test (network leaf stubbed) ----------

async def test_test_route_ok_with_candidate_token(client, container, make_agent, monkeypatch):
    hid = await _human(make_agent)

    def fake_test(token):
        assert token == PAT
        return {"ok": True, "login": "octocat", "scopes": ["repo", "read:org"]}

    monkeypatch.setattr(github_pat_routes, "_test_pat", fake_test)
    r = await client.post(f"/api/containers/{container['id']}/settings/github-pat/test",
                          json={"actor_agent_id": hid, "token": PAT})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["login"] == "octocat"
    assert body["scopes"] == ["repo", "read:org"]


async def test_test_route_bad_token(client, container, make_agent, monkeypatch):
    hid = await _human(make_agent)
    monkeypatch.setattr(
        github_pat_routes, "_test_pat",
        lambda token: {"ok": False, "detail": "GitHub rejected this token (401 — invalid or expired)"},
    )
    r = await client.post(f"/api/containers/{container['id']}/settings/github-pat/test",
                          json={"actor_agent_id": hid, "token": "bad"})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is False


async def test_test_route_uses_stored_token_when_none_supplied(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/settings/github-pat",
                     json={"actor_agent_id": hid, "token": PAT})
    seen = {}

    def fake_test(token):
        seen["token"] = token
        return {"ok": True, "login": "octocat"}

    monkeypatch.setattr(github_pat_routes, "_test_pat", fake_test)
    r = await client.post(f"/api/containers/{cid}/settings/github-pat/test",
                          json={"actor_agent_id": hid})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    assert seen["token"] == PAT


async def test_test_route_nothing_to_test(client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_GITHUB_PAT", raising=False)
    hid = await _human(make_agent)
    r = await client.post(f"/api/containers/{container['id']}/settings/github-pat/test",
                          json={"actor_agent_id": hid})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is False


async def test_test_route_requires_human(client, container, make_agent, monkeypatch):
    aid = await _ai(make_agent)
    r = await client.post(f"/api/containers/{container['id']}/settings/github-pat/test",
                          json={"actor_agent_id": aid, "token": PAT})
    assert r.status_code == 403, r.text


def test_test_pat_maps_401_to_honest_detail(monkeypatch):
    """The unstubbed `_test_pat` leaf itself: a 401 HTTPError becomes a clear detail
    string, never a raw exception — this is the ONE test that exercises the real
    urllib-facing function (stubbed everywhere else, per the module docstring)."""
    class FakeResp:
        def __init__(self):
            self.code = 401

    def fake_urlopen(request, timeout):
        raise urllib.error.HTTPError(github_pat_routes.GITHUB_USER_URL, 401, "Unauthorized", {}, None)

    monkeypatch.setattr(github_pat_routes.urllib.request, "urlopen", fake_urlopen)
    result = github_pat_routes._test_pat("bad-token")
    assert result["ok"] is False
    assert "401" in result["detail"]


# ---------- token resolution precedence (github_routes._read_pat, github_hub_routes._resolve_repo_token) ----------

async def test_read_pat_env_wins_with_no_cid(monkeypatch):
    monkeypatch.setenv("ORCHA_GITHUB_PAT", "ghp_ENVONLY000000000")
    assert github_routes._read_pat(None) == "ghp_ENVONLY000000000"


async def test_read_pat_none_without_cid_or_env(monkeypatch):
    monkeypatch.delenv("ORCHA_GITHUB_PAT", raising=False)
    assert github_routes._read_pat(None) is None


async def test_read_pat_db_stored_for_cid(client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_GITHUB_PAT", raising=False)
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/settings/github-pat",
                     json={"actor_agent_id": hid, "token": PAT})
    assert github_routes._read_pat(cid) == PAT


async def test_resolve_repo_token_app_file_beats_pat(client, container, make_agent, monkeypatch, tmp_path):
    """App single-token file present + a stored PAT: the App token wins (App files keep
    winning where both exist — the frozen contract)."""
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/settings/github-pat",
                     json={"actor_agent_id": hid, "token": PAT})
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_apptoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    assert github_hub_routes._resolve_repo_token("acme/site", cid) == "ghs_apptoken"


async def test_resolve_repo_token_pat_used_when_no_app_files(
        client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_GITHUB_TOKEN_FILE", raising=False)
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/settings/github-pat",
                     json={"actor_agent_id": hid, "token": PAT})
    assert github_hub_routes._resolve_repo_token("acme/site", cid) == PAT


async def test_resolve_repo_token_none_when_nothing_configured(
        client, container, monkeypatch):
    monkeypatch.delenv("ORCHA_GITHUB_TOKEN_FILE", raising=False)
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    monkeypatch.delenv("ORCHA_GITHUB_PAT", raising=False)
    assert github_hub_routes._resolve_repo_token("acme/site", container["id"]) is None


async def test_resolve_repo_token_token_map_beats_pat(
        client, container, make_agent, monkeypatch, tmp_path):
    import json as jsonlib
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/settings/github-pat",
                     json={"actor_agent_id": hid, "token": PAT})
    map_path = tmp_path / "github-tokens.json"
    map_path.write_text(jsonlib.dumps({"acme": "tok-acme-installation"}))
    monkeypatch.setenv("ORCHA_GITHUB_TOKENS_FILE", str(map_path))
    monkeypatch.delenv("ORCHA_GITHUB_TOKEN_FILE", raising=False)
    assert github_hub_routes._resolve_repo_token("acme/site", cid) == "tok-acme-installation"


# ---------- GET /api/github/repos PAT fallback + "source" field ----------

USER_REPOS_RAW = [
    {"full_name": "octocat/hello-world", "private": False, "description": "Hi",
     "html_url": "https://github.com/octocat/hello-world"},
    {"full_name": "octocat/private-repo", "private": True, "description": None,
     "html_url": "https://github.com/octocat/private-repo"},
]


async def test_repos_app_source_labeled(client, monkeypatch, tmp_path):
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_apptoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)

    def fake_fetch(token):
        return [{"full_name": "acme/site", "private": True, "description": "x",
                 "html_url": "https://github.com/acme/site"}]

    monkeypatch.setattr(github_routes, "_fetch_installation_repos", fake_fetch)
    r = await client.get("/api/github/repos")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True and body["source"] == "app"


async def test_repos_pat_fallback_when_no_app_token(client, monkeypatch):
    monkeypatch.delenv("ORCHA_GITHUB_TOKEN_FILE", raising=False)
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    monkeypatch.setenv("ORCHA_GITHUB_PAT", PAT)
    seen = {}

    def fake_fetch_user(token):
        seen["token"] = token
        return USER_REPOS_RAW

    monkeypatch.setattr(github_routes, "_fetch_user_repos", fake_fetch_user)
    r = await client.get("/api/github/repos")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert body["source"] == "pat"
    # SAME response shape the App path uses (full_name/private/description/html_url)
    assert body["repos"] == [
        {"full_name": "octocat/hello-world", "private": False, "description": "Hi",
         "html_url": "https://github.com/octocat/hello-world"},
        {"full_name": "octocat/private-repo", "private": True, "description": None,
         "html_url": "https://github.com/octocat/private-repo"},
    ]
    assert seen["token"] == PAT


async def test_repos_pat_fallback_from_db_via_cid_query_param(
        client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_GITHUB_TOKEN_FILE", raising=False)
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    monkeypatch.delenv("ORCHA_GITHUB_PAT", raising=False)
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/settings/github-pat",
                     json={"actor_agent_id": hid, "token": PAT})

    def fake_fetch_user(token):
        assert token == PAT
        return USER_REPOS_RAW

    monkeypatch.setattr(github_routes, "_fetch_user_repos", fake_fetch_user)
    r = await client.get(f"/api/github/repos?cid={cid}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True and body["source"] == "pat"
    assert len(body["repos"]) == 2


async def test_repos_pat_fallback_error_reports_detail(client, monkeypatch):
    monkeypatch.delenv("ORCHA_GITHUB_TOKEN_FILE", raising=False)
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    monkeypatch.setenv("ORCHA_GITHUB_PAT", PAT)

    def fake_fetch_user(token):
        raise RuntimeError("GitHub returned 401 for user/repos")

    monkeypatch.setattr(github_routes, "_fetch_user_repos", fake_fetch_user)
    r = await client.get("/api/github/repos")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is False and body["repos"] == []
    assert body["source"] == "pat"
    assert "401" in body["detail"]


async def test_repos_graceful_off_when_nothing_configured(client, monkeypatch):
    monkeypatch.delenv("ORCHA_GITHUB_TOKEN_FILE", raising=False)
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    monkeypatch.delenv("ORCHA_GITHUB_PAT", raising=False)
    r = await client.get("/api/github/repos")
    assert r.status_code == 200
    assert r.json() == {"available": False, "repos": []}
