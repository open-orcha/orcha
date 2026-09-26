"""Collab v1 — proxy GitHub identity (/api/me + the binding rule), project members
(roles, invites, removal), and owner-assigned task reviewers.

Trust model under test: the X-Auth-Request-User header is read ONLY when
ORCHA_TRUST_PROXY_USER=1 (the cloud proxy deployment); self-hosters leave it unset and
the header is inert. Env is read per-request, so monkeypatch flips it per test.
"""
import uuid

import pytest

OCTO = {"X-Auth-Request-User": "octocat"}


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture
def no_trust_proxy(monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    """This module exercises member mutations (invite/role/grants/remove) —
    a Team-plan feature under the plan-gating addendum
    (docs/orcha-cloud-local-run.md). Solo-tier 402 behavior is covered by
    tests/test_plan_gating.py; this suite stays on the team plan so its
    access-model assertions are unaffected by the gate."""
    monkeypatch.setenv("ORCHA_PLAN", "team")


async def _members(client, cid):
    r = await client.get(f"/api/containers/{cid}/members")
    assert r.status_code == 200, r.text
    return r.json()["members"]


# ---------- /api/me + the binding rule ----------

async def test_me_untrusted_header_ignored(client, container, make_agent, no_trust_proxy):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={cid}", headers=OCTO)
    assert r.status_code == 200, r.text
    assert r.json() == {"identity": None, "trusted": False}
    # nothing was bound: the human keeps its unix-y alias and stays unmapped
    m = (await _members(client, cid))[0]
    assert m["alias"] == "root" and m["github_login"] is None


async def test_me_binds_first_unmapped_human(client, container, make_agent, trust_proxy):
    """The root-human fix: the first verified GitHub arrival IS the founding human —
    bound, renamed to the login, and promoted to owner. Idempotent across the 3s poll."""
    cid = container["id"]
    a = await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={cid}", headers=OCTO)
    assert r.status_code == 200, r.text
    ident = r.json()["identity"]
    assert ident == {
        "agent_id": a["agent_id"],
        "alias": "octocat",
        "github_login": "octocat",
        "member_role": "owner",
        # access model (mig 039): the identity carries the member's own grant set so
        # the frontend gates affordances off the same source the server enforces
        "grants": [],
        "avatar_url": "https://github.com/octocat.png",
    }
    # idempotent: a re-poll (and a case-variant login) resolves, never re-binds
    again = (await client.get(f"/api/me?cid={cid}", headers=OCTO)).json()["identity"]
    assert again == ident
    cased = (await client.get(
        f"/api/me?cid={cid}", headers={"X-Auth-Request-User": "OctoCat"}
    )).json()["identity"]
    assert cased["agent_id"] == a["agent_id"] and cased["github_login"] == "octocat"


async def test_me_signin_clears_pending(client, container, make_agent, db, trust_proxy):
    """The live-feedback bug: the signed-in owner must NOT read as pending. `pending`
    means invited-but-never-signed-in, and /api/me stamps presence (last_heartbeat_at)
    exactly once on BOTH resolution paths — bind and match."""
    cid = container["id"]
    await make_agent("root", "operator", kind="human")

    # BIND path: the founding human bound by first arrival is immediately not pending
    await client.get(f"/api/me?cid={cid}", headers=OCTO)
    me = (await _members(client, cid))[0]
    assert me["github_login"] == "octocat" and me["pending"] is False
    stamp = db.execute(
        "SELECT last_heartbeat_at FROM agents WHERE id=%s", (me["agent_id"],)
    )[0]["last_heartbeat_at"]
    assert stamp is not None
    # stamped ONCE: a re-poll resolves via MATCH without moving the presence stamp
    # (ongoing activity is bump_agent's job, not the sign-in mark's)
    await client.get(f"/api/me?cid={cid}", headers=OCTO)
    again = db.execute(
        "SELECT last_heartbeat_at FROM agents WHERE id=%s", (me["agent_id"],)
    )[0]["last_heartbeat_at"]
    assert again == stamp

    # MATCH path: an invitee stays pending until THEIR first sign-in flips it
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "hubot", "role": "member"},
        headers=OCTO,
    )
    assert r.status_code == 201 and r.json()["pending"] is True
    hubot_hdr = {"X-Auth-Request-User": "hubot"}
    ident = (await client.get(f"/api/me?cid={cid}", headers=hubot_hdr)).json()["identity"]
    assert ident and ident["github_login"] == "hubot"
    hubot = [m for m in await _members(client, cid) if m["github_login"] == "hubot"][0]
    assert hubot["pending"] is False


