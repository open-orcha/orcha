"""Orcha QA portal: the Screen atlas (qa_atlas.py), a reading of the map, steps and frames."""
import datetime as dt

import pytest

import main
from portal_backend import qa_atlas
from conftest import run_task_id


def jpeg(width=390, height=844):
    """A minimal JPEG header: enough for the size reader, not an image."""
    sof = (b"\xff\xc0\x00\x11\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big")
           + b"\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01")
    return b"\xff\xd8" + sof + b"\xff\xd9"


@pytest.fixture
def attachments(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "ATTACHMENTS_DIR", tmp_path)
    return tmp_path


@pytest.fixture
async def people(make_agent):
    human = await make_agent("Hussein", "owner", kind="human")
    bot = await make_agent("qa-bot")
    return {"human": human["agent_id"], "bot": bot["agent_id"]}


async def _import(client, cid, actor, platform, source="code", nodes=(), edges=(), features=()):
    r = await client.post(f"/api/containers/{cid}/qa/map/import", json={
        "actor_agent_id": actor, "platform": platform, "source": source, "nodes": list(nodes),
        "edges": list(edges), "features": list(features)})
    assert r.status_code == 200, r.text


async def _session(client, cid, actor, platform="ios", device="iPhone 17 Pro", kind="map"):
    r = await client.post(f"/api/containers/{cid}/qa/sessions", json={
        "actor_agent_id": actor, "kind": kind, "platform": platform, "device_name": device,
        "task_id": await run_task_id(client, cid, actor)})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _frame(client, sid, actor, data=None, screen_hash=None, facts=None):
    params = {"actor_agent_id": actor, **({"screen_hash": screen_hash} if screen_hash else {}), **(facts or {})}
    r = await client.post(f"/api/qa/sessions/{sid}/frames", params=params, content=data or jpeg(),
                          headers={"content-type": "image/jpeg"})
    assert r.status_code == 201, r.text
    return r.json()["frame_id"]


async def _see(client, sid, actor, key, *, seq, screen_hash, frame=None, texts=("Your cart", "Check out"), at=None):
    step = {"seq": seq, "kind": "screen", "args": {"title": texts[0], "texts": list(texts), "anchors": list(texts)},
            "screen_key": key, "screen_hash": screen_hash, "frame_id": frame}
    if at:
        step["at"] = at
    r = await client.post(f"/api/qa/sessions/{sid}/steps", json={"actor_agent_id": actor, "steps": [step]})
    assert r.status_code in (200, 201), r.text


