"""FAST project-aware roster suggestion (local-run onboarding): GET .../roster/suggest
derives an instant roster from the WORKING TREE at ORCHA_LOCAL_REPO_DIR (os.scandir,
NOT git — an uncommitted brand-new project must still work), and POST
.../roster/suggest/accept creates the accepted suggestions as real agents via the
existing register_agent creation path.

Covers:
  * roster_signals.scan_workspace/detect_signals/build_roster unit-level (a
    React+FastAPI+docker project -> atlas + frontend + backend + infra with
    concrete rationales; an iOS project; time-budget respected under a tiny budget +
    a deep tree).
  * GET .../roster/suggest end to end: available:false for an empty/unmounted
    workspace, a real suggestion shape for a populated one.
  * POST .../roster/suggest/accept: creates agents (real DB), and is human-gated
    (403 for a member without manage_agents, like every other agent-management
    write — see tests/test_access_model.py's matrix).
"""
import os

import pytest

from portal_backend import roster_signals as rs

OCTO = {"X-Auth-Request-User": "octocat"}
HUBOT = {"X-Auth-Request-User": "hubot"}


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    # Mirrors test_access_model.py: keep this suite on the team plan so a Solo-tier
    # gate elsewhere never leaks into these assertions.
    monkeypatch.setenv("ORCHA_PLAN", "team")


async def _bind_owner(client, container, make_agent):
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    return r.json()["identity"]


async def _invite(client, cid, login, role="member"):
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": login, "role": role},
        headers=OCTO,
    )
    assert r.status_code == 201, r.text
    return r.json()["agent_id"]


def _write(path, content=""):
    os.makedirs(os.path.dirname(path), exist_ok=True) if os.path.dirname(path) else None
    with open(path, "w") as f:
        f.write(content)


# ============================ roster_signals — unit level ============================


def test_react_fastapi_docker_project_maps_to_atlas_plus_three(tmp_path):
    d = tmp_path
    _write(d / "package.json", '{"dependencies": {"react": "^18.0.0"}}')
    _write(d / "tsconfig.json", "{}")
    _write(d / "pyproject.toml", '[project]\ndependencies = ["fastapi"]\n')
    _write(d / "Dockerfile", "FROM python:3.12\n")
    _write(d / "docker-compose.yml", "services: {}\n")

    scan = rs.scan_workspace(str(d))
    signals, evidence = rs.detect_signals(scan)
    kind, suggestions = rs.build_roster(signals, evidence)

    assert kind == "fullstack"
    aliases = [s["alias"] for s in suggestions]
    assert aliases[0] == "atlas"
    assert suggestions[0]["is_main"] is True
    assert "nova" in aliases  # frontend (react)
    assert "forge" in aliases  # backend (fastapi)
    assert "rig" in aliases  # infra (docker)
    assert len(suggestions) <= 5

    by_alias = {s["alias"]: s for s in suggestions}
    # rationales cite CONCRETE evidence, not a generic template
    assert "react" in by_alias["nova"]["rationale"].lower() or "package.json" in by_alias["nova"]["rationale"]
    assert "fastapi" in by_alias["forge"]["rationale"].lower() or "pyproject" in by_alias["forge"]["rationale"]
    assert "docker" in by_alias["rig"]["rationale"].lower()


def test_ios_project_maps_to_atlas_plus_swift(tmp_path):
    d = tmp_path
    (d / "ios").mkdir()
    (d / "MyApp.xcodeproj").mkdir()
    _write(d / "Package.swift", "// swift-tools-version:5.9\n")
    _write(d / "README.md", "hello\n")

    scan = rs.scan_workspace(str(d))
    signals, evidence = rs.detect_signals(scan)
    kind, suggestions = rs.build_roster(signals, evidence)

    assert kind == "ios"
    aliases = [s["alias"] for s in suggestions]
    assert aliases == ["atlas", "swift"]
    swift = suggestions[1]
    assert swift["is_main"] is False
    assert "xcodeproj" in swift["rationale"] or "Package.swift" in swift["rationale"] or "ios/" in swift["rationale"]


