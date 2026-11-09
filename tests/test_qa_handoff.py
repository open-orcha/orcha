"""The QA handoff, on the real portal: a request from an agent or a person, the rollup, the return
path, the reopen loop, and a person's click as the plan's approval. A QA result never verifies a task."""

import json

import pytest

from portal_backend import qa_handoff, sql


@pytest.fixture(autouse=True)
def inline(monkeypatch):
    monkeypatch.setattr(qa_handoff, "BACKGROUND", False)


@pytest.fixture
async def team(client, container, make_agent, work_headers):
    cid = container["id"]
    human = (await make_agent("Hussein", kind="human"))["agent_id"]
    dev = (await make_agent("Dev"))["agent_id"]
    qa = (await make_agent("QAEngineer", "QA engineer"))["agent_id"]
    return {"cid": cid, "human": human, "dev": dev, "qa": qa, "client": client, "lane": work_headers}


async def task(team, title="Add checkout", dod="- The total shows the discount\n- The receipt is emailed", assignee="Dev"):
    r = await team["client"].post(f"/api/containers/{team['cid']}/tasks", json={
        "title": title, "description": "d", "definition_of_done": dod, "created_by_agent_id": team["human"], "assignee_alias": assignee})
    assert r.status_code == 201, r.text
    return r.json()["task_id"]


async def done(team, tid, agent, result="Done"):
    r = await team["client"].post(f"/api/tasks/{tid}/done", json={"agent_id": agent, "result": result}, headers=await team["lane"](agent))
    assert r.status_code == 200, r.text
    return r.json()


async def hand(team, tid, actor=None, **body):
    r = await team["client"].post(f"/api/tasks/{tid}/qa/requests", json={"actor_agent_id": actor or team["dev"], "platform": "web", **body})
    assert r.status_code == 201, r.text
    return r.json()


async def session(team, req, kind="check"):
    r = await team["client"].post(f"/api/containers/{team['cid']}/qa/sessions", json={
        "actor_agent_id": team["qa"], "kind": kind, "platform": "web", "request_id": req["id"]})
    assert r.status_code == 201, r.text
    return r.json()


async def line(team, sid, index, verdict, note=None):
    r = await team["client"].post(f"/api/qa/sessions/{sid}/verdicts", json={
        "actor_agent_id": team["qa"], "acceptance_line": index, "verdict": verdict, "note": note})
    assert r.status_code == 201, r.text


async def end(team, sid):
    r = await team["client"].patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": team["qa"], "status": "done"})
    assert r.status_code == 200, r.text


async def request_row(team, rid):
    return (await team["client"].get(f"/api/qa/requests/{rid}")).json()


async def status_of(db, tid):
    return db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]["status"]


async def test_an_agent_hands_off_and_a_linked_task_goes_to_the_qa_agent(team, db):
    tid = await task(team)
    out = await hand(team, tid, focus="The discount", build={"branch": "feat/x", "commit": "abc1234"})
    req, qa_task = out["request"], out["qa_task_id"]
    assert req["status"] == "requested" and req["source_task_id"] == tid and req["source_agent_alias"] == "Dev"
    assert req["acceptance"] == ["The total shows the discount", "The receipt is emailed"]
    row = db.execute("SELECT description FROM tasks WHERE id=%s", (qa_task,))[0]
    assert "/orcha-qa-explore" in row["description"] and req["id"] in row["description"] and "feat/x" in row["description"]
    assert "started this run" not in row["description"]  # an agent's request follows the project's rule
    assert not db.execute("SELECT 1 FROM task_approval_records WHERE task_id=%s", (qa_task,))
    assert db.execute("SELECT a.alias FROM agent_tasks t JOIN agents a ON a.id=t.agent_id WHERE t.task_id=%s", (qa_task,))[0]["alias"] == "QAEngineer"
    again = await team["client"].post(f"/api/tasks/{tid}/qa/requests", json={"actor_agent_id": team["dev"], "platform": "web"})
    assert again.status_code == 409


async def test_a_persons_send_to_qa_approves_the_plan_and_only_the_plan(team, db):
    tid = await task(team)
    out = await hand(team, tid, actor=team["human"])
    qa_task = out["qa_task_id"]
    assert out["request"]["approved_by_alias"] == "Hussein"
    row = db.execute("SELECT description, autonomy FROM tasks WHERE id=%s", (qa_task,))[0]
    assert "That is the approval of your plan" in row["description"] and row["autonomy"] == "off"
    approvals = db.execute("SELECT phase, actor_kind, permission_source FROM task_approval_records WHERE task_id=%s", (qa_task,))
    assert [(a["phase"], a["actor_kind"]) for a in approvals] == [("plan", "human")]
    assert db.execute("SELECT decision FROM decisions WHERE subject_type='plan_approval' AND subject_id=%s", (qa_task,))[0]["decision"] == "approve"
    await done(team, qa_task, team["qa"])
    assert await status_of(db, qa_task) == "needs_verification"  # the finished work still waits for a person


