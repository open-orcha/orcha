"""Run conditions: validated, merged key by key, stored on scenarios, findings, requests and
sessions, carried into a reproduction and into what the worker is told."""

import pytest
from pydantic import ValidationError

from portal_backend import qa_conditions as qc
from test_qa_handoff import hand, inline, request_row, session, task, team  # noqa: F401

ANDROID = {"os": "13", "locale": "sw-KE", "text_size": "large", "account": "An account with an active subscription"}


def test_the_contract_and_its_words():
    with pytest.raises(ValidationError):
        qc.Conditions.model_validate({"os": "13", "battery": "low"})
    with pytest.raises(ValidationError):
        qc.Conditions.model_validate({"text_size": "huge"})
    assert qc.clean({"os": " ", "locale": "sw-KE", "network": None}) == {"locale": "sw-KE"}
    assert qc.clean({}) is None and qc.clean(None) is None
    assert qc.merge({"os": "13", "locale": "en-US"}, {"locale": "sw-KE", "os": None}) == {"os": "13", "locale": "sw-KE"}
    assert qc.words(ANDROID, "android") == ["Android 13", "Swahili (Kenya)", "Text: Large", "Account: An account with an active subscription"]
    assert qc.words({"os": "iOS 18.2", "network": "slow", "appearance": "dark"}, "ios") == ["iOS 18.2", "Dark", "Slow network"]
    assert qc.locale_words("xx-YY") == "xx-YY"


def test_what_orcha_sets_itself():
    assert qc.native("android") == {"os", "locale", "text_size", "appearance", "network"}
    assert qc.native("android", physical=True) == {"os", "locale", "text_size", "appearance"}
    assert qc.native("ios") == {"os", "locale", "text_size", "appearance"}
    assert qc.native("ios", physical=True) == {"os", "locale"}
    assert qc.native("web") == {"locale", "text_size", "appearance", "timezone", "network"}
    assert "account" not in qc.native("web") and "setup" not in qc.native("android")


def test_the_worker_line():
    from orcha_cli import notifier_protocol

    lines = notifier_protocol._qa_step_lines({"skill": "/orcha-qa-check", "conditions": {"os": "13", "locale": "sw-KE"}})
    assert 'Conditions: pass conditions={"os":"13","locale":"sw-KE"} to start_session. A person asked for them.' in lines
    assert qc.prompt_line(None) is None


async def test_a_request_carries_its_conditions_to_the_session_and_the_quality_task(team, db):  # noqa: F811
    tid = await task(team)
    out = await hand(team, tid, actor=team["human"], conditions={**ANDROID, "network": "offline"})
    req = await request_row(team, out["request"]["id"])
    assert req["conditions"] == {**ANDROID, "network": "offline"}
    text = db.execute("SELECT description FROM tasks WHERE id=%s", (out["qa_task_id"],))[0]["description"]
    assert "Run it under these conditions: 13; Swahili (Kenya); Text: Large; Offline; Account: An account with an active subscription." in text
    assert "pass conditions=" in text
    s = await session(team, req)
    assert s["conditions"] == {**ANDROID, "network": "offline"}  # none asked: the request's own


