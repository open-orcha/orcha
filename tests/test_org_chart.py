"""Org chart — reporting lines (mig 052 `agents.reports_to_agent_id`) + escalation routing.

Contract under test:
  * Migration: the column exists, is nullable, defaults to NULL for every agent.
  * GET/PUT /api/agents/{aid}/reports-to {reports_to_agent_id|null}; the snapshot's agents
    carry `reports_to`.
  * PUT is human-authoritative, gated like agent configuration: trusted lane = owner or a
    manage_agents holder; a plain member, a viewer and a non-member are refused; an AI
    actor is refused on every lane. Audit event `agent_reports_to_changed`.
  * 409 on cycles (incl. self), 422 cross-project / retired manager.
  * Routing: an untargeted ask / escalation / expiry sweep / agent suggestion walks the
    requester's manager chain — nearest actionable human (never a viewer; AI managers
    skipped; a suggestion needs a manager who can approve hires) — else the old fallback.
    `detail.routed_via` records why.
"""
import pytest
from conftest import ts_ago, ts_from_now


OCTO = {"X-Auth-Request-User": "octocat"}
HUBOT = {"X-Auth-Request-User": "hubot"}
VERA = {"X-Auth-Request-User": "vera"}
MALLORY = {"X-Auth-Request-User": "mallory"}


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture
def no_trust_proxy(monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)


async def _put(client, aid, mid, actor=None, headers=None):
    body = {"reports_to_agent_id": mid}
    if actor is not None:
        body["actor_agent_id"] = actor
    return await client.put(f"/api/agents/{aid}/reports-to", json=body, headers=headers or {})


def _set(db, aid, mid):
    db.execute("UPDATE agents SET reports_to_agent_id=%s WHERE id=%s", (mid, aid))


def _role(db, aid, role):
    db.execute("UPDATE agents SET member_role=%s WHERE id=%s", (role, aid))


def _detail(db, rid):
    return db.execute("SELECT detail, target_id FROM requests WHERE id=%s", (rid,))[0]


# ---- migration ------------------------------------------------------------------------


async def test_migration_adds_nullable_column_default_null(db, make_agent, no_trust_proxy):
    col = db.column("agents", "reports_to_agent_id")
    assert col and col["is_nullable"] == "YES" and col["data_type"] == "uuid"
    a = await make_agent("dev")
    assert db.execute("SELECT reports_to_agent_id FROM agents WHERE id=%s", (a["agent_id"],))[0][
        "reports_to_agent_id"
    ] is None
    # additive + idempotent: re-running it on a live DB is a no-op that keeps data
    import pathlib
    sql = (pathlib.Path(__file__).resolve().parents[1] / "orcha-cli" / "orcha_cli" / "templates"
           / "migrations" / "052_agent_reports_to.sql").read_text()
    boss = await make_agent("boss", kind="human")
    _set(db, a["agent_id"], boss["agent_id"])
    if db.backend == "postgres":  # the SQLite leg starts from its 001 baseline, not mig files
        db.execute(sql)
    assert str(db.execute("SELECT reports_to_agent_id FROM agents WHERE id=%s", (a["agent_id"],))[0][
        "reports_to_agent_id"
    ]) == boss["agent_id"]
    if db.backend == "postgres":
        assert db.execute("SELECT 1 FROM pg_indexes WHERE indexname='agents_reports_to_idx'")
    else:
        assert db.execute("SELECT 1 FROM sqlite_master WHERE type='index' AND name='agents_reports_to_idx'")


# ---- API: set / read / clear -------------------------------------------------------------


