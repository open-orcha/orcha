"""Per-user cosmetic preferences (mig 040) — GET/PUT /api/prefs.

Contract under test (portal_backend/user_pref_routes.py):

  * IDENTITY-level, not container-level: a login mapped as a live human in ANY
    project on the stack reads/writes its own prefs — no cid in the API at all.
  * GET  → {"prefs": {...}} for a trusted+mapped login ({} before the first
    write); {"prefs": null} (a 200!) for untrusted / unmapped — the frontend's
    explicit "stay on localStorage" signal, so self-host behavior never changes.
  * PUT  → whole-bag replace, upsert keyed by the LOWERCASED login. STRICT
    whitelist (theme / skin / sidebar / default_cid — no passthrough bucket):
    unknown keys 422; non-scalar values 422; >2KB payload 422. Untrusted or
    unmapped writers: 403.
  * Cosmetic-only by construction: nothing server-side reads user_prefs.
"""
import pytest

import pytest


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    """Prefs tests bind members via invites as SETUP — a Team-plan surface under
    the plan-gating addendum. This suite tests prefs, not the gate (that's
    tests/test_plan_gating.py), so it stays on the team plan."""
    monkeypatch.setenv("ORCHA_PLAN", "team")


OCTO = {"X-Auth-Request-User": "octocat"}      # bound owner of the arena
HUBOT = {"X-Auth-Request-User": "hubot"}       # invited member
KEDAR = {"X-Auth-Request-User": "kedar1607"}   # member of project B ONLY
MALLORY = {"X-Auth-Request-User": "mallory"}   # verified stranger — mapped nowhere


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture
def no_trust_proxy(monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)


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


# ---------- round-trip ----------

async def test_prefs_round_trip_per_login(client, container, make_agent, trust_proxy):
    """Each login owns an independent bag; first GET before any write is {}."""
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _invite(client, cid, "hubot")

    # mapped login, no row yet: prefs ACTIVE but empty — {} not null
    r = await client.get("/api/prefs", headers=OCTO)
    assert r.status_code == 200 and r.json() == {"prefs": {}}

    body = {"theme": "light", "skin": "swiss", "sidebar": "collapsed",
            "default_cid": cid}
    r = await client.put("/api/prefs", json={"prefs": body}, headers=OCTO)
    assert r.status_code == 200, r.text
    assert r.json() == {"prefs": body}
    r = await client.get("/api/prefs", headers=OCTO)
    assert r.json() == {"prefs": body}

    # hubot's bag is his own — octocat's write never leaks across logins
    r = await client.get("/api/prefs", headers=HUBOT)
    assert r.json() == {"prefs": {}}
    r = await client.put("/api/prefs", json={"prefs": {"theme": "dark"}}, headers=HUBOT)
    assert r.status_code == 200
    assert (await client.get("/api/prefs", headers=HUBOT)).json() == {
        "prefs": {"theme": "dark"}
    }
    assert (await client.get("/api/prefs", headers=OCTO)).json() == {"prefs": body}


async def test_put_is_whole_bag_replace(client, container, make_agent, trust_proxy):
    """Dropping a key from the bag UNSETS it (how the client clears the star)."""
    await _bind_owner(client, container, make_agent)
    await client.put(
        "/api/prefs",
        json={"prefs": {"theme": "dark", "default_cid": container["id"]}},
        headers=OCTO,
    )
    r = await client.put("/api/prefs", json={"prefs": {"theme": "dark"}}, headers=OCTO)
    assert r.status_code == 200
    assert (await client.get("/api/prefs", headers=OCTO)).json() == {
        "prefs": {"theme": "dark"}
    }


async def test_login_case_insensitive_upsert(
    client, container, make_agent, trust_proxy, db
):
    """The row is keyed by the LOWERCASED login — a differently-cased header
    (GitHub logins are case-insensitive) hits the same bag, never a second row."""
    await _bind_owner(client, container, make_agent)
    r = await client.put(
        "/api/prefs", json={"prefs": {"theme": "light"}},
        headers={"X-Auth-Request-User": "OctoCat"},
    )
    assert r.status_code == 200, r.text
    assert (await client.get("/api/prefs", headers=OCTO)).json() == {
        "prefs": {"theme": "light"}
    }
    rows = db.execute("SELECT github_login FROM user_prefs")
    assert [row["github_login"] for row in rows] == ["octocat"]


# ---------- strict whitelist + caps ----------

async def test_unknown_keys_rejected_422(client, container, make_agent, trust_proxy):
    """NO tolerant passthrough bucket: an unrecognized key is refused, named."""
    await _bind_owner(client, container, make_agent)
    r = await client.put(
        "/api/prefs",
        json={"prefs": {"theme": "dark", "autonomy_level": "full"}},
        headers=OCTO,
    )
    assert r.status_code == 422 and "autonomy_level" in r.text
    # nothing was stored
    assert (await client.get("/api/prefs", headers=OCTO)).json() == {"prefs": {}}


async def test_non_scalar_values_rejected_422(
    client, container, make_agent, trust_proxy
):
    await _bind_owner(client, container, make_agent)
    r = await client.put(
        "/api/prefs", json={"prefs": {"theme": {"nested": "no"}}}, headers=OCTO
    )
    assert r.status_code == 422 and "scalar" in r.text


