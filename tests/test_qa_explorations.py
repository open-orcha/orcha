"""Orcha QA explorations: what a person keeps on a session, the series, the queue, a finding's
severity and scenario, the audit's measurements and the App model (migration 095)."""
import pytest
from conftest import run_task_id


@pytest.fixture
async def people(make_agent):
    human = await make_agent("Hussein", "owner", kind="human")
    bot = await make_agent("qa-bot")
    return {"human": human["agent_id"], "bot": bot["agent_id"]}


async def _session(client, cid, bot, platform="ios", kind="explore", goal="sign up", **more):
    r = await client.post(f"/api/containers/{cid}/qa/sessions", json={"actor_agent_id": bot, "kind": kind, "platform": platform, "task_id": await run_task_id(client, cid, bot), "goal": goal, **more})
    assert r.status_code == 201, r.text
    return r.json()


async def _finding(client, sid, bot, **more):
    r = await client.post(f"/api/qa/sessions/{sid}/findings", json={"actor_agent_id": bot, "severity": "minor", "title": "Save does nothing", **more})
    assert r.status_code == 201, r.text
    return r.json()


async def test_only_a_person_keeps_a_session(client, container, people):
    sid = (await _session(client, container["id"], people["bot"]))["id"]
    r = await client.patch(f"/api/qa/sessions/{sid}/keep", json={"actor_agent_id": people["bot"], "name": "Mine"})
    assert r.status_code == 403
    r = await client.patch(f"/api/qa/sessions/{sid}/keep", json={"actor_agent_id": people["human"], "name": "  Sign  up pass ", "pinned": True, "notes": "Look again"})
    assert r.status_code == 200, r.text
    row = r.json()
    assert row["name"] == "Sign up pass" and row["pinned_at"] and row["notes"] == "Look again"
    r = await client.patch(f"/api/qa/sessions/{sid}/keep", json={"actor_agent_id": people["human"], "name": "", "pinned": False})
    assert r.json()["name"] is None and r.json()["pinned_at"] is None


async def test_a_running_session_cannot_be_archived(client, container, people):
    sid = (await _session(client, container["id"], people["bot"]))["id"]
    r = await client.patch(f"/api/qa/sessions/{sid}/keep", json={"actor_agent_id": people["human"], "archived": True})
    assert r.status_code == 409
    await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": people["bot"], "status": "done"})
    r = await client.patch(f"/api/qa/sessions/{sid}/keep", json={"actor_agent_id": people["human"], "archived": True})
    assert r.status_code == 200 and r.json()["archived_at"]


async def test_the_same_work_joins_the_series_of_the_last(client, container, people):
    cid, bot = container["id"], people["bot"]
    a = await _session(client, cid, bot)
    b = await _session(client, cid, bot, goal="  Sign   UP ")
    c = await _session(client, cid, bot, goal="checkout")
    assert a["series_id"] == a["id"] and a["previous_session_id"] is None
    assert b["series_id"] == a["id"] and b["previous_session_id"] == a["id"]
    assert c["series_id"] == c["id"]


async def test_run_again_queues_a_session_the_agent_takes(client, container, people):
    cid, bot, human = container["id"], people["bot"], people["human"]
    a = await _session(client, cid, bot, budget_minutes=15)
    await client.patch(f"/api/qa/sessions/{a['id']}", json={"actor_agent_id": bot, "status": "done"})
    r = await client.post(f"/api/qa/sessions/{a['id']}/again", json={"actor_agent_id": bot})
    assert r.status_code == 403
    r = await client.post(f"/api/qa/sessions/{a['id']}/again", json={"actor_agent_id": human})
    assert r.status_code == 201, r.text
    q = r.json()
    assert q["queued_at"] and q["claimed_at"] is None and q["series_id"] == a["id"] and q["previous_session_id"] == a["id"]
    assert q["budget_minutes"] == 15 and q["goal"] == "sign up"
    d = (await client.get(f"/api/qa/sessions/{q['id']}")).json()
    assert d["queue"]["position"] == 1 and d["queue"]["waiting"] == "qa-bot"
    from portal_backend.qa_explorations_routes import _repeat_description

    assert _repeat_description({"kind": "explore", "platform": "ios", "budget_minutes": 15, "goal": 'say "hi"'}) .startswith(
        "Run /orcha-qa-explore for this task on ios --minutes 15 --focus \"say 'hi'\"")

    took = await _session(client, cid, bot, task_id=q["task_id"], device_name="iPhone 17 Pro")
    assert took["id"] == q["id"] and took["claimed_at"] and took["device_name"] == "iPhone 17 Pro"
    assert (await client.get(f"/api/qa/sessions/{q['id']}")).json()["queue"] is None


