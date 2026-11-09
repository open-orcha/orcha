"""Orcha QA: what the map and the atlas read beyond the map itself. Frames carry what the CLI read
from them, steps carry their timing, sessions carry their build and crawl queue."""
import datetime as dt
import io

import pytest

from orcha_cli.qa import crawl_queue as cq
from orcha_cli.qa import frame_facts
from portal_backend import qa_atlas, qa_map, qa_perf
from conftest import run_task_id


def jpeg(width=390, height=844):
    sof = (b"\xff\xc0\x00\x11\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big")
           + b"\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01")
    return b"\xff\xd8" + sof + b"\xff\xd9"


def picture(colour, lines=0, size=(390, 844)):
    from PIL import Image, ImageDraw

    img = Image.new("RGB", size, colour)
    draw = ImageDraw.Draw(img)
    for i in range(lines):
        draw.rectangle((30, 120 + i * 60, 340, 150 + i * 60), fill=(128, 128, 128))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=90)
    return out.getvalue()


@pytest.fixture
async def people(make_agent):
    human = await make_agent("Hussein", "owner", kind="human")
    bot = await make_agent("qa-bot")
    return {"human": human["agent_id"], "bot": bot["agent_id"]}


async def _session(client, cid, actor, platform="ios", device="iPhone 17 Pro", kind="map"):
    r = await client.post(f"/api/containers/{cid}/qa/sessions", json={
        "actor_agent_id": actor, "kind": kind, "platform": platform, "device_name": device,
        "task_id": await run_task_id(client, cid, actor)})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _import(client, cid, actor, platform, keys):
    r = await client.post(f"/api/containers/{cid}/qa/map/import", json={
        "actor_agent_id": actor, "platform": platform, "source": "code",
        "nodes": [{"kind": "screen", "key": k, "label": k.title()} for k in keys]})
    assert r.status_code == 200, r.text


async def _frame(client, sid, actor, screen_hash, **facts):
    r = await client.post(f"/api/qa/sessions/{sid}/frames", params={"actor_agent_id": actor, "screen_hash": screen_hash, **facts},
                          content=jpeg(), headers={"content-type": "image/jpeg"})
    assert r.status_code == 201, r.text
    return r.json()["frame_id"]


async def _steps(client, sid, actor, steps):
    r = await client.post(f"/api/qa/sessions/{sid}/steps", json={"actor_agent_id": actor, "steps": steps})
    assert r.status_code in (200, 201), r.text


def see(seq, key, frame=None, texts=("Your cart", "Check out"), at=None, screen_hash=None):
    return {"seq": seq, "kind": "screen", "args": {"title": texts[0], "texts": list(texts), "anchors": []}, "screen_key": key,
            "screen_hash": screen_hash or f"{key}-{seq}", "frame_id": frame, **({"at": at} if at else {})}


def act(seq, ms, kind="tap", at=None, **timing):
    return {"seq": seq, "kind": kind, "args": {}, "result": "ok", "duration_ms": ms, "timing": timing, **({"at": at} if at else {})}


# ---------- what a frame says (the CLI) ----------


def test_a_frame_says_its_look_and_shade():
    pytest.importorskip("PIL")
    light = frame_facts.read(picture((248, 248, 248), 4))
    dark = frame_facts.read(picture((12, 12, 14), 4))
    assert light["appearance"] == "light" and dark["appearance"] == "dark"
    assert light["fingerprint"].endswith("-390x844") and len(light["fingerprint"].split("-")[0]) == 16
    assert frame_facts.read(picture((0, 0, 0))) == {"blank": "uniform"}
    assert frame_facts.read(picture((0, 0, 0)), secure=True) == {"blank": "flag_secure"}