async def test_size_cap_422(client, container, make_agent, trust_proxy):
    await _bind_owner(client, container, make_agent)
    r = await client.put(
        "/api/prefs", json={"prefs": {"theme": "x" * 3000}}, headers=OCTO
    )
    assert r.status_code == 422
    # a bag that squeaks under both caps is fine
    r = await client.put(
        "/api/prefs", json={"prefs": {"theme": "x" * 400}}, headers=OCTO
    )
    assert r.status_code == 200


async def test_prefs_must_be_an_object(client, container, make_agent, trust_proxy):
    await _bind_owner(client, container, make_agent)
    r = await client.put("/api/prefs", json={"prefs": "dark"}, headers=OCTO)
    assert r.status_code == 422  # pydantic: prefs is a dict


# ---------- trust / mapping gates ----------

async def test_untrusted_local_sentinel_round_trip(
    client, container, make_agent, no_trust_proxy
):
    """Trust off (self-host/laptop): the portal is a single-operator surface, so
    prefs collapse to ONE local-sentinel row — appearance now survives browser
    switches and app reinstalls on a laptop stack instead of dying with
    per-origin localStorage. The identity header is untrusted noise and is
    IGNORED (everything lands on the same sentinel row, header or not)."""
    await make_agent("root", "operator", kind="human")
    r = await client.get("/api/prefs", headers=OCTO)
    # server prefs are ACTIVE (empty) for the local operator — {} not null, so the
    # frontend mirrors its local picks up on the first write-through
    assert r.status_code == 200 and r.json() == {"prefs": {}}
    r = await client.put("/api/prefs", json={"prefs": {"theme": "dark"}}, headers=OCTO)
    assert r.status_code == 200
    # headerless read sees the same sentinel row — single operator, one bag
    r = await client.get("/api/prefs")
    assert r.status_code == 200 and r.json() == {"prefs": {"theme": "dark"}}


async def test_trusted_headerless_lane_null(client, container, make_agent, trust_proxy):
    """The break-glass team-token lane carries no user header: same null signal."""
    await _bind_owner(client, container, make_agent)
    r = await client.get("/api/prefs")
    assert r.status_code == 200 and r.json() == {"prefs": None}
    r = await client.put("/api/prefs", json={"prefs": {"theme": "dark"}})
    assert r.status_code == 403


async def test_trusted_unmapped_null_and_403(
    client, container, make_agent, trust_proxy
):
    """A verified stranger (mapped in NO project) gets the same null/403 as
    untrusted — appearance sync is for members of the stack, localStorage still
    works for everyone else."""
    await _bind_owner(client, container, make_agent)
    r = await client.get("/api/prefs", headers=MALLORY)
    assert r.status_code == 200 and r.json() == {"prefs": None}
    r = await client.put(
        "/api/prefs", json={"prefs": {"theme": "dark"}}, headers=MALLORY
    )
    assert r.status_code == 403 and "not a member of any project" in r.text


# ---------- cross-project identity ----------

async def test_identity_level_any_project_counts(
    client, container, make_agent, trust_proxy
):
    """kedar is a member of project B ONLY. Prefs are identity-level: his bag
    works regardless of which project the portal is viewing — no cid is asked,
    and being a non-member of project A changes nothing."""
    await _bind_owner(client, container, make_agent)

    # kedar founds project B (additional=true seeds him as its owner)
    r = await client.post(
        "/api/containers", json={"name": "proj-b", "additional": True}, headers=KEDAR
    )
    assert r.status_code == 201, r.text
    cid_b = r.json()["container_id"]
    me_b = (await client.get(f"/api/me?cid={cid_b}", headers=KEDAR)).json()
    assert me_b["identity"] and me_b["identity"]["github_login"] == "kedar1607"

    # in project A kedar is identity-null (viewer) — but /api/prefs doesn't care:
    me_a = (await client.get(f"/api/me?cid={container['id']}", headers=KEDAR)).json()
    assert me_a == {"identity": None, "trusted": True}

    r = await client.put(
        "/api/prefs", json={"prefs": {"theme": "light"}}, headers=KEDAR
    )
    assert r.status_code == 200, r.text
    assert (await client.get("/api/prefs", headers=KEDAR)).json() == {
        "prefs": {"theme": "light"}
    }


# ---------- cosmetic-only guarantee ----------

async def test_prefs_never_touch_project_state(
    client, container, make_agent, trust_proxy, db
):
    """Writes land in user_prefs and NOWHERE else: no agent row, no container
    field, no event — the cosmetic-only-by-construction claim, checked."""
    await _bind_owner(client, container, make_agent)
    before_agents = db.execute("SELECT id, member_role, grants FROM agents ORDER BY id")
    before_container = db.execute(
        "SELECT autonomy_level, wakes_enabled FROM containers"
    )
    before_events = db.execute("SELECT count(*) AS n FROM events")[0]["n"]
    r = await client.put(
        "/api/prefs",
        json={"prefs": {"theme": "light", "default_cid": container["id"]}},
        headers=OCTO,
    )
    assert r.status_code == 200
    assert db.execute("SELECT id, member_role, grants FROM agents ORDER BY id") == before_agents
    assert db.execute("SELECT autonomy_level, wakes_enabled FROM containers") == before_container
    # the write emitted NO project event — setup's own events are all there is
    assert db.execute("SELECT count(*) AS n FROM events")[0]["n"] == before_events