async def test_duplicate_starts_a_new_series(client, container, people):
    a = await _session(client, container["id"], people["bot"])
    r = await client.post(f"/api/qa/sessions/{a['id']}/duplicate", json={"actor_agent_id": people["human"]})
    assert r.status_code == 201, r.text
    assert r.json()["series_id"] == r.json()["id"] and r.json()["previous_session_id"] is None


async def test_run_qa_queues_its_task(client, container, make_agent, people):
    cid, human = container["id"], people["human"]
    t = await client.post(f"/api/containers/{cid}/tasks", json={"title": "Explore", "definition_of_done": "Explored.", "created_by_agent_id": human})
    assert t.status_code in (200, 201), t.text
    tid = t.json()["task_id"]
    r = await client.post(f"/api/containers/{cid}/qa/sessions/queue", json={"actor_agent_id": people["bot"], "kind": "explore", "platform": "ios", "task_id": tid})
    assert r.status_code == 403
    r = await client.post(f"/api/containers/{cid}/qa/sessions/queue", json={"actor_agent_id": human, "kind": "explore", "platform": "ios", "task_id": tid, "budget_minutes": 20})
    assert r.status_code == 201, r.text
    assert r.json()["queued_at"] and r.json()["task_id"] == tid


async def _queued_task(client, cid, human):
    t = await client.post(f"/api/containers/{cid}/tasks", json={"title": "Explore", "definition_of_done": "Explored.", "created_by_agent_id": human})
    assert t.status_code in (200, 201), t.text
    return t.json()["task_id"]


async def test_stopping_a_queued_session_cancels_its_task(client, container, people):
    cid, human = container["id"], people["human"]
    tid = await _queued_task(client, cid, human)
    q = (await client.post(f"/api/containers/{cid}/qa/sessions/queue", json={"actor_agent_id": human, "kind": "explore", "platform": "ios", "task_id": tid})).json()
    r = await client.patch(f"/api/qa/sessions/{q['id']}", json={"actor_agent_id": human, "status": "cancelled"})
    assert r.status_code == 200, r.text
    tasks = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    assert next(t for t in tasks if t["id"] == tid)["status"] == "cancelled"


async def test_stopping_a_session_an_agent_took_ends_its_run_task(client, container, people):
    """A person's Stop means stop: left open, the task's next wake starts the run over (seen on a real project)."""
    cid, human = container["id"], people["human"]
    tid = await _queued_task(client, cid, human)
    q = (await client.post(f"/api/containers/{cid}/qa/sessions/queue", json={"actor_agent_id": human, "kind": "explore", "platform": "ios", "task_id": tid})).json()
    took = await _session(client, cid, people["bot"], task_id=tid)
    assert took["id"] == q["id"]
    await client.patch(f"/api/qa/sessions/{q['id']}", json={"actor_agent_id": human, "status": "cancelled"})
    tasks = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    assert next(t for t in tasks if t["id"] == tid)["status"] == "cancelled"


async def test_a_queued_drafting_keeps_what_it_reads(client, container, people):
    cid, human = container["id"], people["human"]
    tid = await _queued_task(client, cid, human)
    q = (await client.post(f"/api/containers/{cid}/qa/sessions/queue", json={"actor_agent_id": human, "kind": "draft", "platform": "ios", "task_id": tid, "draft_sources": "both"})).json()
    assert q["draft_sources"] == "both"
    tid2 = await _queued_task(client, cid, human)
    await client.post(f"/api/containers/{cid}/qa/sessions/queue", json={"actor_agent_id": human, "kind": "draft", "platform": "ios", "task_id": tid2})
    took = await _session(client, cid, people["bot"], kind="draft", task_id=tid2, draft_sources="exploration")
    assert took["draft_sources"] == "exploration"


