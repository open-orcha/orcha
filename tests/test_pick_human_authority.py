"""Human routing must land on someone who can ACT (guards.pick_human / find_actionable_human).

Bug (e2e prep): agent requests with no target, /escalate, /suggest-agent and the
expires_at sweep route to `pick_human` — "the most recently active live human". Viewers
were not excluded, so a read-only viewer who merely browsed last (their sign-in stamps
last_heartbeat_at) received every "ask the human" request and could never answer it.

Contract under test:
  * a viewer is NEVER picked — the freshest non-viewer (owner/member) is;
  * under proxy trust a login-less human (CLI-registered, not a portal member) ranks
    behind every github_login-carrying member (last-resort tier only);
  * only-viewer project → pick_human 409s (the request is refused, never parked on a
    viewer); the wake-breaker's non-raising lookup returns None (log-safe no-op);
  * self-host (trust off, no viewers) keeps plain most-recent-human routing;
  * an owner cannot name a viewer as a task's reviewer (a viewer can never /verify).
"""
import pytest

OCTO = {"X-Auth-Request-User": "octocat"}   # bound owner
VERA = {"X-Auth-Request-User": "vera"}      # invited viewer


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture
def no_trust_proxy(monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")  # member invites are a Team-plan feature


def _touch(db, agent_id, seconds_ago=0):
    """Make a human look recently active (what a sign-in / message turn stamps)."""
    db.execute(
        "UPDATE agents SET last_heartbeat_at = now() - make_interval(secs => %s) WHERE id=%s",
        (seconds_ago, agent_id),
    )


def _set_role(db, agent_id, role):
    db.execute("UPDATE agents SET member_role=%s WHERE id=%s", (role, agent_id))


def _target(db, rid):
    return str(db.execute("SELECT target_id FROM requests WHERE id=%s", (rid,))[0]["target_id"])


async def _owner_and_viewer(client, container, make_agent):
    """Trusted arena: octocat bound as owner, vera invited as a viewer."""
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    owner_id = r.json()["identity"]["agent_id"]
    r = await client.post(
        f"/api/containers/{container['id']}/members",
        json={"github_login": "vera", "role": "viewer"},
        headers=OCTO,
    )
    assert r.status_code == 201, r.text
    return owner_id, r.json()["agent_id"]


# ---------- trusted (cloud) lane ----------

async def test_untargeted_request_skips_freshest_viewer(
    client, db, container, make_agent, make_request, trust_proxy
):
    owner_id, viewer_id = await _owner_and_viewer(client, container, make_agent)
    _touch(db, owner_id, seconds_ago=3600)
    # The viewer signs in last — pre-fix this made them the pick.
    r = await client.get(f"/api/me?cid={container['id']}", headers=VERA)
    assert r.status_code == 200 and r.json()["identity"]["member_role"] == "viewer"
    _touch(db, viewer_id, seconds_ago=0)

    ai = await make_agent("worker1")
    req = await make_request(ai["agent_id"], "need a decision")  # no target
    assert _target(db, req["id"]) == owner_id


async def test_escalate_and_sweep_skip_viewer(
    client, db, container, make_agent, make_request, trust_proxy
):
    owner_id, viewer_id = await _owner_and_viewer(client, container, make_agent)
    _touch(db, owner_id, seconds_ago=3600)
    _touch(db, viewer_id, seconds_ago=0)
    ai = await make_agent("worker1")
    peer = await make_agent("worker2")

    req = await make_request(ai["agent_id"], "escalate me", target_alias="worker2")
    r = await client.post(
        f"/api/requests/{req['id']}/escalate",
        json={"requester_agent_id": ai["agent_id"]},
    )
    assert r.status_code == 200, r.text
    assert _target(db, req["id"]) == owner_id

    # expires_at sweep re-targets expired AI-targeted asks at a human, too.
    req2 = await make_request(ai["agent_id"], "expire me", target_alias="worker2")
    db.execute("UPDATE requests SET expires_at = now() - interval '1 minute' WHERE id=%s",
               (req2["id"],))
    r = await client.post(
        f"/api/containers/{container['id']}/sweep",
        params={"actor_agent_id": owner_id},
        headers=OCTO,
    )
    assert r.status_code == 200, r.text
    assert _target(db, req2["id"]) == owner_id
    assert peer["agent_id"]


async def test_member_preferred_over_login_less_human_under_trust(
    client, db, container, make_agent, make_request, trust_proxy
):
    owner_id, _viewer = await _owner_and_viewer(client, container, make_agent)
    _touch(db, owner_id, seconds_ago=3600)
    # A CLI-registered human with no github_login: not a portal member under proxy trust.
    cli_human = await make_agent("cli-op", "operator", kind="human")
    _touch(db, cli_human["agent_id"], seconds_ago=0)

    ai = await make_agent("worker1")
    req = await make_request(ai["agent_id"], "who answers?")
    assert _target(db, req["id"]) == owner_id


async def test_only_viewers_refuses_instead_of_routing_to_viewer(
    client, db, container, make_agent, trust_proxy
):
    h = await make_agent("root", "operator", kind="human")
    _set_role(db, h["agent_id"], "viewer")
    ai = await make_agent("worker1")

    r = await client.post(
        f"/api/containers/{container['id']}/requests",
        json={"requester_agent_id": ai["agent_id"], "payload": "anyone?", "type": "info"},
    )
    assert r.status_code == 409, r.text
    assert "viewer" in r.text
    assert db.execute("SELECT 1 FROM requests WHERE container_id=%s", (container["id"],)) == []


async def test_escalate_with_only_viewers_leaves_request_untouched(
    client, db, container, make_agent, make_request, no_trust_proxy
):
    h = await make_agent("root", "operator", kind="human")
    ai = await make_agent("worker1")
    await make_agent("worker2")
    req = await make_request(ai["agent_id"], "escalate me", target_alias="worker2")
    worker2_id = _target(db, req["id"])
    _set_role(db, h["agent_id"], "viewer")

    r = await client.post(
        f"/api/requests/{req['id']}/escalate",
        json={"requester_agent_id": ai["agent_id"]},
    )
    assert r.status_code == 409, r.text
    assert _target(db, req["id"]) == worker2_id  # not re-targeted at the viewer


async def test_wake_breaker_lookup_is_none_for_viewer_only(container, make_agent, db):
    from portal_backend.database import db_cursor
    from portal_backend.guards import find_actionable_human

    h = await make_agent("root", "operator", kind="human")
    with db_cursor() as (_conn, cur):
        assert find_actionable_human(cur, container["id"]) == h["agent_id"]
    _set_role(db, h["agent_id"], "viewer")
    with db_cursor() as (_conn, cur):
        assert find_actionable_human(cur, container["id"]) is None


# ---------- self-host (trust off) ----------

async def test_self_host_most_recent_human_preserved(
    client, db, container, make_agent, make_request, no_trust_proxy
):
    a = await make_agent("alice", "operator", kind="human")   # owner (first human)
    b = await make_agent("bob", "operator", kind="human")     # member
    _touch(db, a["agent_id"], seconds_ago=3600)
    _touch(db, b["agent_id"], seconds_ago=0)
    ai = await make_agent("worker1")
    req = await make_request(ai["agent_id"], "q1")
    assert _target(db, req["id"]) == b["agent_id"]  # unchanged: freshest human wins

    # ...but a viewer is skipped even on self-host.
    _set_role(db, b["agent_id"], "viewer")
    req2 = await make_request(ai["agent_id"], "q2")
    assert _target(db, req2["id"]) == a["agent_id"]


# ---------- reviewer routing ----------

async def test_viewer_cannot_be_named_reviewer(
    client, container, make_agent, make_task, trust_proxy
):
    owner_id, viewer_id = await _owner_and_viewer(client, container, make_agent)
    t = await make_task("T", "done")
    r = await client.put(
        f"/api/tasks/{t['id']}/reviewer",
        json={"reviewer_agent_id": viewer_id, "actor_agent_id": owner_id},
        headers=OCTO,
    )
    assert r.status_code == 400, r.text
    assert "viewer" in r.text
    r = await client.put(
        f"/api/tasks/{t['id']}/reviewer",
        json={"reviewer_agent_id": owner_id, "actor_agent_id": owner_id},
        headers=OCTO,
    )
    assert r.status_code == 200, r.text