async def test_set_read_clear_and_snapshot(client, container, make_agent, db, no_trust_proxy):
    boss = (await make_agent("boss", kind="human"))["agent_id"]
    lead = (await make_agent("lead"))["agent_id"]
    dev = (await make_agent("dev"))["agent_id"]

    r = await _put(client, lead, boss, actor=boss)
    assert r.status_code == 200, r.text
    assert r.json()["reports_to_agent_id"] == boss and r.json()["reports_to_alias"] == "boss"
    r = await _put(client, dev, lead, actor=boss)
    assert r.status_code == 200, r.text
    assert [c["alias"] for c in r.json()["chain"]] == ["lead", "boss"]

    g = (await client.get(f"/api/agents/{dev}/reports-to")).json()
    assert g["reports_to_alias"] == "lead" and [c["alias"] for c in g["chain"]] == ["lead", "boss"]

    snap = (await client.get(f"/api/containers/{container['id']}")).json()
    by = {a["alias"]: a for a in snap["agents"]}
    assert str(by["dev"]["reports_to"]) == lead
    assert str(by["lead"]["reports_to"]) == boss
    assert by["boss"]["reports_to"] is None

    r = await _put(client, dev, None, actor=boss)
    assert r.status_code == 200 and r.json()["reports_to_agent_id"] is None
    assert db.execute("SELECT reports_to_agent_id FROM agents WHERE id=%s", (dev,))[0][
        "reports_to_agent_id"
    ] is None

    events = db.execute(
        "SELECT actor_id, detail FROM events WHERE event_type='agent_reports_to_changed' "
        "AND entity_id=%s ORDER BY id",
        (dev,),
    )
    assert [(e["detail"]["from_alias"], e["detail"]["to_alias"]) for e in events] == [
        (None, "lead"),
        ("lead", None),
    ]
    assert all(str(e["actor_id"]) == boss for e in events)


async def test_cycles_are_409(client, make_agent, no_trust_proxy):
    boss = (await make_agent("boss", kind="human"))["agent_id"]
    a = (await make_agent("a"))["agent_id"]
    b = (await make_agent("b"))["agent_id"]
    c = (await make_agent("c"))["agent_id"]
    assert (await _put(client, a, a, actor=boss)).status_code == 409  # self
    assert (await _put(client, b, a, actor=boss)).status_code == 200
    assert (await _put(client, c, b, actor=boss)).status_code == 200
    r = await _put(client, a, c, actor=boss)  # a → c → b → a
    assert r.status_code == 409 and "loop" in r.text
    r = await _put(client, a, b, actor=boss)  # direct 2-cycle
    assert r.status_code == 409


async def test_cross_project_and_retired_manager_are_422(
    client, container, make_agent, db, no_trust_proxy
):
    boss = (await make_agent("boss", kind="human"))["agent_id"]
    dev = (await make_agent("dev"))["agent_id"]
    other = (await client.post("/api/containers", json={"name": "other-proj", "additional": True})).json()
    ocid = other.get("id") or other.get("container_id")
    far = (await make_agent("far", container_id=ocid))["agent_id"]
    r = await _put(client, dev, far, actor=boss)
    assert r.status_code == 422, r.text
    gone = (await make_agent("gone"))["agent_id"]
    db.execute("UPDATE agents SET terminated_at=now() WHERE id=%s", (gone,))
    assert (await _put(client, dev, gone, actor=boss)).status_code == 422
    assert (await _put(client, dev, "not-a-uuid", actor=boss)).status_code == 422


async def test_ai_actor_and_viewer_refused_trust_off(client, make_agent, db, no_trust_proxy):
    boss = (await make_agent("boss", kind="human"))["agent_id"]
    viewer = (await make_agent("vera", kind="human"))["agent_id"]
    _role(db, viewer, "viewer")
    lead = (await make_agent("lead"))["agent_id"]
    dev = (await make_agent("dev"))["agent_id"]
    # agents can't manage agents
    assert (await _put(client, dev, lead, actor=lead)).status_code == 403
    assert (await _put(client, dev, lead, actor=viewer)).status_code == 403
    assert (await _put(client, dev, lead)).status_code == 400  # no actor at all
    assert (await _put(client, dev, lead, actor=boss)).status_code == 200


async def _bind_owner(client, container, make_agent):
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text


async def _invite(client, cid, login, role="member"):
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": login, "role": role},
        headers=OCTO,
    )
    assert r.status_code == 201, r.text
    return r.json()["agent_id"]