async def test_me_second_distinct_user_is_unmapped(client, container, make_agent, trust_proxy):
    """Once ANY human is mapped, arrivals stop binding — membership is invite-only."""
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    await client.get(f"/api/me?cid={cid}", headers=OCTO)
    r = await client.get(f"/api/me?cid={cid}", headers={"X-Auth-Request-User": "hubot"})
    assert r.status_code == 200 and r.json() == {"identity": None, "trusted": True}
    members = await _members(client, cid)
    assert len(members) == 1 and members[0]["github_login"] == "octocat"


async def test_me_binding_keeps_alias_on_collision(client, container, make_agent, trust_proxy):
    """An agent already aliased like the login must not break the bind (alias is UNIQUE
    per container) — the human is bound and promoted but keeps its original alias."""
    cid = container["id"]
    await make_agent("octocat", "worker", kind="ai")
    h = await make_agent("root", "operator", kind="human")
    ident = (await client.get(f"/api/me?cid={cid}", headers=OCTO)).json()["identity"]
    assert ident["agent_id"] == h["agent_id"]
    assert ident["alias"] == "root" and ident["github_login"] == "octocat"


async def test_me_no_humans_and_bad_cid(client, container, trust_proxy):
    cid = container["id"]  # fresh container: no humans registered yet
    r = await client.get(f"/api/me?cid={cid}", headers=OCTO)
    assert r.status_code == 200 and r.json() == {"identity": None, "trusted": True}
    assert (await client.get("/api/me?cid=not-a-uuid", headers=OCTO)).status_code == 400
    assert (await client.get(f"/api/me?cid={uuid.uuid4()}", headers=OCTO)).status_code == 404


# ---------- members: list / invite / role / remove ----------

async def test_first_human_registers_as_owner(client, container, make_agent, no_trust_proxy):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    await make_agent("bot", "worker", kind="ai")
    second = await make_agent("ada", "operator", kind="human")
    members = await _members(client, cid)
    assert [(m["alias"], m["member_role"]) for m in members] == [
        ("root", "owner"), ("ada", "member"),
    ]
    assert all(m["pending"] is False for m in members)  # no github_login → not "invited"
    assert second["agent_id"] == members[1]["agent_id"]


async def test_invite_flow_trust_off_actor_param(client, container, make_agent, no_trust_proxy):
    cid = container["id"]
    owner = await make_agent("root", "operator", kind="human")
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "hubot", "role": "member", "actor_agent_id": owner["agent_id"]},
    )
    assert r.status_code == 201, r.text
    m = r.json()
    assert m["alias"] == "hubot" and m["github_login"] == "hubot"
    assert m["member_role"] == "member" and m["pending"] is True

    # duplicate login (any casing) → 409
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "HuBot", "role": "member", "actor_agent_id": owner["agent_id"]},
    )
    assert r.status_code == 409, r.text


async def test_invite_gates(client, container, make_agent, no_trust_proxy):
    cid = container["id"]
    owner = await make_agent("root", "operator", kind="human")
    member = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "hubot", "actor_agent_id": owner["agent_id"]},
    )
    hubot = member.json()["agent_id"]
    ai = await make_agent("bot", "worker", kind="ai")

    # a plain member cannot invite
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "third", "actor_agent_id": hubot},
    )
    assert r.status_code == 403, r.text
    # an AI cannot invite (human gate)
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "third", "actor_agent_id": ai["agent_id"]},
    )
    assert r.status_code == 403, r.text
    # no actor at all (trust off) → 400 per the shared require_kind convention
    r = await client.post(
        f"/api/containers/{cid}/members", json={"github_login": "third"}
    )
    assert r.status_code == 400, r.text
    # a malformed login never reaches the DB
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "-bad-", "actor_agent_id": owner["agent_id"]},
    )
    assert r.status_code == 422, r.text


