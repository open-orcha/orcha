"""Triage on its own: the diagnoses, the memory and automatic triage."""

import pytest

from portal_backend import qa_handoff
from test_qa_handoff import end, hand, session, task, team  # noqa: F401 (fixture)


@pytest.fixture(autouse=True)
def inline(monkeypatch):
    monkeypatch.setattr(qa_handoff, "BACKGROUND", False)


async def finding(team, sid, severity="major", title="Broken"):
    r = await team["client"].post(f"/api/qa/sessions/{sid}/findings", json={"actor_agent_id": team["qa"], "severity": severity, "title": title})
    assert r.status_code == 201, r.text
    return r.json()


async def diagnose(team, fid, expect=200, **body):
    r = await team["client"].post(f"/api/qa/findings/{fid}/triage", json={"actor_agent_id": team["qa"], **body})
    assert r.status_code == expect, r.text
    return r.json()


async def setup(team, kind="explore"):
    out = await hand(team, await task(team))
    return out, await session(team, out["request"], kind)


async def test_not_a_bug_is_a_persons_call_and_list_of_memory_keeps_it(team, db):
    _, s = await setup(team)
    f = await finding(team, s["id"], title="The dot blinks")
    r = await team["client"].post(f"/api/qa/findings/{f['id']}/not-a-bug", json={"actor_agent_id": team["dev"], "reason": "x"})
    assert r.status_code == 403
    r = await team["client"].post(f"/api/qa/findings/{f['id']}/not-a-bug", json={"actor_agent_id": team["human"], "reason": "It is the design."})
    assert r.status_code == 200 and r.json()["status"] == "dismissed"
    memory = (await team["client"].get(f"/api/containers/{team['cid']}/qa/memory")).json()["memory"]
    assert memory[0]["kind"] == "not_a_bug" and "The dot blinks" in memory[0]["text"] and "the design" in memory[0]["text"]


async def test_each_diagnosis_does_its_own_thing(team, db):
    out, s = await setup(team)
    first, second, third = await finding(team, s["id"], title="A"), await finding(team, s["id"], title="B"), await finding(team, s["id"], title="C")
    assert (await diagnose(team, first["id"], classification="agent_error", note="It misread"))["status"] == "dismissed"
    merged = await diagnose(team, second["id"], classification="duplicate", duplicate_of=third["id"])
    assert merged["status"] == "dismissed" and merged["duplicate_of"] == third["id"]
    assert db.execute("SELECT triage FROM qa_findings WHERE id=%s", (third["id"],))[0]["triage"]["merged_from"] == [second["id"]]
    await diagnose(team, third["id"], 400, classification="flaky", attempts=3, reproductions=3)  # that is every attempt
    await diagnose(team, third["id"], 400, classification="product_bug", attempts=3, reproductions=0)
    done_env = await diagnose(team, third["id"], classification="environment", root_cause="The sandbox has no card")
    assert done_env["action"] == "blocked"
    inbox = (await team["client"].get(f"/api/containers/{team['cid']}/qa/triage")).json()
    assert [f["id"] for f in inbox["needs_person"]] == [third["id"]]


async def test_a_test_issue_suggests_and_never_edits_a_validated_scenario(team, db):
    out, s = await setup(team)
    sc = (await team["client"].post(f"/api/containers/{team['cid']}/qa/scenarios", json={
        "actor_agent_id": team["qa"], "platform": "web", "name": "Pay", "criteria": ["It pays", "A receipt"]})).json()["scenario"]
    await team["client"].post(f"/api/containers/{team['cid']}/qa/scenarios/status", json={"actor_agent_id": team["human"], "ids": [sc["id"]], "status": "validated"})
    f = await finding(team, s["id"])
    got = await diagnose(team, f["id"], classification="test_issue", attempts=3, reproductions=3, root_cause="The check names an old label", scenario_id=sc["id"])
    assert got["action"] == "suggested"
    rows = db.execute("SELECT reason, status FROM qa_scenario_suggestions WHERE scenario_id=%s", (sc["id"],))
    assert rows[0]["status"] == "proposal" and "old label" in rows[0]["reason"]
    assert db.execute("SELECT criteria, status FROM qa_scenarios WHERE id=%s", (sc["id"],))[0]["status"] == "validated"


async def test_a_triaged_away_major_no_longer_fails_the_gate(team, db):
    out, s = await setup(team)
    f = await finding(team, s["id"])
    await diagnose(team, f["id"], classification="agent_error", note="Wrong screen")
    await end(team, s["id"])
    assert (await team["client"].get(f"/api/qa/requests/{out['request']['id']}")).json()["status"] == "passed"


async def test_auto_triage_is_off_by_default_and_capped_when_on(team, db):
    await team["client"].put(f"/api/containers/{team['cid']}/qa/settings", json={
        "actor_agent_id": team["human"], "auto_triage": "critical", "max_per_run": 1})
    out, s = await setup(team)
    await finding(team, s["id"], "major", "One")
    await finding(team, s["id"], "major", "Two")
    await finding(team, s["id"], "minor", "Three")
    await end(team, s["id"])
    rows = db.execute("SELECT finding_ids, origin, approved_by_agent_id FROM qa_requests WHERE kind='triage'")
    assert len(rows) == 1 and rows[0]["origin"] == "auto_triage" and len(rows[0]["finding_ids"]) == 1 and rows[0]["approved_by_agent_id"] is None


async def test_a_finding_can_go_to_triage_from_a_click(team, db):
    _, s = await setup(team)
    f = await finding(team, s["id"])
    r = await team["client"].post(f"/api/qa/findings/{f['id']}/triage-request", json={"actor_agent_id": team["human"]})
    assert r.status_code == 201, r.text
    body = db.execute("SELECT description FROM tasks WHERE id=%s", (r.json()["qa_task_id"],))[0]["description"]
    assert "/orcha-qa-triage" in body and f["id"] in body and "That is the approval of your plan" in body


async def test_a_finding_filed_as_a_task_leaves_untriaged_and_names_its_platform(team, db):
    _out, s = await setup(team)
    f, other = await finding(team, s["id"], title="Filed"), await finding(team, s["id"], title="Waiting")
    r = await team["client"].patch(f"/api/qa/findings/{f['id']}", json={"actor_agent_id": team["human"], "action": "file"})
    assert r.status_code == 200, r.text
    inbox = (await team["client"].get(f"/api/containers/{team['cid']}/qa/triage")).json()
    assert [x["id"] for x in inbox["untriaged"]] == [other["id"]] and inbox["untriaged"][0]["platform"] == s["platform"]
    assert f["id"] in [x["id"] for x in inbox["decided"]]