async def test_trusted_gate_owner_grant_member_viewer_nonmember(
    client, container, make_agent, db, trust_proxy
):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    hubot = await _invite(client, cid, "hubot")
    vera = await _invite(client, cid, "vera", role="viewer")
    lead = (await make_agent("lead"))["agent_id"]
    dev = (await make_agent("dev"))["agent_id"]

    assert (await _put(client, dev, lead, headers=OCTO)).status_code == 200  # owner
    assert (await _put(client, dev, None, headers=HUBOT)).status_code == 403  # plain member
    assert (await _put(client, dev, None, headers=VERA)).status_code == 403  # viewer
    assert (await _put(client, dev, None, headers=MALLORY)).status_code == 403  # non-member
    # the viewer can still READ the line
    assert (await client.get(f"/api/agents/{dev}/reports-to", headers=VERA)).status_code == 200
    assert (await client.get(f"/api/agents/{dev}/reports-to", headers=MALLORY)).status_code == 403

    db.execute(
        "UPDATE agents SET grants='[\"manage_agents\"]' WHERE id=%s", (hubot,)
    )
    r = await _put(client, dev, None, headers=HUBOT)
    assert r.status_code == 200, r.text
    ev = db.execute(
        "SELECT actor_id FROM events WHERE event_type='agent_reports_to_changed' ORDER BY id DESC LIMIT 1"
    )
    assert str(ev[0]["actor_id"]) == hubot  # the signed-in member is the audited actor
    _ = vera


# ---- routing -----------------------------------------------------------------------------


async def test_untargeted_ask_goes_to_nearest_human_manager(
    client, make_agent, make_request, db, no_trust_proxy
):
    boss = (await make_agent("boss", kind="human"))["agent_id"]
    other = (await make_agent("other", kind="human"))["agent_id"]
    lead = (await make_agent("lead"))["agent_id"]  # AI manager — skipped
    dev = (await make_agent("dev"))["agent_id"]
    _set(db, lead, boss)
    _set(db, dev, lead)
    # make `other` the freshest human so the old fallback would pick them
    db.execute(f"UPDATE agents SET last_heartbeat_at={ts_from_now(3600)} WHERE id=%s", (other,))

    r = await make_request(dev, "Which DB should I use?")
    rid = r["request_id"]
    assert r["target_alias"] == "boss" and r["routed_via"] == "reports_to"
    row = _detail(db, rid)
    assert str(row["target_id"]) == boss
    assert row["detail"]["routed_via"] == "reports_to"
    assert row["detail"]["manager_depth"] == 2
    assert row["detail"]["reports_to_skipped"] == [{"alias": "lead", "why": "ai_manager"}]

    # no reporting line → the existing fallback, untouched (no routing record)
    solo = (await make_agent("solo"))["agent_id"]
    r2 = await make_request(solo, "hello?")
    assert r2["target_alias"] == "other" and r2["routed_via"] is None
    assert _detail(db, r2["request_id"])["detail"] is None


async def test_explicit_target_is_never_rerouted(client, make_agent, make_request, db, no_trust_proxy):
    boss = (await make_agent("boss", kind="human"))["agent_id"]
    await make_agent("peer")
    dev = (await make_agent("dev"))["agent_id"]
    _set(db, dev, boss)
    r = await make_request(dev, "ping", target_alias="peer")
    assert r["target_alias"] == "peer" and r["routed_via"] is None


async def test_viewer_manager_is_skipped_up_the_chain(client, make_agent, make_request, db, no_trust_proxy):
    ceo = (await make_agent("ceo", kind="human"))["agent_id"]
    viewer = (await make_agent("vera", kind="human"))["agent_id"]
    _role(db, viewer, "viewer")
    dev = (await make_agent("dev"))["agent_id"]
    _set(db, viewer, ceo)
    _set(db, dev, viewer)
    r = await make_request(dev, "need a decision")
    row = _detail(db, r["request_id"])
    assert str(row["target_id"]) == ceo
    assert row["detail"]["reports_to_skipped"] == [{"alias": "vera", "why": "viewer"}]