async def test_the_rollup_and_the_return_path(team, db):
    tid = await task(team)
    await done(team, tid, team["dev"])
    out = await hand(team, tid, on_fail="report")
    s = await session(team, out["request"])
    assert (await request_row(team, out["request"]["id"]))["status"] == "running"
    await line(team, s["id"], 0, "pass", "The total drops by 10%")
    await line(team, s["id"], 1, "pass")
    await end(team, s["id"])
    req = await request_row(team, out["request"]["id"])
    assert req["status"] == "passed" and [l["verdict"] for l in req["result"]["lines"]] == ["pass", "pass"]
    thread = db.execute("SELECT body FROM task_messages WHERE task_id=%s ORDER BY created_at", (tid,))
    assert "[QA result" in thread[-1]["body"] and "A person still verifies" in thread[-1]["body"]
    woken = db.execute("SELECT payload FROM agent_events WHERE event_key=%s AND event_name='task_message'", (team["dev"],))
    assert woken and "QA" in woken[-1]["payload"]["preview"]
    told = db.execute("SELECT payload FROM agent_events WHERE event_key=%s AND event_name='qa_result'", (team["human"],))
    assert told and told[-1]["payload"]["status"] == "passed"
    assert db.execute("SELECT 1 FROM events WHERE event_type='qa_request_finished' AND entity_id=%s", (out["request"]["id"],))
    feed = (await team["client"].get(f"/api/agents/{team['human']}/notifications")).json()["notifications"]
    assert any(n["event_name"] == "qa_result" for n in feed)
    from portal_backend import notification_prefs as np
    assert np.category_for("qa_result") == "qa"


async def test_a_pass_never_completes_or_verifies_a_task(team, db):
    tid = await task(team)
    await done(team, tid, team["dev"])
    out = await hand(team, tid)
    s = await session(team, out["request"])
    await line(team, s["id"], 0, "pass")
    await line(team, s["id"], 1, "pass")
    await end(team, s["id"])
    await done(team, out["qa_task_id"], team["qa"])
    assert await status_of(db, tid) == "needs_verification"
    assert await status_of(db, out["qa_task_id"]) == "needs_verification"
    assert not db.execute("SELECT 1 FROM events WHERE event_type='verified' AND entity_id=%s", (tid,))
    assert not db.execute("SELECT 1 FROM task_approval_records WHERE task_id=%s AND phase='completion'", (tid,))


async def test_a_failed_line_is_proof_in_the_evidence_pack_with_its_screenshot(team, db):
    tid = await task(team)
    await done(team, tid, team["dev"])
    out = await hand(team, tid)
    s = await session(team, out["request"])
    await line(team, s["id"], 0, "pass", "The total drops by 10%")
    await line(team, s["id"], 1, "fail", "No email arrived")
    await end(team, s["id"])
    pack = (await team["client"].get(f"/api/tasks/{tid}/evidence")).json()
    items = {i["text"]: i for i in pack["dod"]["items"]}
    assert items["The total shows the discount"]["status"] == "proven" and items["The total shows the discount"]["basis"] == "qa"
    assert items["The receipt is emailed"]["status"] == "not_proven"
    assert pack["qa"][0]["status"] == "failed"


async def test_on_fail_reopen_loops_until_the_rounds_run_out(team, db):
    await team["client"].put(f"/api/containers/{team['cid']}/qa/settings", json={"actor_agent_id": team["human"], "max_rounds": 2})
    tid = await task(team)
    await done(team, tid, team["dev"])
    first = await hand(team, tid, on_fail="reopen", actor=team["human"])
    s = await session(team, first["request"])
    await line(team, s["id"], 0, "fail", "The total is wrong")
    await end(team, s["id"])
    assert await status_of(db, tid) == "in_progress"  # back with its agent, the findings on the thread
    assert "back with you" in db.execute("SELECT body FROM task_messages WHERE task_id=%s ORDER BY created_at DESC LIMIT 1", (tid,))[0]["body"]
    assert not db.execute("SELECT 1 FROM events WHERE event_type='verified' AND entity_id=%s", (tid,))
    await done(team, tid, team["dev"], "Fixed")
    rows = (await team["client"].get(f"/api/containers/{team['cid']}/qa/requests", params={"source_task_id": tid})).json()["requests"]
    assert [r["round"] for r in rows] == [2, 1] and rows[0]["origin"] == "reopen" and rows[0]["approved_by_alias"] == "Hussein"
    s = await session(team, rows[0])
    await line(team, s["id"], 0, "fail", "Still wrong")
    await end(team, s["id"])
    last = await request_row(team, rows[0]["id"])
    assert last["result"]["rounds_exhausted"] and await status_of(db, tid) == "needs_verification"
    assert [r["round"] for r in last["rounds"]] == [1, 2]


