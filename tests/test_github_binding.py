"""GitHub dashboard — container↔repo binding + installation-repo listing (graceful off).

The repos endpoint's network leaf (`github_routes._fetch_installation_repos`) is the ONLY
thing stubbed, per the test-teeth convention — routes, schema validation, and the token-file
read all run for real.
"""
import uuid

from portal_backend import github_routes


# ---------- PUT/GET binding ----------

async def test_github_binding_round_trip(client, container):
    cid = container["id"]
    # fresh container starts unbound
    r = await client.get(f"/api/containers/{cid}/github")
    assert r.status_code == 200 and r.json() == {"repo": None}

    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/site"})
    assert r.status_code == 200, r.text
    assert r.json() == {"repo": "acme/site"}

    r = await client.get(f"/api/containers/{cid}/github")
    assert r.json() == {"repo": "acme/site"}

    # rebinding replaces, not appends
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/other.repo"})
    assert r.json() == {"repo": "acme/other.repo"}


async def test_github_binding_null_unbinds(client, container):
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/site"})
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": None})
    assert r.status_code == 200 and r.json() == {"repo": None}
    assert (await client.get(f"/api/containers/{cid}/github")).json() == {"repo": None}


async def test_github_binding_invalid_shape_422(client, container):
    cid = container["id"]
    for bad in ("acme", "acme/", "/site", "a/b/c", "a b/c", "-/-/-", ""):
        r = await client.put(f"/api/containers/{cid}/github", json={"repo": bad})
        assert r.status_code == 422, f"{bad!r} → {r.status_code}"
    # nothing was persisted by the rejected writes
    assert (await client.get(f"/api/containers/{cid}/github")).json() == {"repo": None}


async def test_github_binding_unknown_container(client):
    r = await client.get(f"/api/containers/{uuid.uuid4()}/github")
    assert r.status_code == 404, r.text
    r = await client.put(f"/api/containers/{uuid.uuid4()}/github", json={"repo": "a/b"})
    assert r.status_code == 404, r.text
    r = await client.get("/api/containers/not-a-uuid/github")
    assert r.status_code == 400, r.text


async def test_binding_surfaces_on_snapshot_and_list(client, container):
    """The home page reads the snapshot (GET /api/containers/{cid}); `orcha ls` and the
    cid-resolver read the list — both must carry github_repo."""
    cid = container["id"]
    await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/site"})
    snap = (await client.get(f"/api/containers/{cid}")).json()
    assert snap["container"]["github_repo"] == "acme/site"
    listed = (await client.get("/api/containers")).json()["containers"]
    assert listed[0]["github_repo"] == "acme/site"


# ---------- GET /api/github/repos ----------

async def test_repos_graceful_off_when_env_unset(client, monkeypatch):
    monkeypatch.delenv("ORCHA_GITHUB_TOKEN_FILE", raising=False)
    r = await client.get("/api/github/repos")
    assert r.status_code == 200, r.text            # off state is 200, never an error
    assert r.json() == {"available": False, "repos": []}


async def test_repos_graceful_off_when_file_missing_or_empty(client, monkeypatch, tmp_path):
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(tmp_path / "github-token"))
    r = await client.get("/api/github/repos")
    assert r.status_code == 200 and r.json() == {"available": False, "repos": []}
    (tmp_path / "github-token").write_text("\n")   # present but empty → still off
    r = await client.get("/api/github/repos")
    assert r.json() == {"available": False, "repos": []}


async def test_repos_success_with_token_and_fake_github(client, monkeypatch, tmp_path):
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_testtoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    seen = {}

    def fake_fetch(token):
        seen["token"] = token
        return [
            {"full_name": "acme/site", "private": True, "description": "The site",
             "html_url": "https://github.com/acme/site", "stargazers_count": 9},
            {"full_name": "acme/docs", "private": False, "description": None,
             "html_url": "https://github.com/acme/docs"},
        ]

    monkeypatch.setattr(github_routes, "_fetch_installation_repos", fake_fetch)
    r = await client.get("/api/github/repos")
    assert r.status_code == 200, r.text
    assert r.json() == {
        "available": True,
        "repos": [
            {"full_name": "acme/site", "private": True, "description": "The site",
             "html_url": "https://github.com/acme/site"},
            {"full_name": "acme/docs", "private": False, "description": None,
             "html_url": "https://github.com/acme/docs"},
        ],
        "source": "app",
    }
    assert seen["token"] == "ghs_testtoken"        # the file's token reached the fetch, stripped


async def test_repos_github_error_reports_detail(client, monkeypatch, tmp_path):
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_testtoken")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))

    def fake_fetch(token):
        raise RuntimeError("GitHub returned 401 for installation/repositories")

    monkeypatch.setattr(github_routes, "_fetch_installation_repos", fake_fetch)
    r = await client.get("/api/github/repos")
    assert r.status_code == 200, r.text            # still graceful, with a reason
    body = r.json()
    assert body["available"] is False and body["repos"] == []
    assert "401" in body["detail"]
