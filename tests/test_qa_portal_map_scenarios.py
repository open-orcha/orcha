"""Orcha QA portal: the app map (import merged per source, replace_source, native observe
matching, blocked screens, features) and scenarios (propose → created / updated / suggested,
the human-only status and suggestion decisions, revise, evidence, export.md)."""
import pytest
from conftest import run_task_id


@pytest.fixture
async def people(make_agent):
    human = await make_agent("Hussein", "owner", kind="human")
    bot = await make_agent("qa-bot")
    return {"human": human["agent_id"], "bot": bot["agent_id"]}


async def _import(client, cid, actor, source, nodes=(), edges=(), features=(), replace=False, platform="ios"):
    r = await client.post(f"/api/containers/{cid}/qa/map/import", json={
        "actor_agent_id": actor, "platform": platform, "source": source, "nodes": list(nodes),
        "edges": list(edges), "features": list(features), "replace_source": replace})
    assert r.status_code == 200, r.text
    return r.json()["counts"]


async def _map(client, cid, platform="ios"):
    r = await client.get(f"/api/containers/{cid}/qa/map", params={"platform": platform})
    assert r.status_code == 200, r.text
    m = r.json()
    return m, {n["key"]: n for n in m["nodes"]}


CART = {"kind": "screen", "key": "cart", "label": "Cart", "feature_key": "checkout",
        "detail": {"title": "Your cart", "texts": ["Your cart", "Subtotal", "Check out", "Remove item"]}}
SETTINGS = {"kind": "screen", "key": "settings", "label": "SettingsView",
            "detail": {"title": "Settings", "texts": ["Settings", "Notifications", "Sign out", "Privacy"]}}


# ---------------------------------------------------------------- import / merge

async def test_import_merges_per_source_and_replace_drops_only_that_source(client, container, people):
    cid, bot = container["id"], people["bot"]
    counts = await _import(client, cid, bot, "code", nodes=[CART, SETTINGS],
                           edges=[{"kind": "navigates", "from_key": "settings", "to_key": "cart", "label": "Cart tab"},
                                  {"kind": "navigates", "from_key": "nowhere", "to_key": "cart"}],
                           features=[{"name": "Checkout", "summary": "Buy things", "paths": ["cart"]}])
    assert counts["nodes_added"] == 2 and counts["edges_added"] == 1 and counts["edges_skipped"] == 1
    assert counts["features"] == 1
    m, nodes = await _map(client, cid)
    assert nodes["cart"]["state"] == "declared" and nodes["cart"]["sources"] == ["code"]
    assert nodes["cart"]["feature_key"] == "checkout"
    assert "texts" not in nodes["cart"]["detail"]["code"]  # matching bookkeeping is not shown
    assert m["features"][0]["key"] == "checkout" and m["last_build"]["source"] == "code"
    assert m["edges"][0]["from_key"] == "settings" and m["edges"][0]["to_key"] == "cart"

    # a second source joins; the code part is untouched
    await _import(client, cid, bot, "tests", nodes=[{"kind": "screen", "key": "cart", "label": "CartRobot",
                                                      "evidence": ["CartTests.swift:12"]}])
    _, nodes = await _map(client, cid)
    assert nodes["cart"]["sources"] == ["code", "tests"] and nodes["cart"]["label"] == "Cart"
    assert nodes["cart"]["evidence"]["tests"] == ["CartTests.swift:12"]

    # the same source again without replace joins its lists
    await _import(client, cid, bot, "tests", nodes=[{"kind": "screen", "key": "cart",
                                                      "evidence": ["CartUITests.swift:40"]}])
    _, nodes = await _map(client, cid)
    assert nodes["cart"]["evidence"]["tests"] == ["CartTests.swift:12", "CartUITests.swift:40"]

    # a code rebuild that no longer lists settings: its code part goes (and the row, nobody else
    # speaks for it); cart keeps its tests part
    counts = await _import(client, cid, bot, "code", nodes=[CART], replace=True)
    assert counts["nodes_removed"] == 1
    m, nodes = await _map(client, cid)
    assert set(nodes) == {"cart"} and nodes["cart"]["sources"] == ["code", "tests"]
    assert m["edges"] == []  # went with the settings node

    # replacing tests with nothing leaves the code part
    await _import(client, cid, bot, "tests", nodes=[], replace=True)
    _, nodes = await _map(client, cid)
    assert nodes["cart"]["sources"] == ["code"]


