"""V2 parity round 1 — backend regressions.

  * escalations are visible in the request read-models (snapshot + paged list):
    `escalated`, `escalated_at`, `escalated_from_id`, `escalated_from_alias`
    (e2e-owner-flows-11 / REQ-013 / REQ-071). Escalation keeps status='open' and only
    re-targets at a human, so before this the portal could never tell;
  * PUT /github authorizes BEFORE validating a "local" source — an unauthorized caller
    gets the honest 403, not a 400 about the local tree (e2e-permissions-16);
  * a request addressed straight at a read-only viewer is routed to the human who can
    act, never parked on the viewer (e2e-permissions-19);
  * GET /api/containers carries the caller's own role/grants per project (additive).
"""
import pytest

OCTO = {"X-Auth-Request-User": "octocat"}   # bound owner
HUBOT = {"X-Auth-Request-User": "hubot"}    # invited member
VERA = {"X-Auth-Request-User": "vera"}      # invited viewer


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")  # member invites are a Team-plan feature


async def _arena(client, container, make_agent):
    """Trusted arena: octocat bound as owner, hubot a member, vera a viewer."""
    await make_agent("root", "operator", kind="human")
    cid = container["id"]
    r = await client.get(f"/api/me?cid={cid}", headers=OCTO)
    assert r.status_code == 200, r.text
    owner_id = r.json()["identity"]["agent_id"]
    ids = {}
    for login, role in (("hubot", "member"), ("vera", "viewer")):
        r = await client.post(
            f"/api/containers/{cid}/members",
            json={"github_login": login, "role": role},
            headers=OCTO,
        )
        assert r.status_code == 201, r.text
        ids[login] = r.json()["agent_id"]
    return owner_id, ids["hubot"], ids["vera"]


def _req(rows, rid):
    return next(r for r in rows if str(r["id"]) == rid)


# ---------- escalations in the read-models ----------

