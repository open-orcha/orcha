"""PR #223 (cloud unification) review audit — regression guards for the gaps found
while resolving the review: routes that skipped the access model (mig 039) their
siblings apply, the removed-member re-invite lockout, the auto-wake "Off" 422 from
both phones, and the worktree symlink escape.

Trusted-lane conventions mirror tests/test_access_model.py: OCTO is the bound owner,
HUBOT an invited member, VERA an invited VIEWER, MALLORY a verified stranger.
"""
import os
import subprocess

import pytest

from portal_backend import github_repo_browse_routes as browse
from portal_backend import github_routes, local_git

OCTO = {"X-Auth-Request-User": "octocat"}
HUBOT = {"X-Auth-Request-User": "hubot"}
VERA = {"X-Auth-Request-User": "vera"}
MALLORY = {"X-Auth-Request-User": "mallory"}

SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")


@pytest.fixture(autouse=True)
def _clear_caches():
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()
    browse._REPO_SNAPSHOT_CACHE.clear()
    browse._REPO_SNAPSHOT_ORDER.clear()
    yield
    browse._TREE_CACHE.clear()
    browse._DEFAULT_BRANCH_CACHE.clear()
    browse._REPO_SNAPSHOT_CACHE.clear()
    browse._REPO_SNAPSHOT_ORDER.clear()


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture
def token_env(monkeypatch, tmp_path):
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_hubtoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))


def _git(repo_dir, *args):
    subprocess.run(["git", "-C", str(repo_dir), *args], check=True, capture_output=True)


@pytest.fixture
def local_repo(tmp_path, monkeypatch):
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


async def _bind_owner(client, container, make_agent):
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    ident = r.json()["identity"]
    assert ident and ident["member_role"] == "owner"
    return ident


async def _invite(client, cid, login, role="member"):
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": login, "role": role},
        headers=OCTO,
    )
    assert r.status_code == 201, r.text
    return r.json()["agent_id"]


def _stub_gh(monkeypatch):
    from portal_backend import code_space_routes as cs

    def fake_get(path, token):
        if "/commits/" in path:
            return {"sha": SHA}
        return {"default_branch": "main"}

    monkeypatch.setattr(browse, "_gh_get", fake_get)
    monkeypatch.setattr(cs, "_gh_get", fake_get)


# ------------------------- GET /api/github/repos?cid= -------------------------

async def test_github_repos_cid_is_a_member_read_of_that_project(
        client, container, make_agent, trust_proxy, monkeypatch):
    """A `cid` unlocks that project's sealed PAT — a trusted non-member must not be able
    to list the PAT owner's private repos by naming someone else's project."""
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    calls = []
    monkeypatch.setattr(github_routes, "_fetch_user_repos", lambda tok: calls.append(tok) or [])
    monkeypatch.setattr(github_routes, "_read_pat", lambda c=None: "ghp_secret" if c else None)

    r = await client.get(f"/api/github/repos?cid={cid}", headers=MALLORY)
    assert r.status_code == 403, r.text
    assert calls == []  # the PAT was never even used

    r = await client.get(f"/api/github/repos?cid={cid}", headers=OCTO)
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "pat" and calls == ["ghp_secret"]

    r = await client.get("/api/github/repos?cid=not-a-uuid", headers=OCTO)
    assert r.status_code == 400, r.text
    # unscoped listing is unchanged (no project ⇒ nothing to isolate)
    r = await client.get("/api/github/repos", headers=MALLORY)
    assert r.status_code == 200, r.text


# ------------------------- Code Space thread writes -------------------------

async def test_code_thread_writes_bind_the_proxy_identity(
        client, container, make_agent, trust_proxy, token_env, monkeypatch):
    cid = container["id"]
    owner = await _bind_owner(client, container, make_agent)
    hubot = await _invite(client, cid, "hubot")
    vera = await _invite(client, cid, "vera", role="viewer")
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/site"}, headers=OCTO)
    assert r.status_code == 200, r.text
    _stub_gh(monkeypatch)
    thread = {"path": "a.py", "start_line": 1, "end_line": 1, "kind": "note", "body": "x"}

    # a viewer is read-only — even with its OWN agent id as the actor
    r = await client.post(f"/api/containers/{cid}/code/threads",
                          json={"actor_agent_id": vera, **thread}, headers=VERA)
    assert r.status_code == 403, r.text
    # a stranger cannot write into a mapped project by naming a real agent id
    r = await client.post(f"/api/containers/{cid}/code/threads",
                          json={"actor_agent_id": owner["agent_id"], **thread}, headers=MALLORY)
    assert r.status_code == 403, r.text
    # a member claiming the OWNER's id is overridden to their own identity
    r = await client.post(f"/api/containers/{cid}/code/threads",
                          json={"actor_agent_id": owner["agent_id"], **thread}, headers=HUBOT)
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["created_by_agent_id"] == hubot

    # messages: same rule
    r = await client.post(f"/api/code/threads/{created['id']}/messages",
                          json={"actor_agent_id": vera, "body": "hi"}, headers=VERA)
    assert r.status_code == 403, r.text
    r = await client.post(f"/api/code/threads/{created['id']}/messages",
                          json={"actor_agent_id": owner["agent_id"], "body": "hi"}, headers=HUBOT)
    assert r.status_code == 201, r.text
    # the appended message is attributed to hubot, not to the claimed owner
    r = await client.get(f"/api/code/threads/{created['id']}", headers=HUBOT)
    assert r.status_code == 200, r.text
    authors = [m["author_agent_id"] for m in r.json()["messages"]]  # opening body + reply
    assert len(authors) == 2 and set(authors) == {hubot}, authors


# ------------------------- worktree PUT / commit / push -------------------------

