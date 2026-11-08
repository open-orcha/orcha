"""Orcha QA portal: the run page's document, telemetry and feedback (qa_runs_routes.py)."""
import pytest
from conftest import run_task_id


@pytest.fixture
async def people(make_agent):
    human = await make_agent("Hussein", "owner", kind="human")
    bot = await make_agent("qa-bot")
    return {"human": human["agent_id"], "bot": bot["agent_id"]}


async def _session(client, cid, actor, kind="check", platform="web", device="desktop"):
    r = await client.post(f"/api/containers/{cid}/qa/sessions", json={
        "actor_agent_id": actor, "kind": kind, "platform": platform, "device_name": device, "app_id": "https://a.test",
        "task_id": await run_task_id(client, cid, actor)})
    assert r.status_code in (200, 201), r.text
    return r.json().get("id") or r.json()["session"]["id"]


async def _scenario(client, cid, actor, human, name="Sign in", platform="web"):
    r = await client.post(f"/api/containers/{cid}/qa/scenarios", json={
        "actor_agent_id": actor, "platform": platform, "name": name, "description": "Sign in works",
        "criteria": ["The form opens", "The home screen shows"]})
    assert r.status_code in (200, 201), r.text
    sid = r.json().get("id") or r.json()["scenario"]["id"]
    return sid


async def test_the_document_carries_steps_logs_scenarios_and_verdicts(client, container, people):
    cid = container["id"]
    sid = await _session(client, cid, people["bot"])
    scid = await _scenario(client, cid, people["bot"], people["human"])
    r = await client.post(f"/api/qa/sessions/{sid}/steps", json={"actor_agent_id": people["bot"], "steps": [
        {"seq": 1, "kind": "tap", "args": {"target": "e1"}, "result": "ok", "at": "2026-11-05T10:00:00.250Z"},
        {"seq": 2, "kind": "screen", "args": {"title": "Home"}, "result": ""}]})
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/qa/sessions/{sid}/telemetry", json={"actor_agent_id": people["bot"],
        "logs": [{"seq": 1, "step_seq": 1, "at_ms": 120, "level": "error", "source": "console", "text": "boom", "detail": {"count": 3}}],
        "requests": [{"seq": 1, "step_seq": 1, "at_ms": 100, "kind": "xhr", "method": "POST", "url": "https://a.test/api", "status": 500, "duration_ms": 80}]})
    assert r.json() == {"logs": 1, "requests": 1}
    r = await client.post(f"/api/qa/sessions/{sid}/verdicts", json={"actor_agent_id": people["bot"], "scenario_id": scid, "criterion_index": 0, "verdict": "pass"})
    assert r.status_code in (200, 201), r.text

    doc = (await client.get(f"/api/qa/sessions/{sid}/run")).json()
    assert [s["seq"] for s in doc["steps"]] == [1, 2]
    assert doc["logs"][0]["detail"] == {"count": 3}
    assert doc["verdicts"][0]["verdict"] == "pass"
    assert [s["id"] for s in doc["scenarios"]] == [scid]
    assert doc["scenarios"][0]["criteria"] == ["The form opens", "The home screen shows"]
    assert doc["session"]["id"] == sid


async def test_a_batch_is_idempotent_on_seq(client, container, people):
    sid = await _session(client, container["id"], people["bot"])
    body = {"actor_agent_id": people["bot"], "logs": [{"seq": 1, "text": "one"}], "requests": []}
    assert (await client.post(f"/api/qa/sessions/{sid}/telemetry", json=body)).json()["logs"] == 1
    body["logs"][0]["text"] = "changed"
    assert (await client.post(f"/api/qa/sessions/{sid}/telemetry", json=body)).json()["logs"] == 0
    logs = (await client.get(f"/api/qa/sessions/{sid}/logs")).json()["logs"]
    assert [x["text"] for x in logs] == ["one"]


async def test_logs_and_requests_read_past_a_seq(client, container, people):
    sid = await _session(client, container["id"], people["bot"])
    await client.post(f"/api/qa/sessions/{sid}/telemetry", json={"actor_agent_id": people["bot"],
        "logs": [{"seq": n, "text": f"l{n}"} for n in (1, 2, 3)],
        "requests": [{"seq": n, "method": "GET", "url": f"https://a.test/{n}"} for n in (1, 2)]})
    assert [x["seq"] for x in (await client.get(f"/api/qa/sessions/{sid}/logs?after_seq=2")).json()["logs"]] == [3]
    assert [x["seq"] for x in (await client.get(f"/api/qa/sessions/{sid}/requests?after_seq=1")).json()["requests"]] == [2]


