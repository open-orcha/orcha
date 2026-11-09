"""Orcha QA MCP tools (`orcha_cli/qa/mcp_server.py`) against a fake portal and a fake device.

Covers the session lifecycle (start, act, look, frames, steps, map observe), evidence, the 15%
budget rule, the walk loop ending in a drafted scenario with frame evidence, the drafting tools
with no device, and that portal or device failures come back as `error:` text, never a raise.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from orcha_cli.qa.mcp_server import QATools, map_text
from test_qa_mcp_fakes import AGENT, FakeDevice, FakePortal, Identity, opener, shot

HOME = shot("home", ("Heading", "Today"), ("StaticText", "No feeds yet"), ("Button", "Feed"), ("Tab", "Today"))
FEED = shot("feed", ("Heading", "New feed"), ("Button", "Bottle"), ("TextField", "Amount (ml)"), ("Button", "Save feed"), ("Tab", "Today"))
FEED_TYPED = shot("feed2", ("Heading", "New feed"), ("Button", "Bottle"), ("TextField", "120"), ("Button", "Save feed"), ("Tab", "Today"))
SAVED = shot("saved", ("Heading", "Today"), ("StaticText", "Bottle feed"), ("StaticText", "120 ml"), ("Button", "Feed"), ("Tab", "Today"))


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def make(screens=None, clock=None):
    portal = FakePortal()
    device = FakeDevice(screens or [HOME, FEED, FEED_TYPED, SAVED])
    seen: list = []
    tools = QATools(identity=Identity(), portal=portal, device_opener=opener(device, seen), clock=clock or Clock())
    return tools, portal, device, seen


def run(coro):
    return asyncio.run(coro)


def test_start_session_creates_row_opens_device_and_returns_first_screen():
    tools, portal, device, seen = make()
    out = run(tools.start_session("ios", "explore", minutes=20, task_id="task-1", goal="feeds"))
    assert out.startswith("session started")
    assert seen == [("ios", "com.example.snug", None)]  # app from GET /qa/targets; device left to the layer
    body = portal.calls_to("POST", r"/qa/sessions$")[0][2]
    assert body["kind"] == "explore" and body["task_id"] == "task-1" and body["actor_agent_id"] == AGENT
    assert body["budget_minutes"] == 20 and body["app_id"] == "com.example.snug"
    assert "budget: 0m00s used of 20m00s" in out
    assert "map: Today (new screen) key=today" in out
    assert "target notes: sign in as Maya" in out
    assert 'e2 Button "Feed"' in out
    assert portal.frames == [b"jpeg:home"]
    assert portal.sessions["sess-1"]["device_name"] == "iPhone 17 Pro"


def test_start_session_validates_and_refuses_a_second_session():
    tools, portal, device, _ = make()
    assert run(tools.start_session("desktop", "explore")).startswith("error: platform")
    assert run(tools.start_session("ios", "crawl")).startswith("error: kind")
    run(tools.start_session("ios", "map", minutes=0))
    again = run(tools.start_session("ios", "map"))
    assert again.startswith("error: session sess-1 is still running")


def test_start_session_without_app_target_says_what_to_do():
    tools, portal, device, _ = make()
    portal.targets_rows = []
    out = run(tools.start_session("android", "explore"))
    assert out.startswith("error: no android target set for this project: pass app=<an app (bundle id / package)>")


def test_start_session_device_failure_marks_session_failed():
    portal = FakePortal()

    async def broken(*a, **kw):
        raise RuntimeError("both simulators are locked")

    tools = QATools(identity=Identity(), portal=portal, device_opener=broken)
    out = run(tools.start_session("ios", "explore"))
    assert out.startswith("error: could not start the ios device session: both simulators are locked")
    assert portal.sessions["sess-1"]["status"] == "failed"
    assert tools.live is None


def test_action_records_step_uploads_frame_and_observes_with_previous_key():
    tools, portal, device, _ = make()
    run(tools.start_session("ios", "map", minutes=0))
    out = run(tools.tap("e2"))
    assert out.startswith("tap ok\n")
    assert "map: New feed (new screen) key=new-feed" in out
    obs = portal.observed[-1]
    assert obs["from_key"] == "today" and obs["action"] == 'tap "e2"' and obs["frame_id"] == "frame-2"
    assert obs["title"] == "New feed" and "Save feed" in obs["anchors"]
    live = tools.live
    kinds = [s["kind"] for s in live.trace]
    assert kinds == ["launch", "screen", "tap", "screen"]
    assert [s["seq"] for s in live.trace] == [1, 2, 3, 4]
    tap = live.trace[2]
    assert tap["args"]["target"]["spec"] == "e2" and tap["screen_key"] == "today"
    assert live.trace[3]["frame_id"] == "frame-2"


def test_steps_are_batched_and_flushed_at_end():
    tools, portal, device, _ = make([HOME] * 30)
    run(tools.start_session("ios", "map", minutes=0))
    for _ in range(3):
        run(tools.swipe("up"))
    assert portal.steps == {}  # under the batch size
    out = run(tools.end_session("mapped the home screen"))
    assert out.startswith("session sess-1 ended")
    assert sorted(portal.steps) == list(range(1, 9))
    assert all(set(s) >= {"seq", "kind", "args", "result"} for s in portal.steps.values())
    assert device.ended
    sess = portal.sessions["sess-1"]
    assert sess["status"] == "done" and "mapped the home screen" in sess["report_md"]


def test_long_press_clear_and_swipe_coords_map_to_contract_step_kinds():
    tools, portal, device, _ = make([HOME] * 10)
    run(tools.start_session("ios", "map", minutes=0))
    run(tools.long_press("Feed", ms=900))
    run(tools.clear_text("e1"))
    run(tools.swipe_coords(2, 300, 200, 300))
    acts = [s for s in tools.live.trace if s["kind"] not in ("screen", "launch")]
    assert [(a["kind"], a["args"].get("long_press_ms"), a["args"].get("clear")) for a in acts] == [
        ("tap", 900, None), ("type", None, True), ("swipe", None, None)]
    assert ("long_press", ("Feed",)) in device.calls


def test_device_and_portal_failures_return_error_text_not_raise():
    tools, portal, device, _ = make()
    run(tools.start_session("ios", "map", minutes=0))
    device.raise_on.add("tap")
    out = run(tools.tap("e2"))
    assert out.startswith("error: RuntimeError: tap broke")  # recorded and looked again
    portal.fail[("POST", r"/map/observe")] = "HTTP 500: observe broke"
    portal.fail[("POST", r"/frames")] = "HTTP 413: too big"
    out = run(tools.press("home"))
    assert "map: not recorded (map observe failed: HTTP 500: observe broke)" in out
    assert "note: frame not saved: HTTP 413: too big" in out
    portal.fail[("POST", r"/findings")] = "HTTP 503: down"
    assert run(tools.capture_evidence("major", "x", "a", "b")).startswith("error: HTTP 503: down")


def test_tools_need_a_session_and_identity():
    tools, portal, device, _ = make()
    assert run(tools.tap("e1")).startswith("error: no active session")
    assert run(tools.screen()).startswith("error: no active session")

    class NoIdent:
        ok = False
        problems = ["no acting agent (set ORCHA_ALIAS or ORCHA_QA_AGENT_ID)"]

    t2 = QATools(identity=NoIdent(), portal=portal, device_opener=opener(device))
    out = run(t2.start_session("ios", "explore"))
    assert out == "error: cannot reach Orcha as an agent: no acting agent (set ORCHA_ALIAS or ORCHA_QA_AGENT_ID)"
    assert run(t2.list_project()).startswith("error: cannot reach Orcha")


def test_capture_evidence_posts_finding_with_current_frame():
    tools, portal, device, _ = make()
    run(tools.start_session("ios", "explore", minutes=0, task_id="task-9"))
    run(tools.tap("e2"))
    assert run(tools.capture_evidence("blocker", "Bad", "e", "a")).startswith("finding find-1 filed (blocker)")
    out = run(tools.capture_evidence("major", "Save does nothing", "the feed is saved", "nothing happens", "tapped Save"))
    f = portal.findings[-1]
    assert f["frame_ids"] == ["frame-2"] and f["severity"] == "major" and f["task_id"] == "task-9"
    assert f["screen_key"] == "new-feed" and f["end_seq"] >= f["start_seq"]
    assert f["actor_agent_id"] == AGENT
    assert "finding find-2 filed (major), frame frame-2" in out
    assert run(tools.capture_evidence("critical", "x", "y", "z")).startswith("error: severity")


def test_end_session_enforces_the_15_percent_budget_rule():
    clock = Clock()
    tools, portal, device, _ = make(clock=clock)
    run(tools.start_session("ios", "explore", minutes=10))
    clock.t += 60
    refused = run(tools.end_session("done early"))
    assert refused.startswith("error: 9m00s of the 10m00s budget is left")
    assert tools.live is not None and not device.ended
    assert run(tools.end_session("x", reason="I have seen enough")).startswith("error:")
    assert run(tools.end_session("x", reason="tired", force=True)).startswith("error:")  # a reason under 10 chars
    out = run(tools.end_session("crash", reason="blocked: the app crashes on every launch"))
    assert out.startswith("session sess-1 ended") and "(ended early)" in out
    result = portal.sessions["sess-1"]["result"]
    assert result["budget"]["ended_early"] and result["budget"]["early_end_reason"].startswith("blocked:")


def test_end_session_after_most_of_the_budget_and_force_with_reason():
    clock = Clock()
    tools, portal, device, _ = make(clock=clock)
    run(tools.start_session("ios", "explore", minutes=10))
    clock.t += 8.6 * 60  # 1m24s left: under 15%
    assert run(tools.end_session("covered it")).startswith("session sess-1 ended")
    tools2, portal2, _, _ = make(clock=clock)
    run(tools2.start_session("ios", "explore", minutes=10))
    assert run(tools2.end_session("stop", reason="the human asked me to stop now", force=True)).startswith("session")


def test_walk_loop_drafts_a_scenario_with_frame_evidence():
    tools, portal, device, _ = make()
    flow = {"id": "flow-1", "name": "Log a bottle feed", "persona": "a new parent", "data": {"amount": "120 ml", "password": "x"},
            "steps": [{"text": "Open New feed"}, {"text": "Enter 120 in Amount"}, {"text": "Save the feed"}],
            "rank_reasons": ["never walked"], "score": 80}
    portal.queue.append(({"id": "walk-1", "start_seq": None}, flow))
    run(tools.start_session("ios", "explore", minutes=0))
    mission = run(tools.next_flow())
    assert mission.startswith("walk walk-1: Log a bottle feed")
    assert "  3. Save the feed <- the flow's outcome" in mission and 'launch_app("com.example.snug")' in mission
    assert run(tools.next_flow()).startswith("error: walk walk-1")
    run(tools.tap("Feed"))
    assert run(tools.walk_step("walk-1", 1, True, 'The "New feed" form opens', checked=["New feed"])).startswith("step 1 recorded")
    run(tools.type_text("Amount (ml)", "120"))
    run(tools.walk_step("walk-1", 2, True, "Amount reads 120", expected='The amount field holds "120"'))
    # a pass before the outcome step is reported is refused, naming the step
    gap = run(tools.end_walk("walk-1", "passed"))
    assert gap.startswith('error: not a pass yet: step 3 of 3 ("Save the feed")')
    run(tools.tap("Save feed"))
    run(tools.walk_step("walk-1", 3, True, "Back on Today with the feed listed", checked=["Bottle feed"],
                        expected='Today lists the "Bottle feed"'))
    step3 = portal.walk_patches[-1]["step"]
    assert step3["frame_id"] == "frame-4" and step3["seq"] == tools.live.seq and step3["text"] == "Save the feed"
    out = run(tools.end_walk("walk-1", "passed"))
    assert "walk walk-1 ended: passed" in out
    assert "draft scenario created: Log a bottle feed (scen-1)" in out
    end_patch = portal.walk_patches[-1]
    assert end_patch["outcome"] == "passed" and end_patch["end_seq"] == tools.live.seq
    scen = portal.scens["scen-1"]
    assert scen["source"] == "walk" and scen["walk_id"] == "walk-1" and scen["session_id"] == "sess-1"
    assert scen["platform"] == "ios" and scen["tags"] == ["walked", "ios"]
    assert len(scen["criteria"]) == 3
    assert scen["data"] == {"amount": "120 ml"}  # no secrets
    frames = [e["frame_id"] for e in scen["evidence"]]
    assert frames == ["frame-2", "frame-3", "frame-4"]
    assert scen["evidence"][2]["status"] == "verified"
    assert {"criterion_index": 2, "line": 'text "Bottle feed"'} in scen["checks"]
    assert 'Tap "Feed"' in scen["description"] and 'Type "120" into "Amount (ml)"' in scen["description"]
    assert tools.live.walk is None and tools.live.drafts == ["scen-1"]
    # every recorded step reached the portal before the walk ended
    assert max(portal.steps) == tools.live.seq
    assert run(tools.next_flow()).startswith("no flows queued")


def test_end_walk_failed_and_unreachable_need_reasons():
    tools, portal, device, _ = make()
    portal.queue.append(({"id": "w2"}, {"name": "Delete a feed", "steps": ["Open a feed", "Delete it"]}))
    run(tools.start_session("ios", "explore", minutes=0))
    run(tools.next_flow())
    assert run(tools.end_walk("w2", "failed")).startswith("error: a failed walk needs a reason")
    assert run(tools.end_walk("w2", "unreachable", reason="needs a feed", blocked_kind="nope")).startswith("error: blocked_kind")
    out = run(tools.end_walk("w2", "unreachable", reason="no feed exists yet", blocked_kind="needs_data"))
    assert "ended: unreachable" in out and not portal.scens
    assert portal.walk_patches[-1]["blocked_kind"] == "needs_data"


def test_open_walk_is_abandoned_at_end_session():
    tools, portal, device, _ = make()
    portal.queue.append(({"id": "w3"}, {"name": "Flow", "steps": ["a", "b"]}))
    run(tools.start_session("ios", "explore", minutes=0))
    run(tools.next_flow())
    run(tools.end_session("stopping"))
    assert portal.walk_patches[-1]["outcome"] == "abandoned"


def test_briefing_and_charter():
    tools, portal, device, _ = make()
    run(tools.start_session("ios", "explore", minutes=0))
    assert run(tools.submit_briefing({"charter": [{"title": "a"}]})).startswith("error: briefing.charter must list 3 to 8")
    out = run(tools.submit_briefing({"app_summary": "A baby log.", "charter": [{"title": "Feeds"}, {"title": "Sleep"}, {"title": "Diapers"}]}))
    assert "m1: Feeds" in out
    sess = portal.sessions["sess-1"]
    assert sess["briefing"] == {"app_summary": "A baby log."} and len(sess["charter"]) == 3
    out = run(tools.charter_update("m2", "covered", note="all good", finding_ids=["find-1"]))
    assert out.startswith("mission m2: covered; still active: m1, m3")
    assert portal.sessions["sess-1"]["charter"][1]["finding_ids"] == ["find-1"]
    assert run(tools.charter_update("m9", "covered")).startswith("error: no mission 'm9'")
    assert run(tools.charter_update("m1", "done")).startswith("error: status")


def test_post_plan_normalises_flows_without_a_session():
    tools, portal, device, _ = make()
    assert run(tools.post_plan([{"name": "x"}])).startswith("error: pass platform")
    out = run(tools.post_plan([{"name": "Log a feed", "criticality": "urgent", "steps": ["Open Feed", {"text": "Save", "check": "listed"}]}],
                              platform="android", source="code"))
    assert out.startswith("flow queue: 1 flow(s) upserted for android (code)")
    body = portal.calls_to("POST", r"/flows$")[0][2]
    assert body["flows"][0]["criticality"] == "medium"
    assert body["flows"][0]["steps"] == [{"text": "Open Feed"}, {"text": "Save", "check": "listed"}]


def test_drafting_tools_work_without_a_device():
    tools, portal, device, _ = make()
    bad = run(tools.propose_scenario(name="One", description="d", criteria=["only one"], platform="ios"))
    assert bad.startswith("error: a scenario has 2 to 12 criteria")
    bad = run(tools.propose_scenario(name="Feed", description="d", criteria=["The form opens", "The feed is listed"],
                                     platform="ios", checks={"0": ["Buton \"Feed\""]}))
    assert bad.startswith("error: fix these first") and "bad-check" in bad
    out = run(tools.propose_scenario(
        name="Log a bottle feed", description="A parent logs a bottle feed and sees it on Today.",
        criteria=['The "New feed" form opens from Today', 'Today lists the "Bottle feed"'], platform="ios",
        category="Feeding", checks={"0": ['Heading "New feed"'], "1": ['text "Bottle feed"']}, data={"amount": "120 ml"},
        evidence=[{"criterion_index": 0, "status": "code_only", "code_ref": "Feed.swift:12"}]))
    assert out.startswith("scenario created: Log a bottle feed (scen-1)") and "lint: clean" in out
    row = portal.scens["scen-1"]
    assert row["source"] == "generated" and row["checks"] == [{"criterion_index": 0, "line": 'Heading "New feed"'},
                                                         {"criterion_index": 1, "line": 'text "Bottle feed"'}]
    assert row["evidence"][0]["code_ref"] == "Feed.swift:12"
    text = run(tools.get_scenario("scen-1"))
    assert "## Log a bottle feed" in text and '   Check: Heading "New feed"' in text and "status: draft" in text
    assert "amount = 120 ml" in text
    out = run(tools.revise_scenario("scen-1", criteria=['The "New feed" form opens from Today', "Today lists it", "x is shown"]))
    assert out.startswith("scenario scen-1 revised")
    assert portal.scens["scen-1"]["criteria"][2] == "x is shown"
    assert portal.scens["scen-1"]["checks"][0] == {"criterion_index": 0, "line": 'Heading "New feed"'}
    portal.scens["scen-1"]["status"] = "validated"
    assert run(tools.revise_scenario("scen-1", name="Other")).startswith("error: scenario scen-1 is validated")
    again = run(tools.propose_scenario(name="Log a bottle feed", description="d", criteria=["a b", "c d"], platform="ios"))
    assert again.startswith("scenario suggested")
    listing = run(tools.list_project())
    assert "validated:" in listing and "scen-1 [ios] Log a bottle feed" in listing
    assert "target ios: com.example.snug" in listing
    assert run(tools.get_scenario("nope")).startswith("error: HTTP 404")


def test_propose_scenario_reads_its_examples_before_it_lints():
    portal = FakePortal()
    tools = QATools(identity=Identity(), portal=portal)
    out = run(tools.propose_scenario(name="Filter by an amenity", description="A guest narrows the homes.", platform="web",
                                     criteria=["Filtering by {{amenity}} lists homes with {{amenity}}", "Clearing {{amenity}} lists every home"],
                                     examples={"columns": ["amenity"], "rows": [["Parking"], ["Wifi"]]}))
    assert out.startswith("scenario created") and "unresolved-placeholder" not in out


def test_propose_scenario_from_markdown():
    tools, portal, device, _ = make()
    md = ('## Rename a baby\nCategory: Profile\nDescription: A parent renames their baby.\n'
          '1. The profile shows "Amani"\n   Check: text "Amani"\n2. The new name shows on Today\n')
    out = run(tools.propose_scenario(markdown=md, platform="android"))
    assert out.startswith("scenario created: Rename a baby")
    assert portal.scens["scen-1"]["category"] == "Profile"
    assert run(tools.propose_scenario(markdown="no scenario here", platform="ios")).startswith("error: markdown must hold exactly one")


def test_map_tools():
    tools, portal, device, _ = make()
    assert run(tools.read_map()).startswith("error: pass platform")
    portal.map_data = {
        "features": [{"key": "feeding", "name": "Feeding", "summary": "log feeds"}],
        "nodes": [
            {"id": "n1", "kind": "screen", "key": "today", "label": "Today", "state": "seen", "feature_key": "feeding"},
            {"id": "n2", "kind": "screen", "key": "new-feed", "label": "New feed", "state": "declared", "feature_key": "feeding"},
            {"id": "n3", "kind": "screen", "key": "paywall", "label": "Premium", "state": "blocked", "blocked_kind": "paywall",
             "blocked_reason": "needs a subscription"},
            {"id": "n4", "kind": "endpoint", "key": "POST /feeds", "label": "POST /feeds"},
        ],
        "edges": [{"kind": "navigates", "from_node_id": "n1", "to_node_id": "n2", "label": "tap Feed"},
                  {"kind": "calls", "from_node_id": "n2", "to_node_id": "n4"}],
        "last_build": {"source": "code", "status": "done"},
    }
    out = run(tools.read_map(platform="ios"))
    assert out.startswith("map (ios): 3 screens (1 blocked, 1 declared, 1 seen), 1 features; last build: code done")
    assert "feature Feeding (feeding): log feeds" in out and "Premium [blocked: paywall - needs a subscription]" in out
    full = run(tools.read_map(feature="Feeding", platform="ios"))
    assert "ways in: Today via tap Feed" in full and "calls: POST /feeds" in full
    assert run(tools.read_map(feature="nope", platform="ios")).startswith("error: no feature 'nope'")
    assert run(tools.map_blocked("Premium", "nope", "x", platform="ios")).startswith("error: kind")
    assert run(tools.map_blocked("Premium", "paywall", "needs a plan", platform="ios")).startswith("marked blocked on the map: Premium")
    assert run(tools.map_features([{"name": "Feeding", "summary": "log feeds", "extra": 1}], source="code")) == "features recorded: 1 (code)"
    body = portal.calls_to("PUT", r"/features$")[0][2]
    assert body == {"features": [{"name": "Feeding", "summary": "log feeds"}], "source": "code", "actor_agent_id": AGENT}
    assert run(tools.map_features([])).startswith("error:")
    assert "no screens yet" in map_text({}, "android")


def test_verdict_attaches_the_frame():
    tools, portal, device, _ = make()
    run(tools.start_session("ios", "check", minutes=0))
    assert run(tools.verdict("scen-1", 0, "fail")).startswith("error: a fail verdict needs a note")
    out = run(tools.verdict("scen-1", 0, "pass", note="shown"))
    assert out == "verdict recorded: criterion 0 pass (frame frame-1)"
    body = portal.calls_to("POST", r"/verdicts$")[0][2]
    assert body["frame_ids"] == ["frame-1"] and body["criterion_index"] == 0


def test_draft_session_has_no_device():
    tools, portal, device, seen = make()
    out = run(tools.start_session("ios", "draft"))
    assert "device: none" in out and seen == []
    assert run(tools.tap("e1")).startswith("error: this session has no device")
    assert run(tools.end_session("drafted")).startswith("session sess-1 ended")


def test_wait_and_find():
    tools, portal, device, _ = make()
    assert run(tools.wait(0)) == "waited 0ms"
    run(tools.start_session("ios", "map", minutes=0))
    assert run(tools.wait(500)).startswith("waited 500ms\n")
    out = run(tools.find("feed"))
    assert 'Button "Feed"' in out or "Feed" in out


def test_step_guard_refuses_actions(monkeypatch):
    monkeypatch.setenv("ORCHA_QA_STEP_GUARD", "4")
    tools, portal, device, _ = make([HOME] * 10)
    run(tools.start_session("ios", "map", minutes=0))
    run(tools.tap("e1"))
    assert run(tools.tap("e1")).startswith("error: step guard reached (4 steps)")


def test_shutdown_abandons_an_open_session():
    tools, portal, device, _ = make()
    run(tools.start_session("ios", "map", minutes=0))
    run(tools.shutdown())
    assert portal.sessions["sess-1"]["status"] == "abandoned" and device.ended and tools.live is None


def test_server_registers_every_contract_tool():
    pytest.importorskip("mcp")
    from orcha_cli.qa.mcp_server import build_server

    tools, *_ = make()
    server = build_server(tools)
    names = {t.name for t in asyncio.run(server.list_tools())}
    contract = {"start_session", "screen", "tap", "long_press", "type_text", "clear_text", "swipe", "swipe_coords", "press",
                "open_url", "launch_app", "terminate_app", "wait", "find", "capture_evidence", "end_session", "read_map",
                "map_features", "map_blocked", "submit_briefing", "charter_update", "post_plan", "next_flow", "walk_step",
                "end_walk", "list_project", "get_scenario", "propose_scenario", "revise_scenario", "verdict"}
    assert contract <= names
    result = asyncio.run(server.call_tool("tap", {"target": "e1"}))
    text = result.content[0].text
    assert text.startswith("error: no active session")


# ---------------------------------------------------------------- web

from test_qa_mcp_fakes import FakeWebSession  # noqa: E402

from orcha_cli.qa.mcp_server import allowed_origins, origin_of, route_of  # noqa: E402

SHOP = shot("shop", ("Heading", "Shop"), ("Link", "Orders"), ("Button", "Sign in"))
ORDER = shot("order", ("Heading", "Order 8812"), ("StaticText", "Shipped"), ("Link", "Back to orders"))


def make_web(notes="Allowed: https://pay.example.com, cdn.example.com", device_name=None):
    portal = FakePortal()
    portal.targets_rows = [{"platform": "web", "app_id": "https://shop.example.com/start", "device_name": device_name, "notes": notes}]
    dev = FakeWebSession([SHOP, ORDER], ["https://shop.example.com/start", "https://shop.example.com/orders/8812"])
    seen: list = []
    tools = QATools(identity=Identity(), portal=portal, device_opener=opener(dev, seen), clock=Clock())
    return tools, portal, dev, seen


def test_web_helpers():
    assert origin_of("https://Shop.example.com/a?b=1") == "https://shop.example.com"
    assert origin_of("com.example.app") is None
    assert allowed_origins("Sign in as qa@example.com\nAllowed: https://pay.example.com/, cdn.example.com http://x.test") == [
        "https://pay.example.com", "https://cdn.example.com", "http://x.test"]
    assert allowed_origins(None) == []
    assert route_of("https://s.test/orders/8812/items?x=1") == "/orders/:id/items"
    assert route_of("https://s.test/u/3f2b9c1e-1111-2222-3333-444455556666") == "/u/:id"
    assert route_of("https://s.test/") == "/" and route_of(None) is None


def test_web_session_starts_with_viewport_and_allowed_origins():
    tools, portal, dev, seen = make_web()
    out = run(tools.start_session("web", "explore", minutes=0))
    assert out.startswith("session started")
    assert seen == [("web", "https://shop.example.com/start", "desktop",
                     {"allowed_origins": ["https://pay.example.com", "https://cdn.example.com"]})]
    assert "target: https://shop.example.com/start in Chromium (desktop viewport)" in out
    assert "allowed origins: https://shop.example.com, https://pay.example.com, https://cdn.example.com" in out
    assert portal.observed[0]["route"] == "/start"
    assert tools.live.trace[1]["args"]["url"] == "https://shop.example.com/start"


def test_web_session_validates_viewport_and_url():
    tools, *_ = make_web()
    assert run(tools.start_session("web", "explore", device="tablet")).startswith("error: on the web, device is the viewport")
    assert run(tools.start_session("web", "explore", app="shop.example.com")).startswith("error: the web target must be an http(s) URL")
    tools, _, _, seen = make_web(device_name="mobile")
    run(tools.start_session("web", "map", minutes=0, app="https://shop.example.com/"))
    assert seen[0][1:3] == ("https://shop.example.com/", "mobile")


def test_web_open_url_stays_within_the_allowed_origins():
    tools, portal, dev, _ = make_web()
    run(tools.start_session("web", "explore", minutes=0))
    blocked = run(tools.open_url("https://evil.example.net/phish"))
    assert blocked.startswith("blocked: https://evil.example.net/phish is outside this session's origins")
    assert ("open_url", ("https://evil.example.net/phish",)) not in dev.calls
    out = run(tools.open_url("/orders/8812"))
    assert out.startswith("navigated to https://shop.example.com/orders/8812")
    assert portal.observed[-1]["route"] == "/orders/:id" and portal.observed[-1]["from_key"] == "shop"
    assert run(tools.open_url("https://pay.example.com/checkout")).startswith("navigated to https://pay.example.com/checkout")
    assert run(tools.launch_app("https://evil.example.net")).startswith("blocked:")
    assert run(tools.launch_app()).startswith("launched")


def test_native_screens_send_no_route():
    tools, portal, device, _ = make()
    run(tools.start_session("ios", "map", minutes=0))
    assert "route" not in portal.observed[0]


SIGN_IN = shot("sign-in", ("Heading", "Sign in"), ("SecureTextField", "Password"), ("Button", "Go"))


def test_a_password_stays_out_of_the_step_and_the_answer():
    tools, portal, device, _ = make([SIGN_IN, SIGN_IN])

    async def typed(target, text):
        device.calls.append(("type_text", (target, text)))
        return f"typed {text!r}; field value now {text!r}"

    device.type_text = typed
    run(tools.start_session("ios", "explore", minutes=20))
    out = run(tools.type_text("Password", "harbour-tide-42"))
    assert ("type_text", ("Password", "harbour-tide-42")) in device.calls  # the device gets it
    assert "harbour-tide-42" not in out
    typed = [s for s in tools.live.unsent if s["kind"] == "type"]
    assert typed and "harbour-tide-42" not in json.dumps(typed)


def test_a_plain_field_keeps_what_was_typed():
    tools, portal, device, _ = make()
    run(tools.start_session("ios", "explore", minutes=20))
    run(tools.tap("Feed"))
    run(tools.type_text("Amount", "120"))
    assert "120" in json.dumps([s for s in tools.live.unsent if s["kind"] == "type"])