async def test_a_scenario_keeps_conditions_and_a_finding_inherits_its_runs(team):  # noqa: F811
    c, cid = team["client"], team["cid"]
    r = await c.post(f"/api/containers/{cid}/qa/scenarios", json={
        "actor_agent_id": team["qa"], "platform": "android", "name": "Play a show", "criteria": ["It plays", "Subtitles show"],
        "conditions": {"os": "13", "account": "Premium subscriber"}})
    assert r.status_code == 200, r.text
    sc = r.json()["scenario"]
    assert sc["conditions"] == {"os": "13", "account": "Premium subscriber"}
    r = await c.patch(f"/api/qa/scenarios/{sc['id']}", json={"actor_agent_id": team["human"], "conditions": {"os": "14", "text_size": "largest"}})
    assert r.status_code == 200, r.text
    assert (await c.get(f"/api/qa/scenarios/{sc['id']}")).json()["conditions"] == {"os": "14", "text_size": "largest"}

    tid = await task(team, title="Run it")
    sid = (await c.post(f"/api/containers/{cid}/qa/sessions", json={
        "actor_agent_id": team["qa"], "kind": "explore", "platform": "android", "task_id": tid, "conditions": {"locale": "fr-FR"}})).json()["id"]
    f = (await c.post(f"/api/qa/sessions/{sid}/findings", json={"actor_agent_id": team["qa"], "severity": "major", "title": "Subtitles missing"})).json()
    assert f["conditions"] == {"locale": "fr-FR"}  # found under them: reproducing needs them

    r = await c.put(f"/api/qa/findings/{f['id']}/conditions", json={"actor_agent_id": team["qa"], "conditions": {"os": "13"}})
    assert r.status_code == 403
    r = await c.put(f"/api/qa/findings/{f['id']}/conditions", json={"actor_agent_id": team["human"], "conditions": {"os": "13", "locale": "sw-KE"}})
    assert r.status_code == 200 and r.json()["conditions"] == {"os": "13", "locale": "sw-KE"}

    out = (await c.post(f"/api/qa/findings/{f['id']}/triage-request", json={"actor_agent_id": team["human"], "conditions": {"text_size": "large"}})).json()
    assert (await request_row(team, out["request"]["id"]))["conditions"] == {"os": "13", "locale": "sw-KE", "text_size": "large"}


async def test_send_to_quality_when_finished_keeps_its_conditions(team):  # noqa: F811
    tid = await task(team)
    r = await team["client"].put(f"/api/tasks/{tid}/qa/on-done", json={
        "actor_agent_id": team["human"], "enabled": True, "platform": "web", "conditions": {"locale": "sw-KE", "timezone": "Africa/Nairobi"}})
    assert r.status_code == 200, r.text
    assert r.json()["on_done"]["conditions"] == {"locale": "sw-KE", "timezone": "Africa/Nairobi"}


async def test_a_report_says_the_conditions_and_a_draft_from_it_keeps_them(team, db):  # noqa: F811
    c, cid = team["client"], team["cid"]
    tid = await task(team, title="Check it")
    sid = (await c.post(f"/api/containers/{cid}/qa/sessions", json={
        "actor_agent_id": team["qa"], "kind": "check", "platform": "android", "task_id": tid, "conditions": {"os": "13", "locale": "sw-KE"}})).json()["id"]
    sc = (await c.post(f"/api/containers/{cid}/qa/scenarios", json={
        "actor_agent_id": team["qa"], "platform": "android", "name": "Play a show", "session_id": sid, "criteria": ["It plays", "Subtitles show"],
        "conditions": {"account": "Premium subscriber"}})).json()["scenario"]
    await c.post(f"/api/qa/sessions/{sid}/verdicts", json={"actor_agent_id": team["qa"], "scenario_id": sc["id"], "criterion_index": 0, "verdict": "fail"})
    md = (await c.get(f"/api/tasks/{tid}/qa/report.md")).text
    assert "- Conditions: Android 13; Swahili (Kenya)" in md
    assert "Play a show (Account: Premium subscriber)" in md
    data = md.split("```orcha-quality-report\n", 1)[1].split("\n```", 1)[0]
    data = data.replace(sc["id"], "00000000-0000-4000-8000-000000000002").replace("Play a show", "Play a film")
    report = (await c.post(f"/api/containers/{cid}/qa/reports", params={"actor_agent_id": team["human"]},
                           content=("```orcha-quality-report\n" + data + "\n```\n").encode())).json()
    assert report["data"]["runs"][0]["conditions"] == {"os": "13", "locale": "sw-KE"}
    made = (await c.post(f"/api/qa/reports/{report['id']}/drafts", json={"actor_agent_id": team["human"]})).json()["created"]
    assert (await c.get(f"/api/qa/scenarios/{made[0]}")).json()["conditions"] == {"account": "Premium subscriber"}
