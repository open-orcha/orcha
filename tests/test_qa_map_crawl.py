"""Orcha QA: a map session's planned crawl (`crawl_queue`, `crawl_next`) and what a step and a frame
record (timing, facts, build), driven through the tool server on the fakes."""
from __future__ import annotations

import asyncio

from orcha_cli.qa import crawl_queue as cq
from orcha_cli.qa.mcp_server import QATools, step_timing
from test_qa_mcp_fakes import FakeDevice, FakePortal, Identity, opener, shot


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def node(key, state="declared", **extra):
    return {"kind": "screen", "key": key, "label": key.strip("/").title() or "Home", "state": state, **extra}


MAP = {"features": [], "edges": [{"kind": "navigates", "from_key": "/", "to_key": "/orders/*", "label": 'Tap "Orders"', "count": 2}],
       "nodes": [node("/", "seen"), node("/cart"), node("/orders/*"), node("/account", detail={"code": {"route": "/account"}})]}


def make(screens=None, map_data=None):
    portal = FakePortal()
    portal.targets_rows = [{"platform": "web", "app_id": "https://shop.example/", "device_name": None, "notes": None}]
    portal.map_data = map_data or MAP
    device = FakeDevice(screens or [shot("Home")] * 8)
    return QATools(identity=Identity(), portal=portal, device_opener=opener(device), clock=Clock()), portal, device


def run(coro):
    return asyncio.run(coro)


# ---------- the queue ----------


def test_a_screen_with_a_route_comes_before_one_that_needs_a_record():
    targets = cq.plan_queue(MAP, platform="web", start_url="https://shop.example/en/")
    assert [t.key for t in targets] == ["/orders/*", "/account", "/cart"]
    by = {t.key: t for t in targets}
    assert by["/cart"].way_in.url == "https://shop.example/en/cart"
    assert by["/orders/*"].way_in.kind == "path" and by["/orders/*"].way_in.hops[0]["label"] == 'Tap "Orders"'
    assert "1 hop from a seen screen" in by["/orders/*"].why


def test_a_map_session_gets_a_queue_a_focused_pass_keeps_its_list():
    q = cq.plan_session(MAP, platform="web", start_url="https://shop.example/", minutes=10, focus=None)
    assert (q.reach_s, q.explore_s) == (30, 45) and len(q.targets) == 3
    deep = cq.plan_session(MAP, platform="web", start_url="https://shop.example/", minutes=10, focus="deeper")
    assert (deep.reach_s, deep.explore_s) == (30, 30) and deep.focus == "deeper"
    data = {"nodes": [node("/a", feature_key="x"), node("/b", feature_key="x"), node("/c", feature_key="y"),
                      node("/d", "seen", feature_key="z"), node("/e", feature_key="z")], "edges": []}
    over = cq.plan_session(data, platform="web", start_url="https://s.example/", minutes=10, focus="overview")
    assert [t.key for t in over.targets] == ["/a", "/c"]
    assert cq.plan_session({"nodes": [node("/", "seen")], "edges": []}, platform="web", start_url=None, minutes=10, focus=None) is None


def test_the_clock_nudges_then_moves_on():
    now = [100.0]
    q = cq.CrawlQueue([cq.Target("/a", "A"), cq.Target("/b", "B")], budgets=(30, 45), clock=lambda: now[0])
    q.start_next()
    now[0] += 35
    assert "time's up for A" in q.tick().nudge
    now[0] += 10
    tick = q.tick()
    assert tick.advanced is not None and q.by_key("/a").status == "skipped" and "not reached in its 0:30 budget" in q.by_key("/a").reason