async def test_invite_and_gate_via_trusted_header(client, container, make_agent, trust_proxy):
    """With proxy trust ON the header IS the actor: the bound owner needs no body actor;
    a verified non-member is refused even if it names a valid actor id."""
    cid = container["id"]
    owner = await make_agent("root", "operator", kind="human")
    await client.get(f"/api/me?cid={cid}", headers=OCTO)  # bind octocat as owner

    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "hubot", "role": "member"},
        headers=OCTO,
    )
    assert r.status_code == 201, r.text
    assert r.json()["pending"] is True
    hubot_id = r.json()["agent_id"]

    # hubot (a plain member) arriving through the proxy cannot invite
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "third"},
        headers={"X-Auth-Request-User": "hubot"},
    )
    assert r.status_code == 403, r.text
    # a verified stranger is not a member at all — actor smuggling doesn't help
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "third", "actor_agent_id": owner["agent_id"]},
        headers={"X-Auth-Request-User": "mallory"},
    )
    assert r.status_code == 403, r.text
    # trust-on removal needs NO body at all — the header is the actor
    r = await client.request(
        "DELETE", f"/api/containers/{cid}/members/{hubot_id}", headers=OCTO
    )
    assert r.status_code == 200, r.text


async def test_member_pending_clears_on_activity(client, container, make_agent, db, no_trust_proxy):
    cid = container["id"]
    owner = await make_agent("root", "operator", kind="human")
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "hubot", "actor_agent_id": owner["agent_id"]},
    )
    aid = r.json()["agent_id"]
    assert r.json()["pending"] is True
    db.execute("UPDATE agents SET last_heartbeat_at=now() WHERE id=%s", (aid,))
    hubot = [m for m in await _members(client, cid) if m["agent_id"] == aid][0]
    assert hubot["pending"] is False


async def test_role_change_and_last_owner_guard(client, container, make_agent, no_trust_proxy):
    cid = container["id"]
    owner = await make_agent("root", "operator", kind="human")
    oid = owner["agent_id"]
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "hubot", "actor_agent_id": oid},
    )
    hubot = r.json()["agent_id"]

    # demoting the LAST owner is refused
    r = await client.patch(
        f"/api/containers/{cid}/members/{oid}",
        json={"role": "member", "actor_agent_id": oid},
    )
    assert r.status_code == 400, r.text

    # promote hubot → two owners; now the founder can step down
    r = await client.patch(
        f"/api/containers/{cid}/members/{hubot}",
        json={"role": "owner", "actor_agent_id": oid},
    )
    assert r.status_code == 200 and r.json()["member_role"] == "owner"
    r = await client.patch(
        f"/api/containers/{cid}/members/{oid}",
        json={"role": "member", "actor_agent_id": oid},
    )
    assert r.status_code == 200 and r.json()["member_role"] == "member"

    # ...and the demoted founder can no longer gate-keep
    r = await client.patch(
        f"/api/containers/{cid}/members/{hubot}",
        json={"role": "member", "actor_agent_id": oid},
    )
    assert r.status_code == 403, r.text