def test_what_the_device_was_set_to_decides_only_when_the_frame_is_unsure():
    assert frame_facts.resolve_appearance("dark", ("light", True)) == "light"
    assert frame_facts.resolve_appearance("dark", ("light", False)) == "dark"
    assert frame_facts.resolve_appearance(None, ("light", False)) == "light"
    assert frame_facts.read(b"not an image") == {}


# ---------- similarity ----------


def side(platform, texts, fp=None, **kw):
    return qa_atlas.Side(platform, list(texts), fp, seen=True, **kw)


FP = "00ff00ff00ff00ff-808080-390x844"


def test_a_word_or_an_order_is_minor_and_mostly_other_words_are_different():
    a = side("ios", ["Your cart", "Check out", "Total", "Delivery", "Promo code"], FP)
    minor = side("android", ["Your cart", "Pay now", "Total", "Delivery", "Promo code"], FP)
    far = side("android", ["Rewards", "Weekly picks", "Fresh deals"], "ff00ff00ff00ff00-101010-390x844")
    sim = qa_atlas.similarity({"ios": a, "android": minor}, ["ios", "android"])
    assert sim["badge"] == "minor" and 0.62 <= sim["score"] < 0.88
    assert sim["reasons"]
    sim = qa_atlas.similarity({"ios": a, "android": far}, ["ios", "android"])
    assert sim["badge"] == "different" and sim["score"] < 0.62
    assert "The layout looks different" in sim["reasons"]


def test_the_same_screen_is_same_and_two_appearances_are_not_scored():
    a = side("ios", ["Your cart", "Check out"], FP, appearance="light", form="phone")
    b = side("android", ["Your cart", "Check out"], FP, appearance="light", form="phone")
    assert qa_atlas.similarity({"ios": a, "android": b}, ["ios", "android"])["badge"] == "same"
    dark = side("android", ["Your cart", "Check out"], FP, appearance="dark", form="phone")
    sim = qa_atlas.similarity({"ios": a, "android": dark}, ["ios", "android"], options={"ios": [a], "android": [dark]})
    assert sim["badge"] == "unchecked" and sim["pairs"][0]["fair"] is False


def test_one_app_ignoring_a_shared_setting_still_compares():
    a = side("ios", ["Your cart"], FP, appearance="light", set_appearance="light", form="phone")
    b = side("android", ["Your cart"], FP, appearance="dark", set_appearance="light", form="phone")
    sim = qa_atlas.similarity({"ios": a, "android": b}, ["ios", "android"])
    assert sim["pairs"][0]["match"] == "setting" and sim["badge"] == "minor"
    assert any("though the device was set to light" in r for r in sim["reasons"])


async def test_a_look_carries_its_frames_facts_and_the_atlas_compares_them(client, container, people):
    cid, bot = container["id"], people["bot"]
    for p in ("ios", "android"):
        await _import(client, cid, bot, p, ["cart"])
    ios = await _session(client, cid, bot, "ios", "iPhone 17 Pro")
    droid = await _session(client, cid, bot, "android", "Pixel 9a")
    f1 = await _frame(client, ios, bot, "a", fingerprint=FP, appearance="dark")
    f2 = await _frame(client, droid, bot, "b", fingerprint="ff00ff00ff00ff00-101010-390x844", appearance="dark")
    await _steps(client, ios, bot, [see(1, "cart", f1, texts=("Your cart", "Check out", "Total"))])
    await _steps(client, droid, bot, [see(1, "cart", f2, texts=("Your cart", "Check out", "Total"))])
    a = (await client.get(f"/api/containers/{cid}/qa/atlas")).json()
    cart = a["screens"][0]
    assert cart["similarity"]["badge"] == "minor" and "The layout looks different" in cart["similarity"]["reasons"]
    assert {s["appearance"] for s in cart["seen_on"]} == {"dark"}
    assert a["coverage"][0]["platforms"]["ios"] == ["dark"]


# ---------- builds ----------