def test_empty_directory_yields_no_entries(tmp_path):
    scan = rs.scan_workspace(str(tmp_path))
    assert scan["entries"] == []
    signals, evidence = rs.detect_signals(scan)
    kind, suggestions = rs.build_roster(signals, evidence)
    # still gets atlas alone (build_roster never refuses) — the ROUTE is what turns
    # "no entries" into available:false, tested below.
    assert [s["alias"] for s in suggestions] == ["atlas"]
    assert kind == "unknown"


def test_node_modules_and_dotdirs_are_skipped(tmp_path):
    d = tmp_path
    (d / "node_modules" / "some-pkg").mkdir(parents=True)
    _write(d / "node_modules" / "some-pkg" / "index.js", "junk")
    (d / ".git").mkdir()
    _write(d / ".git" / "HEAD", "ref: refs/heads/main\n")
    _write(d / "README.md", "hi\n")

    scan = rs.scan_workspace(str(d))
    rel_paths = [e["rel_path"] for e in scan["entries"]]
    # the skip dirs themselves are listed (depth 0) but never descended into
    assert "node_modules" in rel_paths
    assert not any(p.startswith("node_modules/") for p in rel_paths)
    assert not any(p.startswith(".git/") for p in rel_paths)


def test_time_budget_respected_with_deep_tree(tmp_path, monkeypatch):
    """A pathologically deep/wide tree under a near-zero time budget must still
    return promptly with whatever was found so far — never hang, never raise."""
    cur = tmp_path
    for i in range(40):
        cur = cur / f"d{i}"
        cur.mkdir()
        for j in range(15):
            _write(cur / f"f{j}.txt", "x")

    monkeypatch.setattr(rs, "TIME_BUDGET_SECONDS", 0.0)
    scan = rs.scan_workspace(str(tmp_path))
    assert scan["truncated"] is True
    assert scan["entries"] == []  # budget exhausted before the first directory read

    # a small, real budget still respects MAX_DEPTH regardless of tree depth
    monkeypatch.setattr(rs, "TIME_BUDGET_SECONDS", 0.2)
    scan2 = rs.scan_workspace(str(tmp_path))
    assert all(e["depth"] <= rs.MAX_DEPTH for e in scan2["entries"])


def test_max_entries_bound_respected(tmp_path, monkeypatch):
    d = tmp_path
    for i in range(50):
        _write(d / f"file{i}.txt", "x")

    monkeypatch.setattr(rs, "MAX_ENTRIES", 10)
    scan = rs.scan_workspace(str(d))
    assert len(scan["entries"]) <= 10
    assert scan["truncated"] is True


def test_suggestions_capped_at_five(tmp_path):
    d = tmp_path
    _write(d / "package.json", '{"dependencies": {"react": "1"}}')
    _write(d / "pyproject.toml", '[project]\ndependencies=["fastapi"]\n')
    (d / "ios").mkdir()
    (d / "android").mkdir()
    _write(d / "Dockerfile", "FROM x\n")
    (d / "migrations").mkdir()
    (d / "docs").mkdir()
    for i in range(3):
        _write(d / "docs" / f"page{i}.md", "x")
    (d / "tests").mkdir()

    scan = rs.scan_workspace(str(d))
    signals, evidence = rs.detect_signals(scan)
    _, suggestions = rs.build_roster(signals, evidence)
    assert len(suggestions) <= 5
    assert suggestions[0]["alias"] == "atlas"


# ============================ GET .../roster/suggest — HTTP level ============================


async def test_suggest_available_false_when_env_unset(client, container, monkeypatch):
    monkeypatch.delenv("ORCHA_LOCAL_REPO_DIR", raising=False)
    cid = container["id"]
    r = await client.get(f"/api/containers/{cid}/roster/suggest")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is False
    assert body["source"] is None
    assert body["suggestions"] == []


async def test_suggest_available_false_for_empty_workspace(client, container, tmp_path, monkeypatch):
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(tmp_path))
    cid = container["id"]
    r = await client.get(f"/api/containers/{cid}/roster/suggest")
    assert r.status_code == 200, r.text
    assert r.json()["available"] is False


