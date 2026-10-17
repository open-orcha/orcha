"""D14 — the canonical per-project icon store (mig 050 `containers.icon`).

Contract under test:
  * PUT /api/containers/{cid}/icon {icon: <shape>|null} sets or clears the project's icon.
    Shape: {"kind":"emoji","value":"🚀"} | {"kind":"glyph","value":<known glyph>,
    "color":0-9|null} — the exact shape the desktop host stores. Anything else is 422.
  * The icon is exposed on GET /api/containers and on the snapshot `container` object
    (the desktop poller and the portal sidebar read it there — no extra call).
  * Authorised like other project-setting writes: trusted lane = owner or a
    manage_autonomy holder; a plain member, a viewer and a non-member are refused.
    Trust off stays open (self-host). Every change is audit-logged.
"""
import pytest


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


async def _put(client, cid, icon, headers=None):
    return await client.put(f"/api/containers/{cid}/icon", json={"icon": icon}, headers=headers or {})


async def _listed_icon(client, cid, headers=None):
    rows = (await client.get("/api/containers", headers=headers or {})).json()["containers"]
    return next(r for r in rows if str(r["id"]) == str(cid))["icon"]


async def test_default_is_null_everywhere(client, container, no_trust_proxy, db):
    cid = container["id"]
    assert db.execute("SELECT icon FROM containers WHERE id=%s", (cid,))[0]["icon"] is None
    assert await _listed_icon(client, cid) is None
    snap = (await client.get(f"/api/containers/{cid}")).json()
    assert snap["container"]["icon"] is None


async def test_set_read_back_and_clear(client, container, no_trust_proxy, db):
    cid = container["id"]
    r = await _put(client, cid, {"kind": "emoji", "value": "🚀"})
    assert r.status_code == 200, r.text
    assert r.json() == {"container_id": cid, "icon": {"kind": "emoji", "value": "🚀"}}
    assert await _listed_icon(client, cid) == {"kind": "emoji", "value": "🚀"}
    snap = (await client.get(f"/api/containers/{cid}")).json()
    assert snap["container"]["icon"] == {"kind": "emoji", "value": "🚀"}

    # a glyph without a colour normalizes to color: null
    r = await _put(client, cid, {"kind": "glyph", "value": "rocket"})
    assert r.status_code == 200, r.text
    assert r.json()["icon"] == {"kind": "glyph", "value": "rocket", "color": None}
    r = await _put(client, cid, {"kind": "glyph", "value": "database", "color": 3})
    assert r.json()["icon"] == {"kind": "glyph", "value": "database", "color": 3}
    assert await _listed_icon(client, cid) == {"kind": "glyph", "value": "database", "color": 3}

    # null resets to the default glyph
    r = await _put(client, cid, None)
    assert r.status_code == 200 and r.json()["icon"] is None
    assert db.execute("SELECT icon FROM containers WHERE id=%s", (cid,))[0]["icon"] is None

    events = db.execute(
        "SELECT event_type, detail FROM events WHERE container_id=%s "
        "AND event_type='project_icon_changed' ORDER BY id",
        (cid,),
    )
    assert [e["detail"]["icon"] for e in events] == [
        {"kind": "emoji", "value": "🚀"},
        {"kind": "glyph", "value": "rocket", "color": None},
        {"kind": "glyph", "value": "database", "color": 3},
        None,
    ]


@pytest.mark.parametrize("icon", [
    {"kind": "emoji", "value": "OW"},              # initials are not an icon
    {"kind": "emoji", "value": "<b>x</b>"},
    {"kind": "emoji", "value": "🚀" * 20},          # too long
    {"kind": "emoji", "value": ""},
    {"kind": "glyph", "value": "not-a-glyph"},
    {"kind": "glyph", "value": "rocket", "color": 10},
    {"kind": "glyph", "value": "rocket", "color": -1},
    {"kind": "glyph", "value": "rocket", "color": True},
    {"kind": "glyph", "value": "rocket", "color": "3"},
    {"kind": "image", "value": "https://evil.example/x.png"},
    {"value": "🚀"},
])
async def test_malformed_icons_are_422(client, container, no_trust_proxy, db, icon):
    r = await _put(client, container["id"], icon)
    assert r.status_code == 422, r.text
    assert db.execute("SELECT icon FROM containers WHERE id=%s", (container["id"],))[0]["icon"] is None


async def test_bad_container_ids(client, container, no_trust_proxy):
    r = await _put(client, "not-a-uuid", {"kind": "emoji", "value": "🚀"})
    assert r.status_code == 400
    r = await _put(client, "3f2b8c1e-5a4d-4e0b-9c7a-1d2e3f4a5b6c", {"kind": "emoji", "value": "🚀"})
    assert r.status_code == 404


async def test_trusted_lane_owner_and_grant_holder_may_set(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    r = await _put(client, cid, {"kind": "emoji", "value": "🦩"}, OCTO)
    assert r.status_code == 200, r.text

    hubot = await _invite(client, cid, "hubot")
    r = await _put(client, cid, {"kind": "emoji", "value": "🧪"}, HUBOT)
    assert r.status_code == 403, "a plain member may not change the project icon"
    r = await client.patch(
        f"/api/containers/{cid}/members/{hubot}",
        json={"grants": ["manage_autonomy"]},
        headers=OCTO,
    )
    assert r.status_code == 200, r.text
    r = await _put(client, cid, {"kind": "emoji", "value": "🧪"}, HUBOT)
    assert r.status_code == 200, r.text
    assert await _listed_icon(client, cid, OCTO) == {"kind": "emoji", "value": "🧪"}


async def test_trusted_lane_viewer_and_stranger_refused(client, container, make_agent, trust_proxy, db):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _invite(client, cid, "vera", role="viewer")
    r = await _put(client, cid, {"kind": "emoji", "value": "🚀"}, VERA)
    assert r.status_code == 403
    r = await _put(client, cid, {"kind": "emoji", "value": "🚀"}, MALLORY)
    assert r.status_code == 403
    assert db.execute("SELECT icon FROM containers WHERE id=%s", (cid,))[0]["icon"] is None
    # viewers still READ the icon (it is on the list + snapshot they can see)
    await _put(client, cid, {"kind": "glyph", "value": "leaf", "color": 1}, OCTO)
    snap = (await client.get(f"/api/containers/{cid}", headers=VERA)).json()
    assert snap["container"]["icon"] == {"kind": "glyph", "value": "leaf", "color": 1}


async def test_route_is_in_openapi(client):
    spec = (await client.get("/openapi.json")).json()
    op = spec["paths"]["/api/containers/{cid}/icon"]["put"]
    assert "requestBody" in op