async def test_remove_member_reuses_retire_and_guards_last_owner(
    client, container, make_agent, make_task, db, no_trust_proxy
):
    cid = container["id"]
    owner = await make_agent("root", "operator", kind="human")
    oid = owner["agent_id"]
    hubot = (await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "hubot", "actor_agent_id": oid},
    )).json()["agent_id"]

    # a task reviewed by hubot reverts to "anyone" on removal
    t = await make_task("ship", "shipped")
    r = await client.put(
        f"/api/tasks/{t['id']}/reviewer",
        json={"reviewer_agent_id": hubot, "actor_agent_id": oid},
    )
    assert r.status_code == 200, r.text

    # removing the last owner is refused; a member removing anyone is refused
    r = await client.request(
        "DELETE", f"/api/containers/{cid}/members/{oid}",
        json={"actor_agent_id": oid},
    )
    assert r.status_code == 400, r.text
    r = await client.request(
        "DELETE", f"/api/containers/{cid}/members/{oid}",
        json={"actor_agent_id": hubot},
    )
    assert r.status_code == 403, r.text

    r = await client.request(
        "DELETE", f"/api/containers/{cid}/members/{hubot}",
        json={"actor_agent_id": oid},
    )
    assert r.status_code == 200, r.text
    assert r.json()["cleared_reviewer_on"] == [t["id"]]
    # retire semantics, not a hard delete: the row survives, terminated
    row = db.execute("SELECT terminated_at, status FROM agents WHERE id=%s", (hubot,))[0]
    assert row["terminated_at"] is not None and row["status"] == "terminated"
    assert [m["agent_id"] for m in await _members(client, cid)] == [oid]
    # the task's reviewer really is cleared (snapshot view)
    snap = (await client.get(f"/api/containers/{cid}")).json()
    task = [x for x in snap["tasks"] if x["id"] == t["id"]][0]
    assert task["reviewer_agent_id"] is None and task["reviewer"] is None
    # removing an already-removed member is a 404 (no live human row)
    r = await client.request(
        "DELETE", f"/api/containers/{cid}/members/{hubot}",
        json={"actor_agent_id": oid},
    )
    assert r.status_code == 404, r.text


# ---------- reviewer assignment + snapshot surfacing ----------

async def test_reviewer_put_validations(client, container, make_agent, make_task, no_trust_proxy):
    cid = container["id"]
    owner = await make_agent("root", "operator", kind="human")
    oid = owner["agent_id"]
    ai = await make_agent("bot", "worker", kind="ai")
    t = await make_task("ship", "shipped")

    # target must be a human member of the task's container — 400 otherwise
    for bad in (ai["agent_id"], str(uuid.uuid4())):
        r = await client.put(
            f"/api/tasks/{t['id']}/reviewer",
            json={"reviewer_agent_id": bad, "actor_agent_id": oid},
        )
        assert r.status_code == 400, r.text
    r = await client.put(
        f"/api/tasks/{t['id']}/reviewer",
        json={"reviewer_agent_id": "not-a-uuid", "actor_agent_id": oid},
    )
    assert r.status_code == 400, r.text

    # owner assigns a human member; snapshot tasks carry id + resolved chip
    hubot = (await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "hubot", "actor_agent_id": oid},
    )).json()["agent_id"]
    r = await client.put(
        f"/api/tasks/{t['id']}/reviewer",
        json={"reviewer_agent_id": hubot, "actor_agent_id": oid},
    )
    assert r.status_code == 200, r.text
    assert r.json()["reviewer"] == {
        "agent_id": hubot, "alias": "hubot", "github_login": "hubot",
    }
    snap = (await client.get(f"/api/containers/{cid}")).json()
    task = [x for x in snap["tasks"] if x["id"] == t["id"]][0]
    assert task["reviewer_agent_id"] == hubot
    assert task["reviewer"]["alias"] == "hubot"
    assert task["reviewer"]["github_login"] == "hubot"

    # null clears back to anyone
    r = await client.put(
        f"/api/tasks/{t['id']}/reviewer",
        json={"reviewer_agent_id": None, "actor_agent_id": oid},
    )
    assert r.status_code == 200 and r.json()["reviewer"] is None

    # a plain member cannot assign reviewers (owner gate)
    r = await client.put(
        f"/api/tasks/{t['id']}/reviewer",
        json={"reviewer_agent_id": hubot, "actor_agent_id": hubot},
    )
    assert r.status_code == 403, r.text

    # unknown task → 404; malformed id → 400
    r = await client.put(
        f"/api/tasks/{uuid.uuid4()}/reviewer",
        json={"reviewer_agent_id": None, "actor_agent_id": oid},
    )
    assert r.status_code == 404, r.text
    r = await client.put(
        "/api/tasks/nope/reviewer", json={"reviewer_agent_id": None, "actor_agent_id": oid}
    )
    assert r.status_code == 400, r.text


# NOTE: the reviewer route's "wrong container" 400 branch was defensive-only while
# `containers_singleton` (Orcha#28) forbade a second container; mig 037 (multi-project,
# see test_cross_container.py) made it reachable. The kind/terminated/unknown branches
# above pin the guard's shape; cross-container scoping is pinned in test_cross_container.