async def test_chain_without_actionable_human_falls_back(
    client, make_agent, make_request, db, no_trust_proxy
):
    fallback = (await make_agent("anyone", kind="human"))["agent_id"]
    viewer = (await make_agent("vera", kind="human"))["agent_id"]
    _role(db, viewer, "viewer")
    lead = (await make_agent("lead"))["agent_id"]
    dev = (await make_agent("dev"))["agent_id"]
    _set(db, dev, lead)
    _set(db, lead, viewer)
    r = await make_request(dev, "anyone there?")
    row = _detail(db, r["request_id"])
    assert str(row["target_id"]) == fallback
    assert r["routed_via"] == "fallback" and row["detail"]["routed_via"] == "fallback"
    assert [s["why"] for s in row["detail"]["reports_to_skipped"]] == ["ai_manager", "viewer"]


async def test_retired_manager_is_passed_through(client, make_agent, make_request, db, no_trust_proxy):
    ceo = (await make_agent("ceo", kind="human"))["agent_id"]
    gone = (await make_agent("gone", kind="human"))["agent_id"]
    dev = (await make_agent("dev"))["agent_id"]
    _set(db, gone, ceo)
    _set(db, dev, gone)
    db.execute("UPDATE agents SET terminated_at=now() WHERE id=%s", (gone,))
    r = await make_request(dev, "q")
    assert str(_detail(db, r["request_id"])["target_id"]) == ceo


async def test_corrupt_cycle_in_db_is_walk_safe(client, make_agent, make_request, db, no_trust_proxy):
    fallback = (await make_agent("h", kind="human"))["agent_id"]
    a = (await make_agent("a"))["agent_id"]
    b = (await make_agent("b"))["agent_id"]
    _set(db, a, b)
    _set(db, b, a)  # a loop written behind the API's back
    r = await make_request(a, "q")
    assert str(_detail(db, r["request_id"])["target_id"]) == fallback


async def test_escalate_climbs_above_current_manager(client, make_agent, make_request, db, no_trust_proxy):
    ceo = (await make_agent("ceo", kind="human"))["agent_id"]
    mgr = (await make_agent("mgr", kind="human"))["agent_id"]
    dev = (await make_agent("dev"))["agent_id"]
    _set(db, mgr, ceo)
    _set(db, dev, mgr)
    r = await make_request(dev, "q")
    rid = r["request_id"]
    assert str(_detail(db, rid)["target_id"]) == mgr
    e = await client.post(f"/api/requests/{rid}/escalate", json={"requester_agent_id": dev})
    assert e.status_code == 200, e.text
    assert e.json()["target_id"] == ceo and e.json()["routed_via"] == "reports_to"
    row = _detail(db, rid)
    assert str(row["target_id"]) == ceo and row["detail"]["routed_to_alias"] == "ceo"


async def test_escalate_from_ai_target_goes_to_requesters_manager(
    client, make_agent, make_request, db, no_trust_proxy
):
    await make_agent("fresh", kind="human")
    mgr = (await make_agent("mgr", kind="human"))["agent_id"]
    await make_agent("peer")
    dev = (await make_agent("dev"))["agent_id"]
    _set(db, dev, mgr)
    r = await make_request(dev, "q", target_alias="peer")
    e = await client.post(f"/api/requests/{r['request_id']}/escalate", json={"requester_agent_id": dev})
    assert e.status_code == 200 and e.json()["target_id"] == mgr