async def test_suggest_returns_real_roster_for_populated_workspace(client, container, tmp_path, monkeypatch):
    _write(tmp_path / "package.json", '{"dependencies": {"react": "1"}}')
    _write(tmp_path / "pyproject.toml", '[project]\ndependencies=["fastapi"]\n')
    _write(tmp_path / "Dockerfile", "FROM x\n")
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(tmp_path))
    cid = container["id"]

    r = await client.get(f"/api/containers/{cid}/roster/suggest")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert body["source"] == "workspace"
    assert body["project_kind"] == "fullstack"
    assert "react" in body["signals"]
    assert "fastapi" in body["signals"]
    aliases = [s["alias"] for s in body["suggestions"]]
    assert aliases[0] == "atlas"
    assert body["suggestions"][0]["is_main"] is True
    assert "nova" in aliases
    assert "forge" in aliases


async def test_suggest_works_without_git_init_uncommitted_project(client, container, tmp_path, monkeypatch):
    """The key local-run requirement: a brand-new project folder with no `.git` at
    all (never ran `git init`) must still produce a suggestion — this endpoint reads
    the working tree directly, unlike local_git.available() which requires `.git`."""
    assert not (tmp_path / ".git").exists()
    _write(tmp_path / "go.mod", "module example.com/x\n")
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(tmp_path))
    cid = container["id"]

    r = await client.get(f"/api/containers/{cid}/roster/suggest")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True
    assert "go" in body["signals"]


async def test_suggest_refresh_param_is_accepted_noop(client, container, tmp_path, monkeypatch):
    _write(tmp_path / "README.md", "hi\n")
    _write(tmp_path / "go.mod", "module x\n")
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(tmp_path))
    cid = container["id"]

    r = await client.get(f"/api/containers/{cid}/roster/suggest", params={"refresh": 1})
    assert r.status_code == 200, r.text
    assert r.json()["available"] is True


async def test_suggest_404_for_missing_container(client):
    import uuid
    r = await client.get(f"/api/containers/{uuid.uuid4()}/roster/suggest")
    assert r.status_code == 404


# ============================ POST .../roster/suggest/accept — HTTP level ============================


async def test_accept_creates_agents(client, container, make_agent, tmp_path, monkeypatch):
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(tmp_path))
    cid = container["id"]
    await make_agent("root", "operator", kind="human")

    body = {
        "suggestions": [
            {"alias": "atlas", "role": "Lead orchestrator", "focus": "Coordinates the fleet"},
            {"alias": "nova", "role": "Frontend engineer", "focus": "Builds the UI"},
        ],
    }
    r = await client.post(f"/api/containers/{cid}/roster/suggest/accept", json=body)
    assert r.status_code == 201, r.text
    created = r.json()["created"]
    assert len(created) == 2
    assert {c["alias"] for c in created} == {"atlas", "nova"}
    for c in created:
        assert c["agent_id"]

    # the agents are real — visible in the container snapshot
    snap = await client.get(f"/api/containers/{cid}")
    assert snap.status_code == 200, snap.text
    aliases = {a["alias"] for a in snap.json()["agents"]}
    assert {"atlas", "nova"} <= aliases


async def test_accept_is_human_gated_403_without_grant(
    client, container, make_agent, tmp_path, monkeypatch, trust_proxy
):
    """Same access-model matrix as every other agent-management write
    (tests/test_access_model.py): a plain member without manage_agents is refused."""
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(tmp_path))
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _invite(client, cid, "hubot")

    body = {"suggestions": [{"alias": "nova", "role": "Frontend engineer", "focus": "UI"}]}
    r = await client.post(f"/api/containers/{cid}/roster/suggest/accept", json=body, headers=HUBOT)
    assert r.status_code == 403 and "manage_agents" in r.text

    # the owner CAN
    r = await client.post(f"/api/containers/{cid}/roster/suggest/accept", json=body, headers=OCTO)
    assert r.status_code == 201, r.text


async def test_accept_rejects_bad_container(client, tmp_path, monkeypatch):
    import uuid
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(tmp_path))
    body = {"suggestions": [{"alias": "nova", "role": "Frontend engineer", "focus": "UI"}]}
    r = await client.post(f"/api/containers/{uuid.uuid4()}/roster/suggest/accept", json=body)
    assert r.status_code == 404


async def test_accept_requires_at_least_one_suggestion(client, container):
    cid = container["id"]
    r = await client.post(f"/api/containers/{cid}/roster/suggest/accept", json={"suggestions": []})
    assert r.status_code == 422