async def test_a_person_changes_severity_and_the_agents_stays(client, container, people):
    sid = (await _session(client, container["id"], people["bot"]))["id"]
    f = await _finding(client, sid, people["bot"], lens="usable", fix_prompt="Wire the button")
    assert f["lens"] == "usable" and f["fix_prompt"] == "Wire the button"
    r = await client.patch(f"/api/qa/findings/{f['id']}/severity", json={"actor_agent_id": people["bot"], "severity": "major"})
    assert r.status_code == 403
    for sev in ("major", "blocker"):
        r = await client.patch(f"/api/qa/findings/{f['id']}/severity", json={"actor_agent_id": people["human"], "severity": sev, "reason": "It loses the form"})
        assert r.status_code == 200, r.text
    row = r.json()
    assert row["severity"] == "blocker" and row["severity_reported"] == "minor" and row["severity_by"] == "person" and row["severity_reason"] == "It loses the form"


async def test_a_finding_drafts_one_scenario(client, container, people):
    sid = (await _session(client, container["id"], people["bot"]))["id"]
    f = await _finding(client, sid, people["bot"])
    body = {"actor_agent_id": people["bot"], "name": "Saving keeps the form", "criteria": ["The form saves", "The saved values show"]}
    r = await client.post(f"/api/qa/findings/{f['id']}/scenario", json=body)
    assert r.status_code == 201, r.text
    first = r.json()
    assert first["created"] is True and first["scenario"]["status"] == "draft"
    r = await client.post(f"/api/qa/findings/{f['id']}/scenario", json={**body, "name": "Another"})
    assert r.json()["created"] is False and r.json()["scenario"]["id"] == first["scenario"]["id"]
    d = (await client.get(f"/api/qa/sessions/{sid}")).json()
    assert d["findings"][0]["scenario_id"] == first["scenario"]["id"]


async def test_measurements_are_kept_once_per_fingerprint(client, container, people):
    cid, bot = container["id"], people["bot"]
    sid = (await _session(client, cid, bot))["id"]
    row = {"fingerprint": "ab", "kind": "tap_target_too_small", "severity": "minor", "summary": "The Add button is 30x30", "measured": 30, "threshold": 44, "unit": "pt", "rect": [0, 0, 90, 90], "extra": {"side": "width"}, "screen_key": "HomeView", "step_seq": 3}
    r = await client.post(f"/api/qa/sessions/{sid}/measured", json={"actor_agent_id": bot, "rows": [row, row]})
    assert r.status_code == 201 and r.json()["added"] == 1, r.text
    r = await client.post(f"/api/qa/sessions/{sid}/measured", json={"actor_agent_id": bot, "rows": [row]})
    assert r.json()["added"] == 0
    d = (await client.get(f"/api/qa/sessions/{sid}")).json()
    got = d["measured"][0]
    assert got["rect"] == [0, 0, 90, 90] and got["extra"] == {"side": "width"} and got["confident"] is True
    digests = (await client.get(f"/api/containers/{cid}/qa/session-digests")).json()["digests"]
    assert len(digests[sid]["measured"]) == 1


async def test_charter_lens_is_checked(client, container, people):
    sid = (await _session(client, container["id"], people["bot"]))["id"]
    bad = [{"title": "A", "status": "active", "lens": "pretty"}]
    r = await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": people["bot"], "charter": bad})
    assert r.status_code == 400
    good = [{"title": "A", "status": "active", "lens": "usable", "journey_id": "j1"}]
    r = await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": people["bot"], "charter": good})
    assert r.status_code == 200 and r.json()["charter"][0]["lens"] == "usable" and r.json()["charter"][0]["journey_id"] == "j1"