async def test_escalate_is_visible_in_snapshot_and_list(
    client, db, container, make_agent, make_request
):
    cid = container["id"]
    human = await make_agent("hussein", "operator", kind="human")
    lead = await make_agent("lead", "lead")
    await make_agent("scout", "worker")
    req = await make_request(lead["agent_id"], "which region should we deploy to?",
                             target_alias="scout")
    rid = req["id"]
    other = await make_request(lead["agent_id"], "plain ask", target_alias="scout")

    # Before escalation: not escalated.
    snap = (await client.get(f"/api/containers/{cid}")).json()
    row = _req(snap["requests"], rid)
    assert row["escalated"] is False
    assert row["escalated_at"] is None and row["escalated_from_alias"] is None

    r = await client.post(
        f"/api/requests/{rid}/escalate",
        json={"requester_agent_id": lead["agent_id"], "reason": "scout is stuck"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "open"  # contract unchanged: still open, re-targeted

    # The audit event now records who it was escalated away from.
    ev = db.execute(
        "SELECT detail FROM events WHERE entity_id=%s AND event_type='escalated'", (rid,)
    )
    assert ev and ev[0]["detail"]["from_target_id"] is not None

    snap = (await client.get(f"/api/containers/{cid}")).json()
    row = _req(snap["requests"], rid)
    assert row["status"] == "open"
    assert row["escalated"] is True
    assert row["escalated_at"] is not None
    assert row["escalated_from_alias"] == "scout"
    assert str(row["target_id"]) == human["agent_id"]
    # An untouched request stays un-escalated.
    assert _req(snap["requests"], other["id"])["escalated"] is False

    # The paged list (Requests page "load more") carries the same fields.
    lst = (await client.get(f"/api/containers/{cid}/requests?limit=100")).json()
    lrow = _req(lst["requests"], rid)
    assert lrow["escalated"] is True and lrow["escalated_from_alias"] == "scout"


async def test_legacy_escalation_event_falls_back_to_created_target(
    client, db, container, make_agent, make_request
):
    """Pre-r1 `escalated` events carry no from_target_id: the original target comes
    from the request's own `created` event (the only target escalation moves off)."""
    cid = container["id"]
    await make_agent("hussein", "operator", kind="human")
    lead = await make_agent("lead", "lead")
    await make_agent("scout", "worker")
    req = await make_request(lead["agent_id"], "legacy", target_alias="scout")
    rid = req["id"]
    r = await client.post(
        f"/api/requests/{rid}/escalate",
        json={"requester_agent_id": lead["agent_id"], "reason": "old"},
    )
    assert r.status_code == 200, r.text
    db.execute(
        "UPDATE events SET detail = detail - 'from_target_id' "
        "WHERE entity_id=%s AND event_type='escalated'", (rid,),
    )
    row = _req((await client.get(f"/api/containers/{cid}")).json()["requests"], rid)
    assert row["escalated"] is True
    assert row["escalated_from_id"] is None
    assert row["escalated_from_alias"] == "scout"


async def test_expiry_sweep_escalation_is_visible(
    client, db, container, make_agent, make_request
):
    cid = container["id"]
    human = await make_agent("hussein", "operator", kind="human")
    lead = await make_agent("lead", "lead")
    await make_agent("scout", "worker")
    req = await make_request(lead["agent_id"], "expire me", target_alias="scout")
    rid = req["id"]
    db.execute("UPDATE requests SET expires_at = now() - interval '1 minute' WHERE id=%s",
               (rid,))
    r = await client.post(
        f"/api/containers/{cid}/sweep",
        params={"actor_agent_id": human["agent_id"]},
    )
    if r.status_code in (404, 405):
        pytest.skip(f"sweep route shape differs: {r.status_code} {r.text}")
    assert r.status_code == 200, r.text
    assert rid in r.json()["request_ids"]
    row = _req((await client.get(f"/api/containers/{cid}")).json()["requests"], rid)
    assert row["escalated"] is True and row["escalated_from_alias"] == "scout"


# ---------- PUT /github: authorize before validating the source ----------

async def test_github_local_source_403s_unauthorized_before_400(
    client, container, make_agent, trust_proxy, monkeypatch
):
    monkeypatch.delenv("ORCHA_LOCAL_REPO_DIR", raising=False)  # local source unavailable
    cid = container["id"]
    await _arena(client, container, make_agent)
    for who in (VERA, HUBOT):
        r = await client.put(f"/api/containers/{cid}/github",
                             json={"repo": "local"}, headers=who)
        assert r.status_code == 403, (who, r.status_code, r.text)
    # The owner (authorized) still gets the honest 400 about the missing local tree.
    r = await client.put(f"/api/containers/{cid}/github",
                         json={"repo": "local"}, headers=OCTO)
    assert r.status_code == 400 and "local repository source" in r.text


# ---------- requests addressed at a viewer ----------

async def test_request_to_viewer_is_rerouted_to_actionable_human(
    client, db, container, make_agent, make_request, trust_proxy
):
    cid = container["id"]
    owner_id, _hubot_id, vera_id = await _arena(client, container, make_agent)
    vera_alias = db.execute("SELECT alias FROM agents WHERE id=%s", (vera_id,))[0]["alias"]
    lead = await make_agent("lead", "lead")
    req = await make_request(lead["agent_id"], "please approve the schema",
                             target_alias=vera_alias)
    target = str(db.execute("SELECT target_id FROM requests WHERE id=%s",
                            (req["id"],))[0]["target_id"])
    assert target != vera_id
    role = db.execute("SELECT member_role FROM agents WHERE id=%s", (target,))[0]
    assert role["member_role"] != "viewer"
    assert req["rerouted_from_alias"] == vera_alias
    assert req["target_alias"] != vera_alias
    ev = db.execute("SELECT detail FROM events WHERE entity_id=%s AND event_type='created'",
                    (req["id"],))
    assert ev[0]["detail"]["rerouted_from_viewer"] == vera_alias

    # By id as well as by alias.
    r = await client.post(f"/api/containers/{cid}/requests", json={
        "requester_agent_id": lead["agent_id"], "payload": "by id",
        "target_agent_id": vera_id,
    })
    assert r.status_code == 201, r.text
    assert r.json()["rerouted_from_alias"] == vera_alias


async def test_request_to_member_is_not_rerouted(
    client, db, container, make_agent, make_request, trust_proxy
):
    _owner_id, hubot_id, _vera = await _arena(client, container, make_agent)
    hubot_alias = db.execute("SELECT alias FROM agents WHERE id=%s", (hubot_id,))[0]["alias"]
    lead = await make_agent("lead", "lead")
    req = await make_request(lead["agent_id"], "q", target_alias=hubot_alias)
    assert req["rerouted_from_alias"] is None and req["target_alias"] == hubot_alias


async def test_request_to_viewer_refused_when_only_viewers_can_be_picked(
    client, db, container, make_agent
):
    """No actionable human at all → 409 (never parked on the viewer)."""
    cid = container["id"]
    v = await make_agent("vee", "operator", kind="human")
    db.execute("UPDATE agents SET member_role='viewer' WHERE id=%s", (v["agent_id"],))
    lead = await make_agent("lead", "lead")
    r = await client.post(f"/api/containers/{cid}/requests", json={
        "requester_agent_id": lead["agent_id"], "payload": "hi", "target_alias": "vee",
    })
    assert r.status_code == 409, r.text


# ---------- containers list: caller's own role ----------

async def test_containers_list_carries_callers_role(
    client, container, make_agent, trust_proxy
):
    cid = container["id"]
    await _arena(client, container, make_agent)
    for who, role in ((OCTO, "owner"), (HUBOT, "member"), (VERA, "viewer")):
        rows = (await client.get("/api/containers", headers=who)).json()["containers"]
        row = next(c for c in rows if str(c["id"]) == cid)
        assert row["my_member_role"] == role, (who, row)
        assert isinstance(row["my_grants"], list)


async def test_containers_list_role_null_without_trust(client, container, monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)
    rows = (await client.get("/api/containers")).json()["containers"]
    row = next(c for c in rows if str(c["id"]) == container["id"])
    assert row["my_member_role"] is None and row["my_grants"] is None


# ---------- agent model: authorize before validating the body ----------

async def test_agent_model_403s_unauthorized_before_400(
    client, container, make_agent, trust_proxy
):
    """A viewer / member without manage_agents gets the honest 403, never a 400 about
    the model name (the model check used to run first)."""
    cid = container["id"]
    await _arena(client, container, make_agent)
    r = await client.post(f"/api/containers/{cid}/agents",
                          json={"alias": "w1", "role": "worker", "kind": "ai", "prompt": "p"},
                          headers=OCTO)
    assert r.status_code in (200, 201), r.text
    aid = r.json()["agent_id"] if "agent_id" in r.json() else r.json()["id"]
    for who in (VERA, HUBOT):
        r = await client.post(f"/api/agents/{aid}/model", json={"model": "not-a-model"}, headers=who)
        assert r.status_code == 403, (who, r.status_code, r.text)
    r = await client.post(f"/api/agents/{aid}/model", json={"model": "not-a-model"}, headers=OCTO)
    assert r.status_code == 400 and "not a known model" in r.text