async def test_since_goes_by_build(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _import(client, cid, bot, "ios", ["cart"])
    old = await _session(client, cid, bot)
    await client.patch(f"/api/qa/sessions/{old}", json={"actor_agent_id": bot, "build_label": "1.4.0 (212)", "device_appearance": "dark"})
    await _steps(client, old, bot, [see(1, "cart", await _frame(client, old, bot, "old"), at="2026-10-01T10:00:00Z", screen_hash="old")])
    await client.patch(f"/api/qa/sessions/{old}", json={"actor_agent_id": bot, "status": "done"})
    new = await _session(client, cid, bot)
    await client.patch(f"/api/qa/sessions/{new}", json={"actor_agent_id": bot, "build_label": "1.5.0 (230)"})
    later = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=2)).isoformat()
    await _steps(client, new, bot, [see(1, "cart", await _frame(client, new, bot, "new"), texts=("Your basket",), at=later, screen_hash="new")])
    a = (await client.get(f"/api/containers/{cid}/qa/atlas", params={"since": "1.4.0 (212)"})).json()
    assert {b["label"] for b in a["builds"]} == {"1.4.0 (212)", "1.5.0 (230)"}
    assert a["since"]["kind"] == "build" and a["since"]["label"] == "build 1.4.0 (212)"
    cart = a["screens"][0]
    assert cart["variants"]["ios"]["build"] == "1.5.0 (230)" and cart["last_build"] == "1.5.0 (230)"
    assert cart["change"]["platforms"][0]["before"]["build"] == "1.4.0 (212)"
    assert cart["change"]["platforms"][0]["after"]["build"] == "1.5.0 (230)"


# ---------- timing ----------


async def test_a_timed_action_is_a_sample_of_the_screen_it_led_to(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _import(client, cid, bot, "ios", ["cart"])
    sid = await _session(client, cid, bot)
    await _steps(client, sid, bot, [
        act(1, 4000, kind="launch", cold=True), see(2, "cart"),
        act(3, 900, appear_ms=400, settle_ms=800, settled="changed", load=0.4), see(4, "cart"),
        act(5, 500, settle_ms=450, settled="unchanged"), see(6, "cart"),      # a dead tap times nothing
        act(7, 900, appear_ms=300, settle_ms=700, settled="changed", load=2.5), see(8, "cart"),  # under load
        act(9, 900, appear_ms=300, settled="changed"),                        # no screen after it
    ])
    r = await client.get(f"/api/containers/{cid}/qa/perf", params={"days": 30})
    assert r.status_code == 200, r.text
    d = r.json()
    rows = [(s["metric"], s["value"], s["noise"]) for s in d["samples"]]
    assert ("launch", 4000, "cold_start") in rows
    assert ("appear", 400, None) in rows and ("settle", 800, None) in rows
    assert ("appear", 300, "under_load") in rows
    assert not any(s["step_seq"] == 5 for s in d["samples"])
    assert d["samples"][0]["screen_label"] == "Cart" and d["samples"][0]["device_class"] == "iPhone 17 Pro"
    assert d["platforms"] == ["ios"] and d["settings"]["budgets"]["appear_ms"] == 1500
    assert d["running"][0]["run_id"] == sid and d["running"][0]["timed"] == 5


async def test_speed_budgets_are_a_persons_to_change(client, container, people):
    cid = container["id"]
    url = f"/api/containers/{cid}/qa/perf/settings"
    assert (await client.put(url, json={"actor_agent_id": people["bot"], "change": {"load_limit": 2}})).status_code == 403
    r = await client.put(url, json={"actor_agent_id": people["human"], "change": {"load_limit": 99}})
    assert r.status_code == 400 and "load_limit" in r.text
    r = await client.put(url, json={"actor_agent_id": people["human"], "change": {"load_limit": 2, "budgets": {"appear_ms": 900}}})
    assert r.status_code == 200 and r.json()["budgets"] == {"web_lcp_ms": 2500, "appear_ms": 900, "launch_ms": 3000}
    assert (await client.get(url)).json()["load_limit"] == 2


def test_a_web_viewport_is_its_device_class():
    assert qa_perf.device_class("web", "mobile") == "mobile" and qa_perf.device_class("web", "desktop") == "desktop"
    assert qa_perf.device_class("ios", "iPhone 17 Pro") == "iPhone 17 Pro"


# ---------- the build under way, the crawl queue ----------


async def test_a_build_shows_running_until_its_import_ends_it(client, container, people):
    cid, bot = container["id"], people["bot"]
    r = await client.post(f"/api/containers/{cid}/qa/map/builds", json={"actor_agent_id": bot, "platform": "web"})
    assert r.status_code == 201, r.text
    got = (await client.get(f"/api/containers/{cid}/qa/map", params={"platform": "web"})).json()
    assert got["last_build"]["status"] == "running"
    await _import(client, cid, bot, "web", ["/cart"])
    got = (await client.get(f"/api/containers/{cid}/qa/map", params={"platform": "web"})).json()
    assert got["last_build"]["status"] == "done" and got["last_build"]["id"] == r.json()["build_id"]


def test_a_build_nobody_ended_reads_as_failed():
    old = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=30)).isoformat()
    assert qa_map._live_build({"status": "running", "started_at": old})["status"] == "failed"
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    assert qa_map._live_build({"status": "running", "started_at": now})["status"] == "running"