async def test_the_app_model_versions_from_briefing_flows_and_walks(client, container, people):
    cid, bot = container["id"], people["bot"]
    r = await client.get(f"/api/containers/{cid}/qa/app-model", params={"platform": "ios"})
    assert r.status_code == 200 and r.json()["model"] is None and r.json()["versions"] == []
    sid = (await _session(client, cid, bot))["id"]
    await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": bot, "briefing": {"app_summary": "A baby log.", "personas": [{"name": "New parent", "goal": "Log feeds"}]}})
    r = await client.post(f"/api/containers/{cid}/qa/flows", json={"actor_agent_id": bot, "platform": "ios", "flows": [{"name": "Log a feed", "criticality": "high", "steps": [{"text": "Open Feeding"}, {"text": "Save"}]}]})
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/qa/sessions/{sid}/walks/next", json={"actor_agent_id": bot})
    wid = r.json()["walk"]["id"]
    await client.patch(f"/api/qa/walks/{wid}", json={"actor_agent_id": bot, "step": {"index": 0, "reached": True}})
    await client.patch(f"/api/qa/walks/{wid}", json={"actor_agent_id": bot, "step": {"index": 1, "reached": False}})
    r = await client.patch(f"/api/qa/walks/{wid}", json={"actor_agent_id": bot, "outcome": "failed", "reason": "Save does nothing"})
    assert r.status_code == 200, r.text
    r = (await client.get(f"/api/containers/{cid}/qa/app-model", params={"platform": "ios"})).json()
    assert r["version"] == 3 and [v["source"] for v in r["versions"]] == ["walks", "plan", "briefing"]
    m = r["model"]
    assert m["purpose"] == "A baby log." and m["personas"][0]["key"] == "new-parent"
    w = m["workflows"][0]
    assert w["status"] == "failed" and w["criticality"] == "high" and w["risk"]["never_walked"] is False and w["last_walk"]["reason"] == "Save does nothing"
    old = (await client.get(f"/api/containers/{cid}/qa/app-model", params={"platform": "ios", "version": 1})).json()
    assert old["version"] == 1 and old["model"]["workflows"] == []
    missing = await client.get(f"/api/containers/{cid}/qa/app-model", params={"platform": "ios", "version": 9})
    assert missing.status_code == 404


def test_the_audit_measures_a_screen():
    from types import SimpleNamespace as NS

    from orcha_cli.qa.audit import fingerprint, measure_screen

    def el(i, kind, label, x1, y1, x2, y2, identifier=""):
        return NS(index=i, type=kind, label=label, value="", identifier=identifier, x1=x1, y1=y1, x2=x2, y2=y2, enabled=True, traits=[], interactive=kind == "Button")

    shot = NS(elements=[el(0, "Button", "Add", 10, 100, 40, 130, "add"), el(1, "Button", "", 100, 100, 160, 160, "x"), el(2, "Button", "Far", 380, 200, 460, 260, "far")], png=None, size=(402, 874))
    rows = measure_screen(shot, target_kind="ios")
    kinds = {r["kind"] for r in rows}
    assert {"tap_target_too_small", "empty_label", "off_screen"} <= kinds
    tap = next(r for r in rows if r["kind"] == "tap_target_too_small")
    assert tap["threshold"] == 44 and tap["measured"] == 30
    assert fingerprint(tap, "Home") == fingerprint({**tap, "summary": "other words"}, "Home") != fingerprint(tap, "Other")
    assert measure_screen(NS(elements=[], png=None, size=(0, 0)), target_kind="ios") == []


def test_briefing_keeps_lens_and_journey():
    from test_qa_mcp import make, run

    tools, portal, _device, _ = make()
    run(tools.start_session("ios", "explore", minutes=0))
    bad = run(tools.submit_briefing({"charter": [{"title": "a", "lens": "pretty"}, {"title": "b"}, {"title": "c"}]}))
    assert bad.startswith("error: mission 1: lens")
    bad = run(tools.submit_briefing({"journeys": [{"name": "Buy"}], "charter": [{"title": "a", "journey_id": "j9"}, {"title": "b"}, {"title": "c"}]}))
    assert bad.startswith("error: mission 1: journey_id")
    run(tools.submit_briefing({"app_summary": "A log.", "journeys": [{"name": "Buy"}], "charter": [{"title": "a", "lens": "Usable", "journey_id": "j1", "feature": "feeds"}, {"title": "b"}, {"title": "c"}]}))
    sess = portal.sessions["sess-1"]
    assert sess["briefing"]["journeys"][0]["id"] == "j1"
    assert sess["charter"][0]["lens"] == "usable" and sess["charter"][0]["journey_id"] == "j1" and sess["charter"][0]["feature"] == "feeds"
    run(tools.charter_update("m1", "covered"))
    assert portal.sessions["sess-1"]["charter"][0]["step_seq"] >= 1


def test_each_screen_is_measured_once():
    from test_qa_mcp import make, run

    tools, portal, device, _ = make()
    run(tools.start_session("ios", "explore", minutes=0))
    assert isinstance(tools.live.measured_seen, set) and len(tools.live.measured_seen) == 1
    before = len(tools.live.measured_seen)
    run(tools.screen())
    assert len(tools.live.measured_seen) >= before
