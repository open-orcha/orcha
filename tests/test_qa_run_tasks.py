"""Every run is a task, and who has the final say: over HTTP, with real requests, sessions, evidence
packs and workflow steps. By default a result is written and the task stops for a person."""

import json

import pytest

from portal_backend import qa_handoff, qa_run_tasks
from test_qa_handoff_workflow import accept, build, done as step_done, end, evidence_dir, line, preset, request_of  # noqa: F401
from test_qa_handoff_workflow import session as step_session, step, turn
from test_workflow_local_launch import Project
from test_workflow_review_handoff import stopped


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


DOD = "- The total shows the discount\n- The receipt is emailed"


async def task(team, title="Add checkout", dod=DOD, assignee="Dev", **extra):
    r = await team["client"].post(f"/api/containers/{team['cid']}/tasks", json={
        "title": title, "description": "d", "definition_of_done": dod, "created_by_agent_id": team["human"], "assignee_alias": assignee, **extra})
    assert r.status_code == 201, r.text
    return r.json()["task_id"]


async def done(team, tid, agent, result="Done"):
    r = await team["client"].post(f"/api/tasks/{tid}/done", json={"agent_id": agent, "result": result}, headers=await team["lane"](agent))
    assert r.status_code == 200, r.text
    return r.json()


async def hand(team, tid, **body):
    r = await team["client"].post(f"/api/tasks/{tid}/qa/requests", json={"actor_agent_id": team["human"], "platform": "web", "kind": "explore", **body})
    assert r.status_code == 201, r.text
    return r.json()


async def session(team, agent=None, **body):
    r = await team["client"].post(f"/api/containers/{team['cid']}/qa/sessions", json={
        "actor_agent_id": agent or team["qa"], "kind": "explore", "platform": "web", **body})
    assert r.status_code == 201, r.text
    return r.json()


async def verdict(team, s, index, value="pass", agent=None):
    r = await team["client"].post(f"/api/qa/sessions/{s['id']}/verdicts", json={
        "actor_agent_id": agent or team["qa"], "acceptance_line": index, "verdict": value})
    assert r.status_code == 201, r.text


async def finish(team, s, status="done", agent=None):
    r = await team["client"].patch(f"/api/qa/sessions/{s['id']}", json={"actor_agent_id": agent or team["qa"], "status": status})
    assert r.status_code == 200, r.text


async def setting(team, value="quality", **extra):
    r = await team["client"].put(f"/api/containers/{team['cid']}/qa/settings", json={
        "actor_agent_id": team["human"], "agent_id": team["qa"], "final_decision": value, **extra})
    assert r.status_code == 200, r.text
    return r.json()


async def read(team, tid):
    from portal_backend.database import db_cursor

    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT status, title FROM tasks WHERE id=%s", (tid,))
        return dict(cur.fetchone())


async def qa_of(team, tid):
    return (await team["client"].get(f"/api/tasks/{tid}/qa")).json()


async def thread(team, tid):
    from portal_backend.database import db_cursor

    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT body FROM task_messages WHERE task_id=%s ORDER BY created_at", (tid,))
        return [r["body"] for r in cur.fetchall()]


def result_of(db, tid):
    value = db.execute("SELECT result FROM tasks WHERE id=%s", (tid,))[0]["result"]
    return json.loads(value) if isinstance(value, str) else value


def codes(decision):
    return [r["code"] for r in decision["reasons"]]


# ---------------------------------------------------------------- always linked

async def test_a_session_with_no_task_is_refused(team):
    r = await team["client"].post(f"/api/containers/{team['cid']}/qa/sessions", json={
        "actor_agent_id": team["qa"], "kind": "explore", "platform": "web"})
    assert r.status_code == 400 and "needs a task" in r.json()["detail"]


async def test_a_session_naming_a_request_takes_its_task(team):
    out = await hand(team, await task(team))
    s = await session(team, request_id=out["request"]["id"])
    assert s["task_id"] == out["qa_task_id"]