async def test_worktree_writes_refuse_the_viewer_role(
        client, container, make_agent, trust_proxy, local_repo):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _invite(client, cid, "hubot")
    await _invite(client, cid, "vera", role="viewer")
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "local"}, headers=OCTO)
    assert r.status_code == 200, r.text
    base = f"/api/containers/{cid}/code/worktree"

    # viewing still works for the viewer …
    r = await client.get(f"{base}/file?path=README.md", headers=VERA)
    assert r.status_code == 200 and r.json().get("available") is True, r.text
    # … but every write is refused before touching the tree
    r = await client.put(f"{base}/file", json={"path": "new.txt", "content": "x", "base_hash": None}, headers=VERA)
    assert r.status_code == 403, r.text
    assert not (local_repo / "new.txt").exists()
    r = await client.post(f"{base}/commit", json={"paths": ["README.md"], "message": "m"}, headers=VERA)
    assert r.status_code == 403, r.text
    r = await client.post(f"{base}/push", headers=VERA)
    assert r.status_code == 403, r.text
    # a stranger is refused too
    r = await client.put(f"{base}/file", json={"path": "new.txt", "content": "x", "base_hash": None}, headers=MALLORY)
    assert r.status_code == 403, r.text
    # a member writes
    r = await client.put(f"{base}/file", json={"path": "new.txt", "content": "x", "base_hash": None}, headers=HUBOT)
    assert r.status_code == 200 and r.json()["ok"] is True, r.text
    assert (local_repo / "new.txt").read_text() == "x"


async def test_propose_refuses_the_viewer_role_before_any_github_call(
        client, container, make_agent, trust_proxy, token_env, monkeypatch):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _invite(client, cid, "vera", role="viewer")
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": "acme/site"}, headers=OCTO)
    assert r.status_code == 200, r.text

    def boom(*a, **k):
        raise AssertionError("GitHub must not be called for a refused propose")

    monkeypatch.setattr(browse, "_gh_get", boom)
    r = await client.post(
        f"/api/containers/{cid}/code/github/propose",
        json={"message": "edit", "files": [{"path": "a.py", "content": "x", "base_hash": None}]},
        headers=VERA,
    )
    assert r.status_code == 403, r.text


# ------------------------- wake-backoff listing -------------------------

async def test_wake_backoff_listing_is_project_isolated(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    r = await client.get(f"/api/containers/{cid}/wake-backoff", headers=MALLORY)
    assert r.status_code == 403, r.text
    r = await client.get(f"/api/containers/{cid}/wake-backoff", headers=OCTO)
    assert r.status_code == 200, r.text


# ------------------------- re-invite after removal -------------------------

async def test_reinvite_after_removal_reactivates_the_same_identity(
        client, container, make_agent, trust_proxy, db):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    hubot = await _invite(client, cid, "hubot")
    r = await client.delete(f"/api/containers/{cid}/members/{hubot}", headers=OCTO)
    assert r.status_code == 200, r.text
    # removed ⇒ locked out
    r = await client.get(f"/api/containers/{cid}/code/threads", headers=HUBOT)
    assert r.status_code == 403, r.text

    # re-invite (as a viewer this time) reactivates the retired row — no 409 lockout
    again = await _invite(client, cid, "hubot", role="viewer")
    assert again == hubot
    row = db.execute("SELECT terminated_at, status, member_role, grants FROM agents WHERE id=%s", (hubot,))[0]
    assert row["terminated_at"] is None and row["status"] == "idle"
    assert row["member_role"] == "viewer" and row["grants"] == []
    r = await client.get(f"/api/me?cid={cid}", headers=HUBOT)
    assert r.status_code == 200 and r.json()["identity"]["agent_id"] == hubot, r.text
    # still exactly one human row for that login in the project
    assert db.execute("SELECT count(*) c FROM agents WHERE container_id=%s AND lower(github_login)='hubot'",
                      (cid,))[0]["c"] == 1


# ------------------------- auto-wake: omitted == null == off -------------------------

async def test_auto_wake_omitted_interval_disables(client, container, make_agent):
    """Both phones' JSON layers drop null-valued keys, so "Auto-wake: Off" arrives with
    NO interval_secs key at all — that must disable, not 422."""
    ai = await make_agent("Bot")
    human = await make_agent("Human", kind="human")
    aid, hid = ai["agent_id"], human["agent_id"]
    r = await client.patch(f"/api/agents/{aid}/auto-wake", json={"actor_agent_id": hid, "interval_secs": 120})
    assert r.status_code == 200 and r.json()["enabled"] is True, r.text
    r = await client.patch(f"/api/agents/{aid}/auto-wake", json={"actor_agent_id": hid})
    assert r.status_code == 200, r.text
    assert r.json()["enabled"] is False and r.json()["auto_wake_interval_secs"] is None
    # the floor still applies to a real value
    r = await client.patch(f"/api/agents/{aid}/auto-wake", json={"actor_agent_id": hid, "interval_secs": 30})
    assert r.status_code == 422, r.text


# ------------------------- worktree symlink escape -------------------------

def test_worktree_file_io_refuses_symlink_escape(local_repo, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret").write_bytes(b"shh")
    os.symlink(outside, local_repo / "link")

    assert local_git._read_worktree_file("link/secret") is None
    assert local_git.worktree_file_hash("link/secret") is None
    assert local_git.write_worktree_file("link/escaped.txt", b"x") is False
    assert not (outside / "escaped.txt").exists()
    # an in-tree symlink is fine
    os.symlink(local_repo / "README.md", local_repo / "readme-link")
    assert local_git._read_worktree_file("readme-link") == b"hello local\n"
    assert local_git.write_worktree_file("src/new.txt", b"ok") is True