async def test_a_session_carries_its_queue_and_the_atlas_reads_its_targets(client, container, people):
    cid, bot = container["id"], people["bot"]
    await _import(client, cid, bot, "web", ["/cart", "/help"])
    sid = await _session(client, cid, bot, "web", "desktop")
    q = cq.plan_session({"nodes": [{"kind": "screen", "key": k, "label": k, "state": "declared"} for k in ("/cart", "/help")]},
                        platform="web", start_url="https://a.example/", minutes=20, focus="deeper")
    q.start_next()
    r = await client.put(f"/api/qa/sessions/{sid}/crawl-queue", json={"actor_agent_id": bot, "queue": q.as_json()})
    assert r.status_code == 200, r.text
    got = (await client.get(f"/api/qa/sessions/{sid}")).json()
    s = got.get("session") or got
    assert s["crawl_queue"]["current"] == "/cart" and s["crawl_queue"]["total"] == 2
    a = (await client.get(f"/api/containers/{cid}/qa/atlas")).json()
    assert a["refresh"]["state"] == "running" and len(a["refresh"]["targets"]) == 2
    assert a["refresh"]["depth"] == "deeper" and a["refresh"]["fill_most"] == 25 and a["refresh"]["minutes"] == 3
    await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": bot, "status": "done"})
    r = await client.put(f"/api/qa/sessions/{sid}/crawl-queue", json={"actor_agent_id": bot, "queue": {}})
    assert r.status_code == 409


def test_the_device_chrome_never_names_a_screen():
    from types import SimpleNamespace

    from orcha_cli.qa.device.tree import Element
    from orcha_cli.qa.session_state import observation
    bar = Element(0, "StaticText", "T-Mobile, signal full.", "", "", 0, 0, 100, 20, True, ["System"])
    title = Element(1, "StaticText", "Today", "", "", 0, 100, 100, 120, True)
    seen = observation(SimpleNamespace(elements=[bar, title]))
    assert seen["title"] == "Today" and "T-Mobile, signal full." not in seen["texts"]


def test_another_app_in_front_stays_off_the_android_map():
    from types import SimpleNamespace

    from orcha_cli.qa.session_state import other_app
    chrome = SimpleNamespace(foreground="com.android.chrome")
    assert other_app("android", chrome, "com.acme.app") is True
    assert other_app("android", SimpleNamespace(foreground="com.acme.app"), "com.acme.app") is False
    assert other_app("ios", chrome, "com.acme.app") is False