async def test_sweep_routes_expired_asks_to_requesters_manager(
    client, container, make_agent, make_request, db, no_trust_proxy
):
    cid = container["id"]
    op = (await make_agent("op", kind="human"))["agent_id"]
    mgr = (await make_agent("mgr", kind="human"))["agent_id"]
    await make_agent("peer")
    dev = (await make_agent("dev"))["agent_id"]
    _set(db, dev, mgr)
    db.execute(f"UPDATE agents SET last_heartbeat_at={ts_from_now(3600)} WHERE id=%s", (op,))
    r = await make_request(dev, "q", target_alias="peer")
    db.execute(f"UPDATE requests SET expires_at={ts_ago(60)} WHERE id=%s", (r["request_id"],))
    s = await client.post(f"/api/containers/{cid}/sweep?actor_agent_id={op}")
    assert s.status_code == 200, s.text
    row = _detail(db, r["request_id"])
    assert str(row["target_id"]) == mgr and row["detail"]["routed_via"] == "reports_to"


async def test_suggestion_goes_to_manager_who_can_approve_hires(
    client, make_agent, make_request, db, no_trust_proxy
):
    owner = (await make_agent("owner", kind="human"))["agent_id"]
    _role(db, owner, "owner")
    lead_h = (await make_agent("lead-h", kind="human"))["agent_id"]  # member, no grant
    dev = (await make_agent("dev"))["agent_id"]
    _set(db, lead_h, owner)
    _set(db, dev, lead_h)
    await make_agent("peer")
    r = await make_request(dev, "build it", target_alias="peer")
    rid = r["request_id"]
    s = await client.post(
        f"/api/requests/{rid}/suggest-agent",
        json={
            "requester_agent_id": dev,
            "proposed_alias": "dba",
            "proposed_role": "Database admin",
            "proposed_prompt": "You are a DBA.",
            "rationale": "Nobody owns the schema.",
        },
    )
    assert s.status_code == 200, s.text
    row = _detail(db, rid)
    assert str(row["target_id"]) == owner  # the member manager can't approve a hire
    assert row["detail"]["proposed_alias"] == "dba"
    assert row["detail"]["routed_via"] == "reports_to"
    assert row["detail"]["reports_to_skipped"] == [{"alias": "lead-h", "why": "missing_grant"}]
    # the agent is NOT created — a human still decides (approve hires)
    assert not db.execute("SELECT 1 FROM agents WHERE alias='dba'")


async def test_suggestion_without_manager_skips_member_who_cannot_approve(
    client, make_agent, make_request, db, no_trust_proxy
):
    """RT-19: a requester with NO manager falls back project-wide — but only to a human
    who can approve a hire (owner / manage_agents), even when a plain member has the
    freshest heartbeat."""
    owner = (await make_agent("owner", kind="human"))["agent_id"]
    _role(db, owner, "owner")
    maya = (await make_agent("maya", kind="human"))["agent_id"]  # member, no grant
    db.execute(f"UPDATE agents SET last_heartbeat_at={ts_ago(3600)} WHERE id=%s", (owner,))
    db.execute("UPDATE agents SET last_heartbeat_at=now() WHERE id=%s", (maya,))
    zed = (await make_agent("zed"))["agent_id"]  # no reports_to
    await make_agent("peer")
    r = await make_request(zed, "build it", target_alias="peer")
    rid = r["request_id"]
    s = await client.post(
        f"/api/requests/{rid}/suggest-agent",
        json={
            "requester_agent_id": zed, "proposed_alias": "sentry",
            "proposed_role": "Monitoring", "proposed_prompt": "You watch errors.",
            "rationale": "No one owns alerts.",
        },
    )
    assert s.status_code == 200, s.text
    row = _detail(db, rid)
    assert str(row["target_id"]) == owner
    assert row["detail"]["routed_via"] == "fallback"

    # a member WITH manage_agents qualifies (freshest wins)
    db.execute("""UPDATE agents SET grants='["manage_agents"]' WHERE id=%s""", (maya,))
    s = await client.post(
        f"/api/requests/{rid}/suggest-agent",
        json={
            "requester_agent_id": zed, "proposed_alias": "sentry",
            "proposed_role": "Monitoring", "proposed_prompt": "You watch errors.",
            "rationale": "No one owns alerts.",
        },
    )
    assert s.status_code == 200, s.text
    assert str(_detail(db, rid)["target_id"]) == maya