def test_what_the_page_reads_counts_down_the_current_target():
    now = [100.0]
    q = cq.CrawlQueue([cq.Target("/a", "A"), cq.Target("/b", "B")], budgets=(30, 45), clock=lambda: now[0])
    q.start_next()
    assert q.observe("/a", "A") == "reached A: explore it (45 s)"
    row = q.as_json()["targets"][0]
    assert row["status"] == "current" and row["phase"] == "explore" and row["budget_s"] == 45 and row["deadline_at"]
    assert q.observe("/new", "New", new=True) == "new screen: New joined the queue"
    assert q.as_json()["total"] == 3


# ---------- through the tool server ----------


def test_a_map_session_stores_its_queue_and_crawl_next_opens_a_target():
    t, portal, device = make()
    out = run(t.start_session("web", "map", minutes=10))
    assert "crawl: 3 targets queued (30 s to reach and 45 s to explore each); call crawl_next() to open the first" in out
    assert "crawl: 3 targets queued; call crawl_next() to open the first" in out
    assert portal.calls_to("PUT", "crawl-queue")
    next_out = run(t.crawl_next())
    assert "crawl: target 1 of 3:" in next_out and "crawl: way in:" in next_out
    assert t.live.crawl.current is not None and t.live.crawl.started is not None


def test_a_dead_end_needs_a_reason_and_goes_on_the_map():
    t, portal, _ = make()
    run(t.start_session("web", "map", minutes=10))
    run(t.crawl_next())
    assert run(t.crawl_next("nope", "x")).startswith("error: blocked_kind must be")
    assert run(t.crawl_next("needs_sign_in", "")).startswith("error: say what stopped you")
    out = run(t.crawl_next("needs_sign_in", "It asks to sign in"))
    assert "marked a dead end (needs_sign_in)" in out
    assert portal.calls_to("POST", "/map/blocked")


def test_a_session_of_another_kind_has_no_queue():
    t, _, _ = make()
    run(t.start_session("web", "explore", minutes=10))
    assert t.live.crawl is None
    assert run(t.crawl_next()).startswith("not a planned crawl")


def test_focus_is_for_a_map_session():
    t, _, _ = make()
    assert run(t.start_session("web", "explore", focus="deeper")).startswith("error: focus is for a map session")


def test_the_report_says_what_was_not_reached():
    t, _, _ = make()
    run(t.start_session("web", "map", minutes=0.01))
    run(t.crawl_next())
    run(t.end_session("done", force=True, reason="enough for this test"))
    body = t.portal.calls_to("PATCH", "/api/qa/sessions/")[-1][2]
    assert "## Crawl" in body["report_md"] and body["result"]["crawl"]["targets"] == 3


# ---------- what a step and a session record ----------


def test_an_action_says_when_the_screen_reacted_and_held_still():
    got = step_timing(0.9, {"verdict": "changed", "phase1_ms": 120, "phase2_ms": 300, "total_ms": 420})
    assert got["duration_ms"] == 900 and got["timing"]["appear_ms"] == 120 and got["timing"]["settle_ms"] == 420
    dead = step_timing(0.5, {"verdict": "unchanged", "phase1_ms": 450, "phase2_ms": 0, "total_ms": 450})
    assert "appear_ms" not in dead["timing"] and dead["timing"]["settled"] == "unchanged"
    assert step_timing(0.5, None, failed=True) == {}


def test_a_step_carries_its_time_and_a_session_its_build():
    t, portal, device = make()
    device.app_version = None
    run(t.start_session("web", "explore", minutes=0, build="1.4.0"))
    device.last_settle_timing = None
    run(t.tap("Save"))
    run(t.end_session("done", force=True, reason="enough for this test"))
    steps = [s for s in portal.steps.values() if s["kind"] == "tap"]
    assert steps and steps[0]["duration_ms"] == 0 and "timing" in steps[0]
    launch = next(s for s in portal.steps.values() if s["kind"] == "launch")
    assert launch["timing"] == {"cold": True}
    patched = [c[2] for c in portal.calls_to("PATCH", "/api/qa/sessions/")]
    assert any(b.get("build_label") == "1.4.0" for b in patched)
