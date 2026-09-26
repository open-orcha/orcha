"""HOST-side roster analysis storage (Orcha Cloud local run,
docs/orcha-cloud-local-run.md): PUT .../roster/analysis upserts a richer
project summary + recommended-agent suggestions produced by the desktop app's
host-side `claude` CLI analyzer; GET .../roster/analysis serves it back. The
portal never runs the analysis itself — this is pure storage/serving, one row
per container (latest wins, no history).

Covers:
  * PUT + GET roundtrip (upsert insert).
  * GET available:false before any PUT.
  * PUT is human-gated like roster/suggest/accept (403 for a member without
    manage_agents, per tests/test_access_model.py's matrix).
  * Validation: empty suggestions -> 422 (pydantic min_length), oversize
    summary -> 422 (pydantic max_length).
  * A second PUT overwrites (upsert), not appends.
"""

import pytest

OCTO = {"X-Auth-Request-User": "octocat"}
HUBOT = {"X-Auth-Request-User": "hubot"}


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    # Mirrors test_roster_suggest.py: keep this suite on the team plan so a
    # Solo-tier gate elsewhere never leaks into these assertions.
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


def _body(**overrides):
    body = {
        "summary": "A FastAPI + React fullstack app with Docker infra.",
        "suggestions": [
            {
                "alias": "atlas",
                "role": "Lead orchestrator",
                "focus": "Coordinates the fleet",
                "is_main": True,
                "rationale": "Every project needs a coordinator.",
            },
            {
                "alias": "nova",
                "role": "Frontend engineer",
                "focus": "Builds the React UI",
            },
        ],
        "source": "claude-local",
        "model": "claude-sonnet-4.5",
    }
    body.update(overrides)
    return body


# ============================ GET before any PUT ============================


async def test_get_available_false_before_any_put(client, container):
    cid = container["id"]
    r = await client.get(f"/api/containers/{cid}/roster/analysis")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is False


async def test_get_404_for_missing_container(client):
    import uuid
    r = await client.get(f"/api/containers/{uuid.uuid4()}/roster/analysis")
    assert r.status_code == 404


# ============================ PUT + GET roundtrip ============================


async def test_put_then_get_roundtrip(client, container, make_agent):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")

    r = await client.put(f"/api/containers/{cid}/roster/analysis", json=_body())
    assert r.status_code == 200, r.text
    put_body = r.json()
    assert put_body["stored"] is True
    assert put_body["updated_at"]

    r = await client.get(f"/api/containers/{cid}/roster/analysis")
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["available"] is True
    assert got["summary"] == _body()["summary"]
    assert got["source"] == "claude-local"
    assert got["model"] == "claude-sonnet-4.5"
    assert got["updated_at"]
    aliases = [s["alias"] for s in got["suggestions"]]
    assert aliases == ["atlas", "nova"]
    assert got["suggestions"][0]["is_main"] is True
    assert got["suggestions"][0]["rationale"] == "Every project needs a coordinator."


async def test_put_model_is_optional(client, container, make_agent):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    body = _body()
    del body["model"]

    r = await client.put(f"/api/containers/{cid}/roster/analysis", json=body)
    assert r.status_code == 200, r.text

    r = await client.get(f"/api/containers/{cid}/roster/analysis")
    assert r.json()["model"] is None


async def test_second_put_overwrites_not_appends(client, container, make_agent):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")

    r = await client.put(f"/api/containers/{cid}/roster/analysis", json=_body())
    assert r.status_code == 200, r.text

    second = _body(
        summary="Revised summary after a second analysis pass.",
        suggestions=[
            {"alias": "atlas", "role": "Lead orchestrator", "focus": "Coordinates the fleet"},
        ],
        source="claude-local",
        model="claude-opus-4.6",
    )
    r = await client.put(f"/api/containers/{cid}/roster/analysis", json=second)
    assert r.status_code == 200, r.text

    r = await client.get(f"/api/containers/{cid}/roster/analysis")
    got = r.json()
    assert got["summary"] == "Revised summary after a second analysis pass."
    assert got["model"] == "claude-opus-4.6"
    assert [s["alias"] for s in got["suggestions"]] == ["atlas"]


async def test_put_404_for_missing_container(client):
    import uuid
    r = await client.put(f"/api/containers/{uuid.uuid4()}/roster/analysis", json=_body())
    assert r.status_code == 404


# ============================ human gate ============================


async def test_put_is_human_gated_403_without_grant(client, container, make_agent, trust_proxy):
    """Same access-model matrix as roster/suggest/accept: a plain member without
    manage_agents is refused; the owner can."""
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _invite(client, cid, "hubot")

    r = await client.put(f"/api/containers/{cid}/roster/analysis", json=_body(), headers=HUBOT)
    assert r.status_code == 403 and "manage_agents" in r.text

    r = await client.put(f"/api/containers/{cid}/roster/analysis", json=_body(), headers=OCTO)
    assert r.status_code == 200, r.text


# ============================ validation ============================


async def test_put_rejects_empty_suggestions(client, container, make_agent):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    body = _body(suggestions=[])
    r = await client.put(f"/api/containers/{cid}/roster/analysis", json=body)
    assert r.status_code == 422, r.text


async def test_put_rejects_oversize_summary(client, container, make_agent):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    body = _body(summary="x" * 4001)
    r = await client.put(f"/api/containers/{cid}/roster/analysis", json=body)
    # app-wide string_too_long -> 413 body_too_long (application_lifecycle.py's
    # too_long_or_invalid handler), not a generic 422 — same shape every other
    # max_length-bounded field in this portal gets.
    assert r.status_code == 413, r.text
    assert r.json()["field"] == "summary"


async def test_put_accepts_summary_at_the_boundary(client, container, make_agent):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    body = _body(summary="x" * 4000)
    r = await client.put(f"/api/containers/{cid}/roster/analysis", json=body)
    assert r.status_code == 200, r.text


async def test_put_rejects_more_than_eight_suggestions(client, container, make_agent):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    suggestions = [
        {"alias": f"agent{i}", "role": "Worker", "focus": "Does work"} for i in range(9)
    ]
    body = _body(suggestions=suggestions)
    r = await client.put(f"/api/containers/{cid}/roster/analysis", json=body)
    assert r.status_code == 422, r.text


async def test_put_accepts_eight_suggestions(client, container, make_agent):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    suggestions = [
        {"alias": f"agent{i}", "role": "Worker", "focus": "Does work"} for i in range(8)
    ]
    body = _body(suggestions=suggestions)
    r = await client.put(f"/api/containers/{cid}/roster/analysis", json=body)
    assert r.status_code == 200, r.text