async def _atlas(client, cid, **params):
    r = await client.get(f"/api/containers/{cid}/qa/atlas", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _screen(atlas, name):
    return next(s for s in atlas["screens"] if s["name"] == name)


def node(key, label, feature=None, **detail):
    return {"kind": "screen", "key": key, "label": label, "feature_key": feature, "detail": detail}


async def test_empty_container_answers_an_empty_atlas(client, container):
    a = await _atlas(client, container["id"])
    assert a["project_id"] == container["id"] and a["name"] == "test-arena"
    assert a["screens"] == [] and a["platforms"] == [] and a["refresh"]["state"] == "idle"
    assert a["since"] == {"value": None, "kind": "date", "label": "the last 7 days", "at": a["since"]["at"], "default": True}


async def test_an_unknown_container_is_404_and_a_bad_one_400(client):
    assert (await client.get("/api/containers/not-a-uuid/qa/atlas")).status_code == 400
    assert (await client.get("/api/containers/00000000-0000-4000-8000-000000000000/qa/atlas")).status_code == 404


async def test_platforms_match_by_key_then_route_then_label(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _import(client, cid, bot, "ios", nodes=[
        node("cart", "Cart", "checkout"), node("listing-detail", "Listing", "shop", route="/listings/:id"),
        node("settings-view", "SettingsView", "account"), node("orders", "Orders", "shop")],
        features=[{"key": "checkout", "name": "Checkout"}, {"key": "shop", "name": "Shop", "summary": "3 screens: a, b, c"}])
    await _import(client, cid, bot, "android", nodes=[
        node("cart", "Basket", "other-feature"), node("listing-screen", "Item", "shop", route="/listings/{id}"),
        node("settings", "Settings screen", "account"), node("orders-screen", "Orders", "another")])
    a = await _atlas(client, cid)
    assert a["platforms"] == ["ios", "android"]
    by = {s["name"]: s for s in a["screens"]}
    assert len(a["screens"]) == 5  # Orders stays two: their features disagree
    assert by["Cart"]["matched_by"] == "key" and set(by["Cart"]["platforms"]) == {"ios", "android"}
    listing = next(s for s in a["screens"] if s["route"] == "/listings/:id")
    assert listing["matched_by"] == "route" and len(listing["nodes"]) == 2
    settings = next(s for s in a["screens"] if len(s["nodes"]) == 2 and s["matched_by"] == "label")
    assert "ettings" in settings["name"]
    assert a["matching"] == {"key": 1, "route": 1, "label": 1}
    assert [x["name"] for x in a["areas"] if x["key"] == "shop"] == ["Shop"]
    assert next(x for x in a["areas"] if x["key"] == "shop")["summary"] is None  # only a count


async def test_presence_and_badges(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _import(client, cid, bot, "ios", nodes=[node("cart", "Cart"), node("only-ios", "Only iOS")])
    await _import(client, cid, bot, "android", nodes=[node("cart", "Cart")])
    sid = await _session(client, cid, bot, "web", "desktop", kind="explore")
    fid = await _frame(client, sid, bot, jpeg(1280, 800), "w1")
    r = await client.post(f"/api/containers/{cid}/qa/map/observe", json={
        "actor_agent_id": bot, "platform": "web", "session_id": sid, "title": "Live page", "texts": ["Live page"],
        "anchors": ["Live page"], "frame_id": fid, "route": "/live"})
    assert r.status_code == 200, r.text
    await _see(client, sid, bot, r.json()["screen_key"], seq=1, screen_hash="w1", frame=fid, texts=("Live page",))
    a = await _atlas(client, cid)
    cart, only, live = _screen(a, "Cart"), _screen(a, "Only iOS"), _screen(a, "Live page")
    assert cart["presence"] == {"ios": "unseen", "android": "unseen", "web": "unknown"}
    assert cart["similarity"]["badge"] == "unchecked"
    assert only["presence"]["android"] == "absent" and only["similarity"]["badge"] == "missing"
    assert only["similarity"]["reasons"][0] == "Not in the Android code"
    assert live["presence"] == {"ios": "unknown", "android": "unknown", "web": "seen"}
    assert live["similarity"]["badge"] == "unmatched" and live["code_only"] is False
    assert a["counts"]["missing"] == 1 and a["counts"]["unmatched"] == 1 and a["counts"]["unchecked"] == 1
    assert live["variants"]["web"]["device"]["name"] == "Chromium 1280×800"
    assert live["variants"]["web"]["device"]["kind"] == "browser"
    assert a["devices"]["web"] == {"kind": "browser", "landscape": False}


async def test_two_platforms_read_the_same_by_their_words_and_look(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _import(client, cid, bot, "ios", nodes=[node("cart", "Cart"), node("home", "Home")])
    await _import(client, cid, bot, "android", nodes=[node("cart", "Cart"), node("home", "Home")])
    ios = await _session(client, cid, bot, "ios", "iPhone 17 Pro")
    droid = await _session(client, cid, bot, "android", "Pixel 9a")
    await _see(client, ios, bot, "cart", seq=1, screen_hash="same", frame=await _frame(client, ios, bot, screen_hash="same"))
    await _see(client, droid, bot, "cart", seq=1, screen_hash="same", frame=await _frame(client, droid, bot, screen_hash="same"))
    await _see(client, ios, bot, "home", seq=2, screen_hash="a", frame=await _frame(client, ios, bot, screen_hash="a"), texts=("Welcome back", "Open orders", "Settings"))
    await _see(client, droid, bot, "home", seq=2, screen_hash="b", frame=await _frame(client, droid, bot, screen_hash="b"), texts=("Fresh deals", "Weekly picks", "Rewards"))
    a = await _atlas(client, cid)
    cart, home = _screen(a, "Cart"), _screen(a, "Home")
    assert cart["similarity"]["badge"] == "same" and cart["similarity"]["score"] == 1.0
    assert cart["similarity"]["reasons"] == ["Looks and reads the same on iOS and Android"]
    assert home["similarity"]["badge"] == "different" and home["similarity"]["score"] < 0.62
    pair = home["similarity"]["pairs"][0]
    assert pair["fair"] is True and pair["words"] == "iPhone 17 Pro vs Pixel 9a"
    assert pair["looks"]["a"]["frame_url"].startswith("/api/qa/frames/")
    assert "Only iOS shows" in home["similarity"]["reasons"][0]
    assert a["counts"]["different"] == 1 and a["counts"]["same"] == 1
    assert a["coverage"] == [{"form": "phone", "platforms": {"ios": [], "android": []}}]


async def test_devices_of_different_kinds_are_not_compared(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _import(client, cid, bot, "ios", nodes=[node("cart", "Cart")])
    await _import(client, cid, bot, "android", nodes=[node("cart", "Cart")])
    ios = await _session(client, cid, bot, "ios", "iPad Pro 13-inch (M5)")
    droid = await _session(client, cid, bot, "android", "emulator-5554")
    await _see(client, ios, bot, "cart", seq=1, screen_hash="a", frame=await _frame(client, ios, bot, jpeg(2064, 2752), "a"))
    await _see(client, droid, bot, "cart", seq=1, screen_hash="b", frame=await _frame(client, droid, bot, screen_hash="b"))
    a = await _atlas(client, cid)
    cart = _screen(a, "Cart")
    pair = cart["similarity"]["pairs"][0]
    assert pair["fair"] is False and pair["match"] == "device"
    assert pair["reasons"] == ["iOS was only seen on an iPad, Android only on a phone, so Orcha does not compare them yet"]
    assert cart["variants"]["ios"]["device"]["kind"] == "tablet"
    assert cart["variants"]["android"]["device"]["name"] is None  # a serial is no name
    assert a["devices"]["ios"] == {"kind": "tablet", "landscape": False}


async def test_looks_states_flows_and_what_changed(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _import(client, cid, bot, "ios", nodes=[node("home", "Home", "shop"), node("cart", "Cart", "shop")],
                  edges=[{"kind": "navigates", "from_key": "home", "to_key": "cart", "label": 'Tap "Cart"'}])
    sid = await _session(client, cid, bot)
    old = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=20)).isoformat()
    await _see(client, sid, bot, "cart", seq=1, screen_hash="one", frame=await _frame(client, sid, bot, screen_hash="one"), at=old,
               texts=("Your cart", "Add to bag"))
    await _see(client, sid, bot, "cart", seq=2, screen_hash="one", frame=await _frame(client, sid, bot, screen_hash="one"), at=old,
               texts=("Your cart", "Add to bag"))
    newest = await _frame(client, sid, bot, screen_hash="two")
    await _see(client, sid, bot, "cart", seq=3, screen_hash="two", frame=newest, texts=("Your cart", "Add to basket"))
    await _see(client, sid, bot, "cart", seq=4, screen_hash="three", frame=await _frame(client, sid, bot, screen_hash="three"),
               texts=("Your cart is empty",))
    await _see(client, sid, bot, "home", seq=5, screen_hash="h", texts=("Sign in", "Password"))
    a = await _atlas(client, cid)
    cart, home = _screen(a, "Cart"), _screen(a, "Home")
    assert a["counts"]["looks"] == 4  # one, two, three, and the sign-in
    assert [s["state"] for s in cart["states"]] == ["loaded", "empty"]
    assert cart["states"][1]["label"] == "Empty" and cart["states"][0]["platforms"] == ["ios"]
    assert cart["variants"]["ios"]["frame_url"] == f"/api/qa/frames/{newest}"
    assert cart["variants"]["ios"]["looks"] == 3 and cart["last_build"] is None
    ch = cart["change"]["platforms"][0]
    assert cart["change"]["kind"] == "changed" and ch["kind"] == "changed"
    assert ch["what"] == ["Now says “Add to basket” instead of “Add to bag”"]
    assert ch["before"]["frame_url"] and ch["after"]["frame_url"] == f"/api/qa/frames/{newest}"
    assert home["change"]["kind"] == "new" and home["states"][0]["label"] == "Sign-in shown"
    assert a["flows"] == [{"from": home["id"], "to": cart["id"], "label": 'Tap "Cart"', "count": 0, "seen": False}]
    assert cart["from"] == [{"id": home["id"], "label": 'Tap "Cart"'}] and home["to"][0]["id"] == cart["id"]
    assert a["areas"][0]["screens"] == [home["id"], cart["id"]]  # in walking order
    assert a["since"]["default"] is True

    # A later date: nothing since then.
    later = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)).date().isoformat()
    a = await _atlas(client, cid, since=later)
    assert a["since"]["kind"] == "date" and a["since"]["default"] is False and a["since"]["value"] == later
    assert a["counts"]["changed"] == 0
    # Text that is no date reads as the default.
    a = await _atlas(client, cid, since="next week")
    assert a["since"]["default"] is True


async def test_a_platform_behind_its_sign_in_is_not_compared(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _import(client, cid, bot, "ios", nodes=[node("cart", "Cart")])
    await _import(client, cid, bot, "android", nodes=[node("cart", "Cart")])
    ios = await _session(client, cid, bot, "ios", "iPhone 17 Pro")
    droid = await _session(client, cid, bot, "android", "Pixel 9a")
    await _see(client, ios, bot, "cart", seq=1, screen_hash="a", frame=await _frame(client, ios, bot, screen_hash="a"))
    await _see(client, droid, bot, "cart", seq=1, screen_hash="b", frame=await _frame(client, droid, bot, screen_hash="b"),
               texts=("Log in", "Password"))
    cart = _screen(await _atlas(client, cid), "Cart")
    assert cart["variants"]["android"]["signin_only"] is True
    assert cart["presence"]["android"] == "seen"
    assert "Seen on Android only behind its sign-in, so Orcha cannot compare it there" in cart["similarity"]["reasons"]
    assert all(lk["platform"] != "android" for lk in cart["seen_on"])


async def test_refresh_follows_the_newest_map_session(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _import(client, cid, bot, "ios", nodes=[node("cart", "Cart")])
    sid = await _session(client, cid, bot)
    await _see(client, sid, bot, "cart", seq=1, screen_hash="a", frame=await _frame(client, sid, bot, screen_hash="a"))
    a = await _atlas(client, cid)
    cart = _screen(a, "Cart")
    assert a["refresh"]["state"] == "running" and a["refresh"]["note"] == "Mapping the app on iOS"
    assert a["refresh"]["shots"] == cart["nodes"] and a["refresh"]["platform"] == "ios"
    r = await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": bot, "status": "done"})
    assert r.status_code == 200, r.text
    assert (await _atlas(client, cid))["refresh"]["state"] == "done"
    sid2 = await _session(client, cid, bot)
    await client.patch(f"/api/qa/sessions/{sid2}", json={"actor_agent_id": bot, "status": "cancelled"})
    assert (await _atlas(client, cid))["refresh"]["state"] == "skipped"


async def test_atlas_reads_nothing_it_should_not_write(client, container, people, db):
    cid, bot = container["id"], people["bot"]
    await _import(client, cid, bot, "ios", nodes=[node("cart", "Cart")])
    before = [dict(r) for r in db.execute("SELECT * FROM qa_map_nodes ORDER BY id")]
    await _atlas(client, cid)
    assert [dict(r) for r in db.execute("SELECT * FROM qa_map_nodes ORDER BY id")] == before


async def test_a_frame_says_light_dark_or_blank(client, container, people, attachments):
    cid, bot = container["id"], people["bot"]
    await _import(client, cid, bot, "ios", nodes=[node("cart", "Cart"), node("blank", "Blank")])
    sid = await _session(client, cid, bot)
    light = await _frame(client, sid, bot, screen_hash="light", facts={"appearance": "light"})
    dark = await _frame(client, sid, bot, screen_hash="dark", facts={"appearance": "dark"})
    empty = await _frame(client, sid, bot, screen_hash="blank", facts={"blank": "uniform"})
    await _see(client, sid, bot, "cart", seq=1, screen_hash="same-tree", frame=light)
    await _see(client, sid, bot, "cart", seq=2, screen_hash="same-tree", frame=light)
    sid2 = await _session(client, cid, bot)
    await _see(client, sid2, bot, "cart", seq=1, screen_hash="same-tree", frame=dark)
    await _see(client, sid, bot, "blank", seq=3, screen_hash="blank", frame=empty)
    a = await _atlas(client, cid)
    cart, blank = _screen(a, "Cart"), _screen(a, "Blank")
    assert {s["appearance"] for s in cart["seen_on"]} == {"light", "dark"}
    assert a["coverage"] == [{"form": "phone", "platforms": {"ios": ["light", "dark"]}}]
    assert blank["variants"]["ios"]["frame_url"] is None and blank["variants"]["ios"]["blank"] == "uniform"
    assert blank["seen_on"][0]["blank"] == "uniform" and blank["states"][0]["blank"] == "uniform"


def test_routes_and_names_normalise():
    assert qa_atlas.norm_route("/Listings/:id?tab=1") == "listings/*"
    assert qa_atlas.norm_route("listings/[id]/") == "listings/*"
    assert qa_atlas.norm_route("/") == "/" and qa_atlas.norm_route("") is None
    assert qa_atlas.name_words("ProductDetailView") == qa_atlas.name_words("Product detail")
    assert qa_atlas.look_state(["Something went wrong", "Try again"]) == "error"
    assert qa_atlas.look_state(["Loading"]) == "loading"
    assert qa_atlas.look_state(["Inbox", "Compose"]) == "loaded"
    assert qa_atlas.state_label("alert: Remove item?") == "Alert: Remove item?"
    assert qa_atlas.display_text("* pages") == "… pages"
    assert qa_atlas.device_form("web", "desktop", (390, 844)) == "phone"
    assert qa_atlas.device_label("web", "mobile") == "Chromium 390×844"