async def test_only_a_person_answers_a_verdict(client, container, people):
    sid = await _session(client, container["id"], people["bot"])
    scid = await _scenario(client, container["id"], people["bot"], people["human"])
    body = {"scenario_id": scid, "criterion_index": 0, "status": "acknowledged"}
    r = await client.put(f"/api/qa/sessions/{sid}/feedback", json={**body, "actor_agent_id": people["bot"]})
    assert r.status_code == 403
    r = await client.put(f"/api/qa/sessions/{sid}/feedback", json={**body, "actor_agent_id": people["human"]})
    assert r.status_code == 200, r.text
    r = await client.put(f"/api/qa/sessions/{sid}/feedback", json={**body, "status": "not_a_bug", "actor_agent_id": people["human"]})
    assert r.status_code == 400
    r = await client.put(f"/api/qa/sessions/{sid}/feedback", json={**body, "status": "resolved", "actor_agent_id": people["human"]})
    assert r.status_code == 200
    doc = (await client.get(f"/api/qa/sessions/{sid}/run")).json()
    assert [f["status"] for f in doc["feedback"]] == ["resolved"]


async def test_the_live_wall_lists_what_runs_with_its_latest_frame_step(client, container, people):
    sid = await _session(client, container["id"], people["bot"], kind="explore")
    await client.post(f"/api/qa/sessions/{sid}/steps", json={"actor_agent_id": people["bot"], "steps": [
        {"seq": 1, "kind": "tap", "args": {}, "result": "ok"}]})
    tiles = (await client.get(f"/api/containers/{container["id"]}/qa/live?platform=web")).json()["tiles"]
    assert [t["session"]["id"] for t in tiles] == [sid]
    assert tiles[0]["steps_count"] == 1 and tiles[0]["last_step"]["kind"] == "tap"
    assert (await client.get(f"/api/containers/{container["id"]}/qa/live?platform=ios")).json()["tiles"] == []


async def test_perf_reads_the_timed_steps_against_the_screens_earlier_sessions(client, container, people):
    bot = people["bot"]
    cid = container["id"]

    async def timed(appear):
        sid = await _session(client, cid, bot, kind="explore")
        r = await client.post(f"/api/qa/sessions/{sid}/steps", json={"actor_agent_id": bot, "steps": [
            {"seq": 1, "kind": "tap", "args": {}, "result": "ok", "duration_ms": appear + 200,
             "timing": {"settled": "changed", "settle_ms": appear + 200, "appear_ms": appear}},
            {"seq": 2, "kind": "screen", "args": {"title": "Home"}, "result": "", "screen_key": "Home"}]})
        assert r.status_code == 200, r.text
        return sid

    first = await timed(100)
    second = await timed(900)
    doc = (await client.get(f"/api/qa/sessions/{second}/perf")).json()
    assert {x["metric"] for x in doc["samples"]} == {"appear", "settle"}
    assert all(x["run_id"] == second for x in doc["samples"])
    assert doc["steps"][0]["timing"]["appear_ms"] == 900
    assert {x["run_id"] for x in doc["history"]} == {first}
    assert doc["settings"]["regression_pct"] == 50
    assert (await client.get(f"/api/qa/sessions/{first}/perf")).json()["history"] == []


async def test_a_check_of_picked_scenarios_counts_only_those(client, container, people):
    cid, human = container["id"], people["human"]
    picked = await _scenario(client, cid, people["bot"], human, name="Picked")
    other = await _scenario(client, cid, people["bot"], human, name="Other")
    r = await client.post(f"/api/containers/{cid}/qa/scenarios/status", json={"actor_agent_id": human, "ids": [picked, other], "status": "validated"})
    assert r.status_code == 200, r.text
    t = await client.post(f"/api/containers/{cid}/tasks", json={"title": "Check", "definition_of_done": "Checked.", "created_by_agent_id": human,
                                                                "description": f"Run /orcha-qa-check for this task on web --scenario {picked}"})
    tid = t.json()["task_id"]
    s = await client.post(f"/api/containers/{cid}/qa/sessions", json={"actor_agent_id": people["bot"], "kind": "check", "platform": "web", "task_id": tid})
    doc = (await client.get(f"/api/qa/sessions/{s.json()['id']}/run")).json()
    assert [x["name"] for x in doc["scenarios"]] == ["Picked"]
    whole = await _session(client, cid, people["bot"])  # no pick: the whole approved suite
    doc = (await client.get(f"/api/qa/sessions/{whole}/run")).json()
    assert sorted(x["name"] for x in doc["scenarios"]) == ["Other", "Picked"]