async def test_import_validates(client, container, people):
    cid = container["id"]
    r = await client.post(f"/api/containers/{cid}/qa/map/import", json={
        "actor_agent_id": people["bot"], "platform": "tvos", "source": "code"})
    assert r.status_code == 422
    r = await client.post(f"/api/containers/{cid}/qa/map/import", json={
        "actor_agent_id": people["bot"], "platform": "ios", "source": "magic"})
    assert r.status_code == 422
    r = await client.get(f"/api/containers/{cid}/qa/map", params={"platform": "tvos"})
    assert r.status_code == 400


# ---------------------------------------------------------------- observe

async def _session(client, cid, actor, platform="ios"):
    r = await client.post(f"/api/containers/{cid}/qa/sessions",
                          json={"actor_agent_id": actor, "kind": "map", "platform": platform, "task_id": await run_task_id(client, cid, actor)})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _observe(client, cid, actor, sid, texts, anchors=None, **kw):
    r = await client.post(f"/api/containers/{cid}/qa/map/observe", json={
        "actor_agent_id": actor, "platform": "ios", "session_id": sid, "texts": texts,
        "anchors": anchors if anchors is not None else texts, **kw})
    assert r.status_code == 200, r.text
    return r.json()


async def test_observe_meets_code_screens_by_their_words(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _import(client, cid, bot, "code", nodes=[CART, SETTINGS])
    sid = await _session(client, cid, bot)

    # status bar, tab bar and user data around the code's words
    shot = ["9:41", "Battery 100%", "Your cart", "Blue sneakers", "$89.00", "Subtotal", "Check out",
            "Tab Bar", "Home", "Cart", "Settings"]
    out = await _observe(client, cid, bot, sid, shot)
    assert out["screen_key"] == "cart" and out["matched_by"] == "code" and out["state"] == "seen"
    assert out["new"] is True
    again = await _observe(client, cid, bot, sid, shot)
    assert again["screen_key"] == "cart" and again["new"] is False

    # reached from the cart by an action: a navigates edge labelled with it
    out = await _observe(client, cid, bot, sid, ["Settings", "Notifications", "Privacy", "Sign out"],
                         from_key="cart", action='Tap "Settings"')
    assert out["screen_key"] == "settings"
    m, nodes = await _map(client, cid)
    assert nodes["cart"]["state"] == "seen" and nodes["cart"]["sources"] == ["code", "live"]
    assert nodes["cart"]["evidence"]["live"]["sightings"] == 2
    assert nodes["settings"]["label"] == "SettingsView"
    edge = next(e for e in m["edges"] if e["kind"] == "navigates")
    assert (edge["from_key"], edge["to_key"], edge["label"], edge["count"]) == \
        ("cart", "settings", 'Tap "Settings"', 1)
    await _observe(client, cid, bot, sid, ["Settings", "Notifications", "Privacy", "Sign out"],
                   from_key="cart", action='Tap "Settings"')
    m, _ = await _map(client, cid)
    assert next(e for e in m["edges"] if e["kind"] == "navigates")["count"] == 2


async def test_observe_keys_an_unknown_screen_and_meets_it_again(client, container, people):
    cid, bot = container["id"], people["bot"]
    sid = await _session(client, cid, bot)
    texts = ["Order history", "Filter", "Order 1234", "Order 5678"]
    anchors = ["Order history", "Filter", "orders-list"]
    first = await _observe(client, cid, bot, sid, texts, anchors=anchors)
    assert first["screen_key"].startswith("seen-") and first["matched_by"] == "new" and first["new"] is True
    assert first["label"] == "Order history"
    # the same screen with other rows: the same title meets the same node
    second = await _observe(client, cid, bot, sid, ["Order history", "Filter", "Order 9999"], anchors=anchors)
    assert second["screen_key"] == first["screen_key"] and second["new"] is False
    # the device's own home screen is no screen of the app
    none = await _observe(client, cid, bot, sid, ["App Library", "Dock"], anchors=[])
    assert none["screen_key"] is None

    # a session on another platform cannot observe into this one
    droid = await _session(client, cid, bot, platform="android")
    r = await client.post(f"/api/containers/{cid}/qa/map/observe", json={
        "actor_agent_id": bot, "platform": "ios", "session_id": droid, "texts": texts, "anchors": anchors})
    assert r.status_code == 400


async def test_web_observe_matches_by_route_first(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _import(client, cid, bot, "code", platform="web", nodes=[
        {"kind": "screen", "key": "/listings/*", "label": "Listing detail"},
        {"kind": "screen", "key": "/listings", "label": "Listings"},
        {"kind": "screen", "key": "search", "label": "Search",
         "detail": {"title": "Search", "texts": ["Search", "Filters", "Price range", "Bedrooms"]}}])
    sid = await _session(client, cid, bot, platform="web")

    async def obs(route, texts, **kw):
        r = await client.post(f"/api/containers/{cid}/qa/map/observe", json={
            "actor_agent_id": bot, "platform": "web", "session_id": sid, "route": route, "texts": texts,
            "anchors": texts, **kw})
        assert r.status_code == 200, r.text
        return r.json()

    # ids collapse (a number, a uuid, a long token) and a known pattern wins over the words
    out = await obs("https://shop.test/listings/812?tab=photos", ["Search", "Filters", "Price range"])
    assert (out["screen_key"], out["matched_by"], out["label"]) == ("/listings/*", "route", "Listing detail")
    out = await obs("/en/listings/3f2b8c1e-5a4d-4e0b-9c7a-1d2e3f4a5b6c", ["A flat"], from_key="/listings/*")
    assert out["screen_key"] == "/listings/*" and out["new"] is False
    out = await obs("/listings", ["All listings"], from_key="/listings/*", action="Press back")
    assert out["screen_key"] == "/listings"
    # an unknown route falls back to the text score...
    out = await obs("/find", ["Search", "Filters", "Price range", "Bedrooms"])
    assert (out["screen_key"], out["matched_by"]) == ("search", "code")
    # ...and else is keyed by its own collapsed route
    out = await obs("/orders/a1b2c3d4e5f6a7b8c9d0/receipt", ["Receipt", "Total"], title="Your receipt")
    assert (out["screen_key"], out["matched_by"], out["label"]) == ("/orders/*/receipt", "new", "Your receipt")
    out = await obs("/nope", ["404", "Page not found"])
    assert out["screen_key"] == "not-found"
    # a new route never merges into another route's page because their words look alike
    # (live e2e: /orders/index.html landed on /index.html and renamed it "Orders")
    home = await obs("/index.html", ["Duka", "Email", "Subscribe", "Orders"], title="Duka")
    orders = await obs("/orders/index.html", ["Orders", "Order 8812", "Home"], title="Orders",
                       from_key=home["screen_key"], action='Tap Link "Orders"')
    assert (home["screen_key"], orders["screen_key"], orders["new"]) == ("/index.html", "/orders/index.html", True)
    m, nodes = await _map(client, cid, platform="web")
    assert nodes["/index.html"]["label"] == "Duka" and nodes["/orders/index.html"]["label"] == "Orders"
    m, nodes = await _map(client, cid, platform="web")
    assert nodes["/listings/*"]["state"] == "seen" and nodes["/listings/*"]["evidence"]["live"]["sightings"] == 2
    assert sorted((e["from_key"], e["to_key"], e["label"]) for e in m["edges"]) == [
        ("/index.html", "/orders/index.html", 'Tap Link "Orders"'), ("/listings/*", "/listings", "Press back")]
    # native platforms ignore the route and keep the text path
    ios = await _session(client, cid, bot)
    out = await _observe(client, cid, bot, ios, ["Order history", "Filter"], route="/listings/1")
    assert out["screen_key"].startswith("seen-")


async def test_blocked_screens(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _import(client, cid, bot, "code", nodes=[CART])
    r = await client.post(f"/api/containers/{cid}/qa/map/blocked", json={
        "actor_agent_id": bot, "platform": "ios", "screen": "Cart", "kind": "needs_sign_in",
        "reason": "Checkout needs an account"})
    assert r.status_code == 200, r.text
    assert r.json() == {"screen_key": "cart", "label": "Cart", "state": "blocked", "new": False}
    r = await client.post(f"/api/containers/{cid}/qa/map/blocked", json={
        "actor_agent_id": bot, "platform": "ios", "screen": "Admin panel", "kind": "needs_permission",
        "reason": "admins only"})
    assert r.json()["screen_key"] == "admin-panel" and r.json()["new"] is True
    _, nodes = await _map(client, cid)
    assert nodes["cart"]["blocked_kind"] == "needs_sign_in" and nodes["admin-panel"]["state"] == "blocked"
    # seeing it later beats the block
    sid = await _session(client, cid, bot)
    await _observe(client, cid, bot, sid, ["Your cart", "Subtotal", "Check out"])
    _, nodes = await _map(client, cid)
    assert nodes["cart"]["state"] == "seen" and nodes["cart"]["blocked_kind"] is None
    r = await client.post(f"/api/containers/{cid}/qa/map/blocked", json={
        "actor_agent_id": bot, "platform": "ios", "screen": "cart", "kind": "teleport", "reason": "x"})
    assert r.status_code == 422


async def test_features_upsert(client, container, people):
    cid, bot = container["id"], people["bot"]
    feats = [{"name": "Checkout", "summary": "Buy", "entry": "cart", "paths": ["cart", "pay"]},
             {"key": "profile", "name": "Profile"}]
    r = await client.put(f"/api/containers/{cid}/qa/features",
                         json={"actor_agent_id": bot, "features": feats, "source": "exploration"})
    assert r.status_code == 200, r.text
    assert [f["key"] for f in r.json()["features"]] == ["checkout", "profile"]
    r = await client.put(f"/api/containers/{cid}/qa/features",
                         json={"actor_agent_id": bot, "features": [{"name": "Checkout", "summary": "Pay"}]})
    m, _ = await _map(client, cid)
    assert {f["key"]: f["summary"] for f in m["features"]} == {"checkout": "Pay", "profile": None}
    r = await client.put(f"/api/containers/{cid}/qa/features",
                         json={"actor_agent_id": bot, "features": [{"name": f"F{i}"} for i in range(31)]})
    assert r.status_code == 422


# ---------------------------------------------------------------- scenarios

def _scenario(**kw):
    return {"platform": "ios", "name": "Guest checkout", "category": "checkout", "persona": "guest",
            "criteria": ["The cart lists the item", "Paying shows the order number"], "tags": ["smoke"], **kw}


async def _propose(client, cid, actor, **kw):
    r = await client.post(f"/api/containers/{cid}/qa/scenarios", json={"actor_agent_id": actor, **_scenario(**kw)})
    assert r.status_code == 200, r.text
    return r.json()


async def _status(client, cid, actor, ids, status, reason=None):
    return await client.post(f"/api/containers/{cid}/qa/scenarios/status",
                             json={"actor_agent_id": actor, "ids": ids, "status": status, "reason": reason})


async def test_propose_and_the_human_gate(client, container, people):
    cid, bot, human = container["id"], people["bot"], people["human"]
    out = await _propose(client, cid, bot)
    assert out["outcome"] == "created" and out["scenario"]["status"] == "draft"
    scid = out["scenario"]["id"]
    assert out["scenario"]["created_by_agent_id"] == bot and out["scenario"]["source"] == "authored"

    out = await _propose(client, cid, bot, description="Buy as a guest")
    assert out["outcome"] == "updated" and out["scenario"]["description"] == "Buy as a guest"

    r = await _status(client, cid, bot, [scid], "validated")
    assert r.status_code == 403 and "only a person" in r.json()["detail"]
    r = await client.patch(f"/api/qa/scenarios/{scid}", json={"actor_agent_id": bot, "status": "validated"})
    assert r.status_code == 403
    r = await _status(client, cid, human, [scid], "validated", "walked it myself")
    assert r.status_code == 200 and r.json()["scenarios"][0]["status"] == "validated"
    assert r.json()["scenarios"][0]["validated_by_agent_id"] == human

    # a proposal against a validated scenario never changes it: it becomes a suggestion
    changed = ["The cart lists the item and its price", "Paying shows the order number"]
    out = await _propose(client, cid, bot, criteria=changed, reason="price was missing")
    assert out["outcome"] == "suggested" and out["scenario"]["criteria"] == _scenario()["criteria"]
    gid = out["suggestion"]["id"]
    again = await _propose(client, cid, bot, criteria=changed, reason="price was missing")
    assert again["suggestion"]["id"] == gid  # the same open proposal is not filed twice
    # an agent's revise of a validated scenario is a suggestion too
    r = await client.patch(f"/api/qa/scenarios/{scid}", json={"actor_agent_id": bot, "persona": "member"})
    assert r.json()["outcome"] == "suggested" and r.json()["scenario"]["persona"] == "guest"

    sugg = (await client.get(f"/api/containers/{cid}/qa/suggestions")).json()["suggestions"]
    assert len(sugg) == 2 and sugg[0]["scenario_name"] == "Guest checkout"

    r = await client.post(f"/api/qa/suggestions/{gid}", json={"actor_agent_id": bot, "decision": "accept"})
    assert r.status_code == 403
    r = await client.post(f"/api/qa/suggestions/{gid}", json={"actor_agent_id": human, "decision": "accept"})
    assert r.status_code == 200, r.text
    assert r.json()["suggestion"]["status"] == "accepted"
    assert r.json()["scenario"]["criteria"] == changed and r.json()["scenario"]["status"] == "validated"
    r = await client.post(f"/api/qa/suggestions/{gid}", json={"actor_agent_id": human, "decision": "dismiss"})
    assert r.status_code == 409
    other = next(s["id"] for s in sugg if s["id"] != gid)
    r = await client.post(f"/api/qa/suggestions/{other}", json={"actor_agent_id": human, "decision": "dismiss"})
    assert r.json()["suggestion"]["status"] == "dismissed" and r.json()["scenario"]["persona"] == "guest"
    assert (await client.get(f"/api/containers/{cid}/qa/suggestions")).json()["suggestions"] == []

    # a person may change any field, the status included
    r = await client.patch(f"/api/qa/scenarios/{scid}", json={"actor_agent_id": human, "status": "paused",
                                                             "reason": "flaky build"})
    assert r.json()["outcome"] == "updated" and r.json()["scenario"]["status"] == "paused"
    r = await _status(client, cid, human, [scid], "draft")
    assert r.json()["scenarios"][0]["validated_by_agent_id"] is None
    r = await client.patch(f"/api/qa/scenarios/{scid}", json={"actor_agent_id": bot, "persona": "member"})
    assert r.json()["outcome"] == "updated" and r.json()["scenario"]["persona"] == "member"  # a draft again


async def test_scenario_validation_and_evidence(client, container, people, monkeypatch, tmp_path):
    import main

    monkeypatch.setattr(main, "ATTACHMENTS_DIR", tmp_path)
    cid, bot = container["id"], people["bot"]
    r = await client.post(f"/api/containers/{cid}/qa/scenarios",
                          json={"actor_agent_id": bot, **_scenario(criteria=["only one"])})
    assert r.status_code == 422
    r = await client.post(f"/api/containers/{cid}/qa/scenarios",
                          json={"actor_agent_id": bot, **_scenario(criteria=["one", "   "])})
    assert r.status_code == 400
    r = await client.post(f"/api/containers/{cid}/qa/scenarios", json={
        "actor_agent_id": bot, **_scenario(evidence=[{"criterion_index": 5, "status": "verified"}])})
    assert r.status_code == 400

    sid = (await client.post(f"/api/containers/{cid}/qa/sessions",
                             json={"actor_agent_id": bot, "kind": "draft", "platform": "ios", "task_id": await run_task_id(client, cid, bot)})).json()["id"]
    frame = (await client.post(f"/api/qa/sessions/{sid}/frames", params={"actor_agent_id": bot},
                               content=b"\xff\xd8\xff\xd9", headers={"content-type": "image/jpeg"})).json()
    ev = [{"criterion_index": 0, "status": "verified", "frame_id": frame["frame_id"]},
          {"criterion_index": 1, "status": "code_only", "code_ref": "CheckoutView.swift:88"}]
    out = await _propose(client, cid, bot, evidence=ev, session_id=sid)
    d = (await client.get(f"/api/qa/scenarios/{out['scenario']['id']}")).json()
    assert [e["status"] for e in d["evidence"]] == ["verified", "code_only"]
    assert d["frames"] == [{"id": frame["frame_id"], "width": None, "height": None,
                            "created_at": d["frames"][0]["created_at"],
                            "url": f"/api/qa/frames/{frame['frame_id']}"}]
    assert d["session_id"] == sid
    session = (await client.get(f"/api/qa/sessions/{sid}")).json()
    assert [x["id"] for x in session["drafts"]] == [out["scenario"]["id"]]


async def test_a_walk_becomes_a_scenario(client, container, people):
    cid, bot = container["id"], people["bot"]
    await client.post(f"/api/containers/{cid}/qa/flows", json={
        "actor_agent_id": bot, "platform": "ios", "flows": [{"name": "Pay", "steps": [{"text": "Pay"}]}]})
    sid = (await client.post(f"/api/containers/{cid}/qa/sessions",
                             json={"actor_agent_id": bot, "kind": "explore", "platform": "ios", "task_id": await run_task_id(client, cid, bot)})).json()["id"]
    walk = (await client.post(f"/api/qa/sessions/{sid}/walks/next", json={"actor_agent_id": bot})).json()["walk"]
    out = await _propose(client, cid, bot, walk_id=walk["id"])
    assert out["scenario"]["source"] == "walk" and out["scenario"]["session_id"] == sid
    d = (await client.get(f"/api/qa/scenarios/{out['scenario']['id']}")).json()
    assert d["walk"]["id"] == walk["id"] and d["walk"]["flow"]["key"] == "pay"
    assert d["walk"]["scenario_id"] == out["scenario"]["id"]


CHECKS = [{"criterion_index": None, "line": "Screen \"Cart\""},
          {"criterion_index": 1, "line": "Text \"Order #\""}]


async def test_checks_shape_is_validated_and_returned(client, container, people):
    cid, bot = container["id"], people["bot"]
    out = await _propose(client, cid, bot, checks=CHECKS)
    assert out["scenario"]["checks"] == CHECKS
    r = await client.post(f"/api/containers/{cid}/qa/scenarios",
                          json={"actor_agent_id": bot, **_scenario(name="B", checks=["Screen Cart"])})
    assert r.status_code == 422
    r = await client.post(f"/api/containers/{cid}/qa/scenarios", json={
        "actor_agent_id": bot, **_scenario(name="C", checks=[{"criterion_index": 2, "line": "x"}])})
    assert r.status_code == 400 and "criterion 2" in r.json()["detail"]


async def _two_scenarios(client, cid, bot, human):
    a = (await _propose(client, cid, bot, description="Buy as a guest.", checks=CHECKS))["scenario"]["id"]
    await _propose(client, cid, bot, name="Draft only")
    await _status(client, cid, human, [a], "validated")


async def test_export_renders_scenario_markdown_v3(client, container, people):
    cid, bot, human = container["id"], people["bot"], people["human"]
    await _two_scenarios(client, cid, bot, human)
    r = await client.get(f"/api/containers/{cid}/qa/scenarios/export.md", params={"platform": "ios"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/markdown")
    text = r.text
    assert text.startswith("## Guest checkout\n") and "Persona: guest" in text and "Tags: smoke" in text
    assert "Description: Buy as a guest." in text
    assert 'Check: Screen "Cart"\n1. The cart lists the item\n2. Paying shows the order number\n' \
           '   Check: Text "Order #"' in text
    assert "Draft only" not in text
    from orcha_cli.qa import scenario_format
    [parsed] = scenario_format.parse_scenarios(text)
    assert parsed.name == "Guest checkout" and parsed.checks == {1: ['Text "Order #"']}
    lst = (await client.get(f"/api/containers/{cid}/qa/scenarios", params={"status": "validated"})).json()
    assert [s["name"] for s in lst["scenarios"]] == ["Guest checkout"]


async def test_detail_lints_in_plain_words_and_the_list_carries_the_latest_verdicts(client, container, people, monkeypatch):
    from portal_backend import qa_scenarios

    cid, bot = container["id"], people["bot"]
    r = await client.post(f"/api/containers/{cid}/qa/scenarios", json={
        "actor_agent_id": bot, "platform": "ios", "name": "Tap around", "criteria": ["Tap the Save button", "The list shows it"]})
    sid = r.json()["scenario"]["id"]
    lint = (await client.get(f"/api/qa/scenarios/{sid}")).json()["lint"]
    assert {"severity": "warning", "message": "No description: say the user's goal in one sentence.", "criterion": None} in lint
    assert any(n["criterion"] == 0 and "click script" in n["message"] for n in lint)
    assert all(set(n) == {"severity", "message", "criterion"} for n in lint)
    monkeypatch.setattr(qa_scenarios, "_v3_format", lambda: None)
    assert (await client.get(f"/api/qa/scenarios/{sid}")).json()["lint"] == []

    r = await client.post(f"/api/containers/{cid}/qa/sessions", json={"actor_agent_id": bot, "platform": "ios", "kind": "check", "task_id": await run_task_id(client, cid, bot)})
    ssid = r.json()["id"]
    for verdict in ("fail", "pass"):
        r = await client.post(f"/api/qa/sessions/{ssid}/verdicts", json={
            "actor_agent_id": bot, "scenario_id": sid, "criterion_index": 0, "verdict": verdict})
        assert r.status_code == 201
    [row] = (await client.get(f"/api/containers/{cid}/qa/scenarios", params={"platform": "ios"})).json()["scenarios"]
    assert [(v["criterion_index"], v["verdict"]) for v in row["verdicts"]] == [(0, "pass")]


async def test_export_falls_back_to_the_minimal_renderer(client, container, people, monkeypatch):
    from portal_backend import qa_scenarios

    monkeypatch.setattr(qa_scenarios, "_v3_format", lambda: None)
    cid, bot, human = container["id"], people["bot"], people["human"]
    await _two_scenarios(client, cid, bot, human)
    text = (await client.get(f"/api/containers/{cid}/qa/scenarios/export.md", params={"platform": "ios"})).text
    assert text.startswith("# Guest checkout\n")
    assert "- Platform: ios" in text and "- Persona: guest" in text and "- Tags: smoke" in text
    assert "Buy as a guest." in text
    assert 'Check: Screen "Cart"\n1. The cart lists the item\n2. Paying shows the order number\n' \
           '   Check: Text "Order #"' in text
    r = await client.get(f"/api/containers/{cid}/qa/scenarios/export.md", params={"status": "draft"})
    assert r.text.startswith("# Draft only")


# ---------------------------------------------------------------- what covers the map

async def test_read_map_says_what_covers_it_and_each_sources_last_read(client, container, people):
    cid, bot, human = container["id"], people["bot"], people["human"]
    await _import(client, cid, bot, "code", nodes=[
        CART, SETTINGS, {"kind": "screen", "key": "pay", "label": "Pay", "feature_key": "checkout"},
        {"kind": "flow", "key": "buy", "label": "Buy", "evidence": ["BuyTests.swift:3"]},
    ], edges=[
        {"kind": "navigates", "from_key": "cart", "to_key": "pay", "label": "Check out"},
        {"kind": "navigates", "from_key": "settings", "to_key": "cart", "label": "Cart tab"},
        {"kind": "steps", "from_kind": "flow", "from_key": "buy", "to_key": "cart", "detail": {"order": 0}},
        {"kind": "steps", "from_kind": "flow", "from_key": "buy", "to_key": "pay", "detail": {"order": 1}},
    ], features=[{"key": "checkout", "name": "Checkout"}, {"key": "account", "name": "Account"}])

    m, nodes = await _map(client, cid)
    assert m["sources"]["code"]["screens"] == 3 and m["sources"]["code"]["at"]
    assert m["sources"]["tests"] is None and m["sources"]["live"] is None
    assert nodes["cart"]["covered_by"] == [] and all(e["covered"] is False for e in m["edges"])
    assert {f["key"]: f["coverage"] for f in m["features"]}["checkout"] == "untested"

    r = await client.post(f"/api/containers/{cid}/qa/sessions", json={
        "actor_agent_id": bot, "kind": "check", "platform": "ios", "task_id": await run_task_id(client, cid, bot)})
    assert r.status_code == 201, r.text
    sid = r.json()["id"]
    r = await client.post(f"/api/qa/sessions/{sid}/steps", json={"actor_agent_id": bot, "steps": [
        {"seq": 1, "kind": "screen", "screen_key": "cart"}, {"seq": 2, "kind": "tap"},
        {"seq": 3, "kind": "screen", "screen_key": "pay"}]})
    assert r.status_code == 200, r.text
    scenario = (await _propose(client, cid, bot, name="Buy something"))["scenario"]["id"]
    r = await client.post(f"/api/qa/sessions/{sid}/verdicts", json={
        "actor_agent_id": bot, "scenario_id": scenario, "criterion_index": 0, "verdict": "pass"})
    assert r.status_code == 201, r.text

    # a draft covers nothing
    _, nodes = await _map(client, cid)
    assert nodes["cart"]["covered_by"] == []

    r = await _status(client, cid, human, [scenario], "validated")
    assert r.status_code == 200, r.text
    m, nodes = await _map(client, cid)
    assert nodes["cart"]["covered_by"] == [
        {"scenario_id": scenario, "title": "Buy something", "result": "pass", "via": "run"}]
    assert [link["scenario_id"] for link in nodes["buy"]["covered_by"]] == [scenario]  # walked its steps in order
    assert nodes["settings"]["covered_by"] == []
    walked = {(e["from_key"], e["to_key"]): e["covered"] for e in m["edges"] if e["kind"] == "navigates"}
    assert walked == {("cart", "pay"): True, ("settings", "cart"): False}
    by_key = {f["key"]: f for f in m["features"]}
    assert by_key["checkout"]["covered_screens"] == 2 and by_key["checkout"]["coverage"] in ("thin", "covered")
    assert by_key["account"]["coverage"] == "untested"


async def test_a_feature_knows_when_a_run_last_stood_on_it(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _import(client, cid, bot, "code", nodes=[CART, {**SETTINGS, "feature_key": "account"}],
                  features=[{"key": "checkout", "name": "Checkout"}, {"key": "account", "name": "Account"}])
    sid = await _session(client, cid, bot)
    await _observe(client, cid, bot, sid, ["Your cart", "Blue sneakers", "Subtotal", "Check out"])
    got = (await client.get(f"/api/containers/{cid}/qa/map", params={"platform": "ios"})).json()
    by = {f["key"]: f["last_explored_at"] for f in got["features"]}
    assert by["checkout"] and by["account"] is None