async def test_the_trigger_starts_qa_when_a_task_finishes(team, db):
    await team["client"].put(f"/api/containers/{team['cid']}/qa/settings", json={"actor_agent_id": team["human"], "trigger": "always"})
    tid = await task(team)
    await done(team, tid, team["dev"])
    rows = db.execute("SELECT origin, qa_task_id FROM qa_requests WHERE source_task_id=%s", (tid,))
    assert [r["origin"] for r in rows] == ["trigger"]
    await done(team, str(rows[0]["qa_task_id"]), team["qa"])  # QA work never starts more QA
    assert len(db.execute("SELECT 1 FROM qa_requests")) == 1


async def test_ui_changes_reads_the_diff(team, db):
    await team["client"].put(f"/api/containers/{team['cid']}/qa/settings", json={"actor_agent_id": team["human"], "trigger": "ui_changes"})
    plain = await task(team, "Backend only")
    await done(team, plain, team["dev"])
    assert not db.execute("SELECT 1 FROM qa_requests")
    screen = await task(team, "A new screen")
    rid = "11111111-2222-4333-8444-555555555555"
    db.execute("INSERT INTO worker_runs (run_id, agent_id, task_id, status, ended_at, diff) VALUES (%s,%s,%s,'exited',%s,%s)",
               (rid, team["dev"], screen, sql.utcnow(), "diff --git a/src/pages/Cart.tsx b/src/pages/Cart.tsx\n--- a/src/pages/Cart.tsx\n+++ b/src/pages/Cart.tsx\n@@ -1 +1 @@\n-a\n+b\n"))
    db.execute("INSERT INTO worker_run_tasks (run_id, task_id) VALUES (%s,%s) ON CONFLICT DO NOTHING", (rid, screen))
    await done(team, screen, team["dev"])
    assert db.execute("SELECT origin FROM qa_requests WHERE source_task_id=%s", (screen,))[0]["origin"] == "trigger"


async def test_the_work_task_shows_the_run_and_findings_of_its_qa_task(team):
    tid = await task(team)
    out = await hand(team, tid)
    s = await session(team, out["request"], "explore")
    await team["client"].post(f"/api/qa/sessions/{s['id']}/findings", json={
        "actor_agent_id": team["qa"], "severity": "major", "title": "Total is wrong", "expected": "The total drops"})
    await line(team, s["id"], 0, "pass")
    for at in (tid, out["qa_task_id"]):
        qa = (await team["client"].get(f"/api/tasks/{at}/qa")).json()
        assert [x["id"] for x in qa["sessions"]] == [s["id"]]
        assert [f["title"] for f in qa["findings"]] == ["Total is wrong"]
    assert (await team["client"].get(f"/api/tasks/{tid}/qa")).json()["is_run_task"] is False


async def test_a_filed_findings_task_finishing_triggers_a_recheck(team, db):
    tid = await task(team)
    out = await hand(team, tid)
    s = await session(team, out["request"], "explore")
    f = (await team["client"].post(f"/api/qa/sessions/{s['id']}/findings", json={
        "actor_agent_id": team["qa"], "severity": "major", "title": "Total is wrong", "expected": "The total drops"})).json()
    filed = (await team["client"].patch(f"/api/qa/findings/{f['id']}", json={
        "actor_agent_id": team["human"], "action": "file", "assignee_agent_id": team["dev"]})).json()
    await done(team, filed["task"]["task_id"], team["dev"])
    row = db.execute("SELECT origin, source_finding_id, acceptance FROM qa_requests WHERE source_task_id=%s", (filed["task"]["task_id"],))[0]
    assert row["origin"] == "recheck" and str(row["source_finding_id"]) == f["id"]
    assert "The total drops" in json.dumps(row["acceptance"])


async def test_cancelling_a_request_cancels_its_task(team, db):
    tid = await task(team)
    out = await hand(team, tid)
    r = await team["client"].post(f"/api/qa/requests/{out['request']['id']}/cancel", json={"actor_agent_id": team["human"]})
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    assert await status_of(db, out["qa_task_id"]) == "cancelled"


async def test_settings_are_a_persons(team):
    r = await team["client"].put(f"/api/containers/{team['cid']}/qa/settings", json={"actor_agent_id": team["dev"], "trigger": "always"})
    assert r.status_code == 403
    got = (await team["client"].get(f"/api/containers/{team['cid']}/qa/settings")).json()
    assert got["agent_alias"] == "QAEngineer" and got["agent_source"] == "role" and got["auto_triage"] == "off"


async def test_no_pydantic_name_collides_in_the_spec():
    import main

    spec = main.app.openapi()
    assert not [k for k in spec["components"]["schemas"] if k.startswith("portal_backend__")]
    assert "/api/qa/requests/{rid}" in spec["paths"]