async def run_task(team, agent, **headers):
    r = await team["client"].post(f"/api/containers/{team['cid']}/qa/run-task", json={
        "actor_agent_id": agent, "kind": "check", "platform": "web", "goal": "the checkout"}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


async def test_the_workers_current_task_is_found(team):
    tid = await task(team, assignee="QAEngineer")
    assert await run_task(team, team["qa"]) == {"task_id": tid, "created": False}


async def test_the_task_of_the_workers_own_run_comes_first(team, db):
    mine = await task(team, "Mine", assignee="QAEngineer")
    await task(team, "Newer", assignee="QAEngineer")
    headers = await team["lane"](team["qa"])
    run = db.execute("INSERT INTO worker_runs (agent_id, task_id, status) VALUES (%s,%s,'running') RETURNING run_id", (team["qa"], mine))[0]["run_id"]
    db.execute("UPDATE embodiment_tokens SET run_id=%s WHERE run_token=%s", (run, headers["X-Orcha-Run-Token"]))
    assert (await run_task(team, team["qa"], **headers))["task_id"] == mine


async def test_with_no_task_a_run_task_is_made_and_wakes_nobody(team, db):
    out = await run_task(team, team["qa"])
    assert out["created"]
    t = await read(team, out["task_id"])
    assert t["status"] == "in_progress" and "the checkout" in t["title"]
    assert db.execute("SELECT origin, kind FROM qa_runs WHERE task_id=%s", (out["task_id"],))[0]["origin"] == "agent"
    assert db.execute("SELECT assignment_status FROM agent_tasks WHERE task_id=%s", (out["task_id"],))[0]["assignment_status"] == "working"
    assigned = db.execute("SELECT id FROM agent_events WHERE event_name='task_assigned' AND event_key=%s", (team["qa"],))
    assert assigned and all(db.execute("SELECT 1 AS hit FROM agent_event_acks WHERE event_id=%s", (r["id"],)) for r in assigned)
    assert (await run_task(team, team["qa"]))["task_id"] == out["task_id"]  # and the next session finds it


async def test_every_way_to_start_a_run_marks_it_the_same_way(team, db):
    out = await hand(team, await task(team))
    assert db.execute("SELECT origin FROM qa_runs WHERE task_id=%s", (out["qa_task_id"],))[0]["origin"] == "request"
    tid = await task(team, "Run the suite", assignee="QAEngineer")
    r = await team["client"].post(f"/api/containers/{team['cid']}/qa/sessions/queue", json={
        "actor_agent_id": team["human"], "kind": "check", "platform": "web", "task_id": tid})
    assert r.status_code == 201, r.text
    assert db.execute("SELECT origin FROM qa_runs WHERE task_id=%s", (tid,))[0]["origin"] == "run_check"
    listed = (await team["client"].get(f"/api/containers/{team['cid']}/qa/run-tasks")).json()["run_tasks"]
    assert {x["task_id"] for x in listed} == {out["qa_task_id"], tid}


async def test_an_agents_own_feature_task_is_no_run_task(team, db):
    tid = await task(team)
    await session(team, team["dev"], task_id=tid)
    assert not db.execute("SELECT 1 AS hit FROM qa_runs WHERE task_id=%s", (tid,))
    assert not (await qa_of(team, tid))["is_run_task"]


# ---------------------------------------------------------------- the default: a person decides

async def test_a_run_writes_its_result_and_stops_for_a_person(team, db):
    source = await task(team)
    await done(team, source, team["dev"])
    out = await hand(team, source)
    run_id = out["qa_task_id"]
    s = await session(team, request_id=out["request"]["id"])
    await verdict(team, s, 0)
    await verdict(team, s, 1)
    await finish(team, s)
    stored = result_of(db, run_id)["qa_run"]
    assert stored["outcome"] == "passed" and stored["session_id"] == s["id"]
    assert [x["verdict"] for x in stored["lines"]] == ["pass", "pass"] and stored["agent"]["alias"] == "QAEngineer"
    assert stored["links"]["run"] == f"/qa?view=sessions&session={s['id']}" and "activity_log" in stored["links"]
    assert any(b.startswith("[Run result]") for b in await thread(team, run_id))
    await done(team, run_id, team["qa"], "All good")
    assert result_of(db, run_id)["result"] == "All good" and result_of(db, run_id)["qa_run"]["outcome"] == "passed"
    assert len([b for b in await thread(team, run_id) if b.startswith("[Run result]")]) == 1
    assert (await read(team, run_id))["status"] == "needs_verification"
    assert (await read(team, source))["status"] == "needs_verification"
    assert (await qa_of(team, source))["final_decision"] is None


async def test_a_failed_run_also_stops_for_a_person(team, db):
    out = await hand(team, await task(team))
    s = await session(team, request_id=out["request"]["id"])
    await verdict(team, s, 0, "fail")
    await finish(team, s)
    await done(team, out["qa_task_id"], team["qa"])
    assert result_of(db, out["qa_task_id"])["qa_run"]["outcome"] == "failed"
    assert (await read(team, out["qa_task_id"]))["status"] == "needs_verification"


@pytest.mark.parametrize("status", ["failed", "cancelled", "abandoned"])
async def test_a_dead_run_stays_open_with_its_reason(team, db, status):
    tid = await task(team, "Explore", assignee="QAEngineer")
    db.execute("INSERT INTO qa_runs (task_id, container_id, origin) VALUES (%s,%s,'exploration')", (tid, team["cid"]))
    s = await session(team, task_id=tid)
    await team["client"].post(f"/api/qa/sessions/{s['id']}/steps", json={"actor_agent_id": team["qa"], "steps": [{"seq": 1, "kind": "note"}]})
    await finish(team, s, status)
    got = (await qa_of(team, tid))["run_result"]
    assert got["outcome"] == "stopped" and got["reason"]
    assert (await read(team, tid))["status"] == "in_progress"
    assert result_of(db, tid)["qa_run"]["outcome"] == "stopped"
    assert any(b.startswith("[Run stopped]") and "stays open" in b for b in await thread(team, tid))


async def test_a_run_with_no_request_rolls_up_from_its_session(team, db):
    tid = await task(team, "Explore", assignee="QAEngineer")
    db.execute("INSERT INTO qa_runs (task_id, container_id, origin, kind) VALUES (%s,%s,'exploration','explore')", (tid, team["cid"]))
    s = await session(team, task_id=tid)
    await team["client"].post(f"/api/qa/sessions/{s['id']}/findings", json={"actor_agent_id": team["qa"], "severity": "minor", "title": "A typo"})
    await team["client"].post(f"/api/qa/sessions/{s['id']}/steps", json={"actor_agent_id": team["qa"], "steps": [
        {"seq": 1, "kind": "screen", "screen_key": "home"}, {"seq": 2, "kind": "screen", "screen_key": "cart"}]})
    await finish(team, s)
    got = (await qa_of(team, tid))["run_result"]
    assert got["outcome"] == "passed" and got["screens_reached"] == 2 and got["findings"][0]["title"] == "A typo"
    assert got["is_run_task"] and got["origin"] == "exploration" and got["duration_seconds"] is not None


async def test_only_a_person_changes_the_setting_and_it_is_logged(team, db):
    assert (await team["client"].get(f"/api/containers/{team['cid']}/qa/settings")).json()["final_decision"] == "person"
    r = await team["client"].put(f"/api/containers/{team['cid']}/qa/settings", json={"actor_agent_id": team["qa"], "final_decision": "quality"})
    assert r.status_code == 403
    conf = await setting(team)
    assert conf["final_decision"] == "quality" and conf["final_decision_by_alias"] == "Hussein" and conf["final_decision_at"]
    event = db.execute("SELECT detail FROM events WHERE event_type='qa_final_decision_changed'")[0]["detail"]
    event = json.loads(event) if isinstance(event, str) else event
    assert event["from"] == "person" and event["to"] == "quality" and event["by"] == team["human"]
    r = await team["client"].put(f"/api/containers/{team['cid']}/qa/settings", json={"actor_agent_id": team["human"], "agent_id": team["qa"]})
    assert r.json()["final_decision"] == "quality"  # left out, it stays


async def test_it_is_a_project_setting_with_no_override_on_a_request(team):
    r = await team["client"].post(f"/api/tasks/{await task(team)}/qa/requests", json={"actor_agent_id": team["human"], "final_decision": "quality"})
    assert r.status_code == 201 and "final_decision" not in r.json()["request"]


# ---------------------------------------------------------------- under quality

async def proved(team, *, lines=2, agent=None):
    """Dev's task, handed to QA, proved line by line by `agent`, the session ended."""
    source = await task(team)
    await done(team, source, team["dev"])
    out = await hand(team, source)
    s = await session(team, agent, request_id=out["request"]["id"])
    for i in range(lines):
        await verdict(team, s, i, agent=agent)
    return source, out, s


async def test_a_clean_pass_finishes_the_source_and_the_run_task(team, db):
    await setting(team)
    waiting = await task(team, "After it", depends_on=[])
    source, out, s = await proved(team)
    dependent = await task(team, "Depends", assignee=None, depends_on=[source])
    assert (await read(team, dependent))["status"] != "ready"
    await finish(team, s)
    assert (await read(team, source))["status"] == "completed"
    assert (await read(team, dependent))["status"] == "ready"
    await done(team, out["qa_task_id"], team["qa"])
    assert (await read(team, out["qa_task_id"]))["status"] == "completed"
    assert (await read(team, waiting))["status"] == "in_progress"
    decision = (await qa_of(team, source))["final_decision"]
    assert decision["decision"] == "finished" and decision["actor"] == "system:qa" and decision["turned_on_by_alias"] == "Hussein"
    approval = db.execute("SELECT actor_id, permission_source FROM task_approval_records WHERE task_id=%s AND phase='completion'", (source,))[0]
    assert approval["permission_source"] == "qa_final_decision" and str(approval["actor_id"]) == team["human"]
    event = db.execute("SELECT actor_type, detail FROM events WHERE entity_id=%s AND event_type='status_changed' ORDER BY created_at DESC", (source,))[0]
    detail = json.loads(event["detail"]) if isinstance(event["detail"], str) else event["detail"]
    assert event["actor_type"] == "system" and detail["actor"] == "system:qa" and detail["to"] == "completed"
    assert any(b.startswith("[Finished by itself]") for b in await thread(team, source))


async def test_the_setting_is_read_when_the_decision_is_made(team):
    await setting(team)
    source, _, s = await proved(team)
    await setting(team, "person")
    await finish(team, s)
    assert (await read(team, source))["status"] == "needs_verification"


async def test_a_line_qa_did_not_cover_goes_to_a_person_with_the_line_listed(team):
    await setting(team)
    source, out, s = await proved(team, lines=1)
    await finish(team, s)
    assert (await read(team, source))["status"] == "needs_verification"
    decision = (await qa_of(team, source))["final_decision"]
    assert decision["decision"] == "person" and "line_needs_human" in codes(decision)
    assert [x["text"] for x in decision["lines"]] == ["The receipt is emailed"]
    said = [b for b in await thread(team, source) if b.startswith("[Needs a person]")]
    assert "The receipt is emailed" in said[-1] and "The total shows the discount" not in said[-1]


async def test_the_same_refusal_is_said_once(team):
    await setting(team)
    source, _, s = await proved(team, lines=1)
    await finish(team, s)
    said = await thread(team, source)
    qa_run_tasks.consider(source)
    assert await thread(team, source) == said


async def test_the_agent_that_did_the_work_cannot_prove_it(team):
    await setting(team)
    source, _, s = await proved(team, agent=team["dev"])
    await finish(team, s, agent=team["dev"])
    assert (await read(team, source))["status"] == "needs_verification"
    got = codes((await qa_of(team, source))["final_decision"])
    assert "own_check" in got and "line_own_verdict" in got


async def test_proof_from_before_the_work_finished_does_not_count(team):
    await setting(team)
    source = await task(team)
    out = await hand(team, source)
    s = await session(team, request_id=out["request"]["id"])
    await verdict(team, s, 0)
    await verdict(team, s, 1)
    await finish(team, s)
    assert (await read(team, source))["status"] == "in_progress"
    await done(team, source, team["dev"])
    assert (await read(team, source))["status"] == "needs_verification"
    assert "line_stale_proof" in codes((await qa_of(team, source))["final_decision"])


async def test_an_open_major_finding_never_finishes_the_task_and_goes_back_to_be_fixed(team):
    await setting(team)
    source, out, s = await proved(team)
    await team["client"].post(f"/api/qa/sessions/{s['id']}/findings", json={"actor_agent_id": team["qa"], "severity": "major", "title": "It broke"})
    await finish(team, s)
    assert (await read(team, source))["status"] == "in_progress"
    assert (await qa_of(team, source))["final_decision"]["decision"] == "person"


async def test_a_failed_line_with_no_finding_goes_back_to_the_agent(team):
    await setting(team)
    source = await task(team)
    await done(team, source, team["dev"])
    out = await hand(team, source)
    s = await session(team, request_id=out["request"]["id"])
    await verdict(team, s, 0, "fail")
    await finish(team, s)
    assert (await read(team, source))["status"] == "in_progress"
    await done(team, out["qa_task_id"], team["qa"])
    assert (await read(team, out["qa_task_id"]))["status"] == "needs_verification"


async def test_a_dead_run_leaves_both_for_a_person(team):
    await setting(team)
    source, out, s = await proved(team)
    await team["client"].post(f"/api/qa/sessions/{s['id']}/steps", json={"actor_agent_id": team["qa"], "steps": [{"seq": 1, "kind": "note"}]})
    await finish(team, s, "abandoned")
    assert (await read(team, source))["status"] == "needs_verification"
    assert (await read(team, out["qa_task_id"]))["status"] == "in_progress"


async def test_drafts_keep_a_run_task_for_a_person(team, db):
    await setting(team)
    tid = await task(team, "Explore", assignee="QAEngineer", dod="The exploration ended.")
    db.execute("INSERT INTO qa_runs (task_id, container_id, origin) VALUES (%s,%s,'exploration')", (tid, team["cid"]))
    s = await session(team, task_id=tid)
    db.execute("INSERT INTO qa_scenarios (id, container_id, platform, name, criteria, status, session_id) VALUES (%s,%s,'web','Pay','[]','draft',%s)",
               (qa_run_tasks.qs.new_id(), team["cid"], s["id"]))
    await finish(team, s)
    await done(team, tid, team["qa"])
    assert (await read(team, tid))["status"] == "needs_verification"
    assert codes((await qa_of(team, tid))["final_decision"]) == ["drafts"]


async def test_a_backend_task_finishes_on_tests_alone(team, monkeypatch):
    await setting(team)
    pack = {"dod": {"items": [{"index": 0, "text": "Tests pass", "status": "proven", "basis": "tests", "strong": True}]}, "flags": [], "tests": {"status": "passed"}, "changes": {}}
    monkeypatch.setattr(qa_run_tasks, "_pack_of", lambda tid: pack)
    tid = await task(team, dod="All tests pass")
    await done(team, tid, team["dev"])
    assert (await read(team, tid))["status"] == "completed"


async def test_a_task_nothing_proves_goes_to_a_person(team):
    await setting(team)
    tid = await task(team)
    await done(team, tid, team["dev"])
    assert (await read(team, tid))["status"] == "needs_verification"
    assert "line_needs_human" in codes((await qa_of(team, tid))["final_decision"])


async def test_with_no_evidence_pack_a_task_goes_to_a_person(team, monkeypatch):
    await setting(team)
    monkeypatch.setattr(qa_run_tasks, "_pack_of", lambda tid: None)
    tid = await task(team)
    await done(team, tid, team["dev"])
    assert codes((await qa_of(team, tid))["final_decision"]) == ["no_pack"]


async def test_the_root_task_never_finishes_here(team, db):
    await setting(team)
    root = db.execute("SELECT id FROM tasks WHERE container_id=%s AND is_root", (team["cid"],))[0]["id"]
    db.execute("UPDATE tasks SET status='needs_verification' WHERE id=%s", (str(root),))
    qa_run_tasks.consider(str(root))
    assert db.execute("SELECT status FROM tasks WHERE id=%s", (str(root),))[0]["status"] == "needs_verification"


# ---------------------------------------------------------------- who did it

async def test_an_agents_runs_and_the_payloads_name_the_agent_and_its_run(team, db):
    out = await hand(team, await task(team))
    tid = out["qa_task_id"]
    run = db.execute("INSERT INTO worker_runs (agent_id, task_id, status, total_cost_usd, started_at) VALUES (%s,%s,'running',1.25,%s) RETURNING run_id",
                     (team["qa"], tid, "2026-01-01T00:00:00+00:00"))[0]["run_id"]
    s = await session(team, request_id=out["request"]["id"])
    await verdict(team, s, 0)
    await verdict(team, s, 1)
    await finish(team, s)
    got = (await team["client"].get(f"/api/agents/{team['qa']}/qa-runs")).json()
    row = got["runs"][0]
    assert got["agent_alias"] == "QAEngineer" and got["totals"]["runs"] == 1 and got["totals"]["cost_usd"] == 1.25
    assert row["outcome"] == "passed" and row["run_id"] == str(run) and row["cost_usd"] == 1.25 and row["duration_seconds"] is not None
    assert row["links"]["activity_log"].startswith("/api/qa/run-log") and row["links"]["worker_run"].endswith(str(run))
    listed = (await team["client"].get(f"/api/containers/{team['cid']}/qa/sessions")).json()["sessions"][0]
    assert listed["run_id"] == str(run) and listed["agent_alias"] == "QAEngineer"
    req = (await team["client"].get(f"/api/qa/requests/{out['request']['id']}")).json()
    assert req["run_id"] == str(run) and req["agent_alias"] == "QAEngineer"
    assert (await qa_of(team, tid))["run_result"]["cost_usd"] == 1.25
    metrics = (await team["client"].get(f"/api/containers/{team['cid']}/metrics")).json()["qa"]
    assert metrics["runs"] == 1 and metrics["cost_usd"] >= 0


# ---------------------------------------------------------------- workflow steps

async def quality(p):
    await p.call("PUT", f"/api/containers/{p.cid}/qa/settings", {"actor_agent_id": p.owner, "agent_id": p.bob, "final_decision": "quality"})


async def qa_step(p):
    await build(p, plan=True)
    run = await turn(p, p.bob, "QA")
    return run, await step_session(p, await request_of(p, "QA"))


async def test_a_step_keeps_reporting_through_the_outcome_path_and_waits_for_a_person(client):
    p = Project(client)
    await preset(p, "build_qa_fix")
    run, s = await qa_step(p)
    await line(p, s["id"])
    await end(p, s["id"])
    assert step(await p.detail(p.wid), p.tasks["QA"])["reported_outcome"]["outcome"] == "pass"
    await step_done(p, p.bob, "QA", run)
    await stopped(p, p.bob, run)
    assert step(await p.detail(p.wid), p.tasks["QA"])["status"] == "needs_verification"


async def test_a_clean_step_is_accepted_under_quality_and_routes_on(client, monkeypatch, db):
    monkeypatch.setattr(qa_handoff, "BACKGROUND", False)
    p = Project(client)
    await preset(p, "build_qa_fix")
    await quality(p)
    run, s = await qa_step(p)
    await line(p, s["id"])
    await end(p, s["id"])
    await step_done(p, p.bob, "QA", run)
    await stopped(p, p.bob, run)
    detail = await p.detail(p.wid)
    assert step(detail, p.tasks["QA"])["status"] == "completed"
    row = db.execute("SELECT actor_kind, acceptance_source, actor_id FROM workflow_task_acceptances WHERE task_id=%s", (p.tasks["QA"],))[0]
    assert row["acceptance_source"] == "qa_final_decision" and row["actor_kind"] == "human" and str(row["actor_id"]) == p.owner
    history = db.execute("SELECT detail FROM workflow_history WHERE task_id=%s AND event='workflow_task_accepted'", (p.tasks["QA"],))[0]["detail"]
    assert "system:qa" in (history if isinstance(history, str) else json.dumps(history))


async def test_a_step_with_no_pack_goes_to_a_person(client, monkeypatch):
    monkeypatch.setattr(qa_handoff, "BACKGROUND", False)
    monkeypatch.setattr(qa_run_tasks, "_pack_of", lambda tid: None)
    p = Project(client)
    await preset(p, "build_qa_fix")
    await quality(p)
    run, s = await qa_step(p)
    await line(p, s["id"])
    await end(p, s["id"])
    await step_done(p, p.bob, "QA", run)
    await stopped(p, p.bob, run)
    assert step(await p.detail(p.wid), p.tasks["QA"])["status"] == "needs_verification"
    got = (await p.call("GET", f"/api/tasks/{p.tasks['QA']}/qa"))["final_decision"]
    assert codes(got) == ["no_pack"]
    await p.call("POST", f"/api/tasks/{p.tasks['QA']}/verify", {"approve": True, "actor_agent_id": p.owner})


async def test_a_step_waits_for_its_saved_evidence_before_any_decision(client, monkeypatch):
    monkeypatch.setattr(qa_handoff, "BACKGROUND", False)
    p = Project(client)
    await preset(p, "build_qa_fix")
    await quality(p)
    run, s = await qa_step(p)
    await line(p, s["id"])
    await end(p, s["id"])
    await step_done(p, p.bob, "QA", run)
    assert step(await p.detail(p.wid), p.tasks["QA"])["status"] == "needs_verification"
    assert (await p.call("GET", f"/api/tasks/{p.tasks['QA']}/qa"))["final_decision"] is None


async def test_a_clean_fail_sends_the_step_back_to_the_fix_step(client, monkeypatch):
    monkeypatch.setattr(qa_handoff, "BACKGROUND", False)
    p = Project(client)
    await preset(p, "build_qa_fix", max_rounds=3)
    await quality(p)
    run, s = await qa_step(p)
    await line(p, s["id"], "fail", note="It is wrong")
    await end(p, s["id"])
    await step_done(p, p.bob, "QA", run)
    await stopped(p, p.bob, run)
    detail = await p.detail(p.wid)
    assert step(detail, p.tasks["Build"])["round"] == 2
    assert (await p.call("GET", f"/api/tasks/{p.tasks['QA']}/qa"))["final_decision"]["decision"] == "sent_back"


# ---------------------------------------------------------------- the tool server

async def test_start_session_resolves_the_task_and_sends_the_workers_token(monkeypatch):
    from test_qa_mcp import make  # the tool server against a fake portal

    monkeypatch.setenv("ORCHA_RUN_TOKEN", "tok")
    tools, portal = make()[:2]
    seen = {}
    real = portal._request

    def spy(method, path, body=None, **kw):
        if path.endswith("/run-task"):
            seen.update(body=body, headers=kw.get("headers"))
        return real(method, path, body, **kw)

    portal._request = spy
    out = await tools.start_session("ios", "explore", goal="the cart")
    assert "task: task-of-the-worker" in out
    assert seen["headers"] == {"X-Orcha-Run-Token": "tok"} and seen["body"]["goal"] == "the cart"
    assert portal.calls_to("POST", "/sessions$")[0][2]["task_id"] == "task-of-the-worker"


async def test_a_named_task_is_kept_and_nothing_is_resolved(monkeypatch):
    from test_qa_mcp import make

    tools, portal = make()[:2]
    await tools.start_session("ios", "explore", task_id="mine")
    assert not portal.calls_to("POST", "/run-task$")
    assert portal.calls_to("POST", "/sessions$")[0][2]["task_id"] == "mine"


async def test_a_session_with_no_resolvable_task_never_starts(monkeypatch):
    from test_qa_mcp import make

    tools, portal = make()[:2]
    portal.fail[("POST", "/run-task$")] = "no"
    out = await tools.start_session("ios", "explore")
    assert out.startswith("error: could not find a task") and not portal.calls_to("POST", "/sessions$")
