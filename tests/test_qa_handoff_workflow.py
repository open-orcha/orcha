"""QA and triage steps in real workflows, over HTTP with the real hooks and evidence: a failing round,
triage, the fix, the pass. The route of an outcome applies when a person accepts the step, never from
the result: a QA or triage result verifies nothing."""

import pytest

from portal_backend import evidence_parse  # noqa: F401
from portal_backend import workflow_evidence_service as evidence
from portal_backend.database import db_cursor
from test_workflow_local_launch import Project, uid
from test_workflow_review_handoff import launch, stopped


@pytest.fixture(autouse=True)
def evidence_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("ORCHA_ATTACHMENTS_DIR", str(tmp_path))
    monkeypatch.setattr(evidence.store, "attachments_dir", lambda: tmp_path)


async def preset(p, key, device=None, **rounds):
    await p.call("PUT", f"/api/containers/{p.cid}/qa/settings", {"actor_agent_id": p.owner, "agent_id": p.bob, **rounds})
    got = await p.call("GET", f"/api/containers/{p.cid}/qa/workflow-presets")
    draft = next(x for x in got["presets"] if x["key"] == key)["draft"]
    for t in draft["tasks"]:
        t["assignee_id"] = t["assignee_id"] or p.ann
        if t.get("qa"):
            t["qa"]["platform"] = "web"
            if device and t["qa"]["kind"] != "triage":
                t["qa"]["device"] = device
        t["definition_of_done"] = "- The total is right"
    await p.call("POST", f"/api/containers/{p.cid}/workflows/preview", draft)
    w = await p.call("POST", f"/api/containers/{p.cid}/workflows", {**draft, "idempotency_key": uid()}, 201)
    p.wid = w["id"]
    p.tasks = {t["title"]: t["id"] for t in w["tasks"]}
    for tid in p.tasks.values():
        detail = await p.detail(p.wid)
        task = next(t for t in detail["tasks"] if t["id"] == tid)
        await p.call("POST", f"/api/tasks/{tid}/prepare", p.mutation(detail, expected_work_revision=task["work_revision"]))
    detail = await p.detail(p.wid)
    await p.call("POST", f"/api/workflows/{p.wid}/start", p.mutation(
        detail, task_ids=list(p.tasks.values()), holds=["start"], task_revisions={t["id"]: t["work_revision"] for t in detail["tasks"]}))


async def turn(p, aid, key, *, plan=False):
    return await launch(p, aid, key, approve=plan)


async def done(p, aid, key, run):
    r = await p.client.post(f"/api/tasks/{p.tasks[key]}/done", json={"agent_id": aid, "result": f"{key} finished"},
                            headers={"X-Orcha-Run-Token": run["token"]})
    assert r.status_code == 200, r.text


async def accept(p, aid, key, run):
    await stopped(p, aid, run)
    return await p.call("POST", f"/api/tasks/{p.tasks[key]}/verify", {"approve": True, "actor_agent_id": p.owner})


async def build(p, *, plan):
    run = await turn(p, p.ann, "Build", plan=plan)
    await done(p, p.ann, "Build", run)
    await accept(p, p.ann, "Build", run)


async def request_of(p, key):
    rows = (await p.call("GET", f"/api/containers/{p.cid}/qa/requests?source_workflow_id={p.wid}"))["requests"]
    return next(r for r in rows if r["qa_task_id"] == p.tasks[key])


async def session(p, req, kind="check"):
    return await p.call("POST", f"/api/containers/{p.cid}/qa/sessions", {
        "actor_agent_id": p.bob, "kind": kind, "platform": "web", "request_id": req["id"]}, 201)


async def finding(p, sid, severity, title, **extra):
    return await p.call("POST", f"/api/qa/sessions/{sid}/findings", {
        "actor_agent_id": p.bob, "severity": severity, "title": title, "expected": f"{title} works", **extra}, 201)


async def end(p, sid):
    await p.call("PATCH", f"/api/qa/sessions/{sid}", {"actor_agent_id": p.bob, "status": "done"})


async def line(p, sid, verdict="pass", note=None):
    await p.call("POST", f"/api/qa/sessions/{sid}/verdicts", {"actor_agent_id": p.bob, "acceptance_line": 0, "verdict": verdict, "note": note}, 201)


def step(detail, tid):
    return next(t for t in detail["tasks"] if t["id"] == tid)


def scenario(p):
    sid = uid()
    with db_cursor() as (_, cur):
        cur.execute("""INSERT INTO qa_scenarios (id, container_id, platform, name, criteria, status) VALUES (%s,%s,'web','Pay',%s,'validated')""",
                    (sid, p.cid, '["It pays", "A receipt shows"]'))
    return sid


async def test_build_qa_fix_fails_loops_with_the_findings_and_passes(client):
    p = Project(client)
    await preset(p, "build_qa_fix", max_rounds=3)
    await build(p, plan=True)

    # The QA step needs no plan question: the owner's Start approved it.
    run = await turn(p, p.bob, "QA")
    req = await request_of(p, "QA")
    assert req["origin"] == "workflow" and req["source_task_id"] == req["qa_task_id"] == p.tasks["QA"] and req["round"] == 1
    assert req["approved_by_agent_id"] == p.owner and "Build finished" in req["build"]["notes"]
    protocol = await p.call("GET", f"/api/agents/{p.bob}/protocol?task_id={p.tasks['QA']}")
    assert protocol["workflow"]["qa"]["skill"] == "/orcha-qa-explore" and protocol["workflow"]["qa"]["request_id"] == req["id"]
    s = await session(p, req, "explore")
    await finding(p, s["id"], "major", "The total is wrong")
    await end(p, s["id"])
    await done(p, p.bob, "QA", run)

    # The result reported the outcome; nothing is accepted until a person says so.
    detail = await p.detail(p.wid)
    qa = step(detail, p.tasks["QA"])
    assert qa["status"] == "needs_verification" and qa["reported_outcome"]["outcome"] == "fail" and not qa["reported_outcome"]["applied"]
    assert [f["text"].split(";")[0] for f in qa["reported_outcome"]["findings"]] == ["The total is wrong"]
    assert detail["repeat_groups"][0]["current_round"] == 1  # the route waits for a person
    assert qa["qa"]["kind"] == "explore"
    items = (await p.call("GET", f"/api/workflows/{p.wid}/tasks/{p.tasks['QA']}/evidence"))["sets"][0]["items"]
    assert any(i["kind"] == "log_excerpt" and "QA result" in (i["note"] or "") for i in items)

    await accept(p, p.bob, "QA", run)
    detail = await p.detail(p.wid)
    assert step(detail, p.tasks["Build"])["can_start"]
    context = await p.call("GET", f"/api/tasks/{p.tasks['Build']}/round-context")
    assert context["group"]["round"] == 2 and [f["severity"] for f in context["group"]["this_round"]["findings"]] == ["major"]
    assert "The total is wrong" in context["group"]["this_round"]["findings"][0]["text"]

    await build(p, plan=False)
    run = await turn(p, p.bob, "QA")
    req = await request_of(p, "QA")
    assert req["round"] == 2 and req["previous_request_id"]
    s = await session(p, req, "explore")
    await line(p, s["id"])
    await end(p, s["id"])
    await done(p, p.bob, "QA", run)
    qa = step(await p.detail(p.wid), p.tasks["QA"])
    assert qa["reported_outcome"]["outcome"] == "pass" and qa["status"] == "needs_verification"  # a pass never accepts the step
    await accept(p, p.bob, "QA", run)
    assert (await p.detail(p.wid))["repeat_groups"][0]["state"] == "exited"


async def test_a_steps_device_reaches_its_request_and_its_worker(client):
    p = Project(client)
    await preset(p, "build_qa_fix", device="mobile")
    await build(p, plan=True)
    await turn(p, p.bob, "QA")
    assert (await request_of(p, "QA"))["device"] == "mobile"
    protocol = await p.call("GET", f"/api/agents/{p.bob}/protocol?task_id={p.tasks['QA']}")
    assert protocol["workflow"]["qa"]["device"] == "mobile"


async def test_a_worker_cannot_report_a_qa_steps_outcome(client):
    p = Project(client)
    await preset(p, "build_qa_fix")
    await build(p, plan=True)
    run = await turn(p, p.bob, "QA")
    detail = await p.detail(p.wid)
    r = await client.post(f"/api/tasks/{p.tasks['QA']}/outcome", headers={"X-Orcha-Run-Token": run["token"]}, json={
        "outcome": "pass", "expected_revision": detail["revision"], "idempotency_key": uid(),
        "expected_work_revision": step(detail, p.tasks["QA"])["work_revision"]})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "qa_step_outcome"
    forged = await client.post(f"/api/tasks/{p.tasks['QA']}/outcome", headers={"X-Orcha-Run-Token": run["token"]}, json={
        "outcome": "pass", "expected_revision": detail["revision"], "idempotency_key": uid(), "qa_rollup": True,
        "expected_work_revision": step(detail, p.tasks["QA"])["work_revision"]})
    assert forged.status_code == 422  # the marker never comes from a client


async def test_a_blocked_step_reports_nothing_and_asks_the_owner_on_accept(client):
    p = Project(client)
    await preset(p, "build_qa_fix")
    await build(p, plan=True)
    run = await turn(p, p.bob, "QA")
    await done(p, p.bob, "QA", run)  # no session at all
    assert (await request_of(p, "QA"))["status"] == "blocked"
    assert step(await p.detail(p.wid), p.tasks["QA"])["reported_outcome"] is None
    await accept(p, p.bob, "QA", run)
    assert step(await p.detail(p.wid), p.tasks["QA"])["awaiting_loop_decision"] == "missing_outcome"


async def test_build_qa_triage_fix_only_the_confirmed_finding_goes_back(client):
    """Fail at QA, triage finds one flaky, one minor, one confirmed major, back to build with only
    the major, QA passes, and the work goes on past triage."""
    p = Project(client)
    await preset(p, "build_qa_triage_fix", max_rounds=3)
    pay = scenario(p)
    await build(p, plan=True)

    run = await turn(p, p.bob, "QA")
    s = await session(p, await request_of(p, "QA"), "explore")
    flaky = await finding(p, s["id"], "major", "Pay sometimes spins", scenario_id=pay)
    minor = await finding(p, s["id"], "minor", "The label is confusing")
    major = await finding(p, s["id"], "major", "The total ignores the discount")
    await end(p, s["id"])
    await done(p, p.bob, "QA", run)
    assert step(await p.detail(p.wid), p.tasks["QA"])["reported_outcome"]["outcome"] == "fail"
    await accept(p, p.bob, "QA", run)

    # A failed QA goes to triage, not to a fix.
    detail = await p.detail(p.wid)
    assert not step(detail, p.tasks["Build"])["can_start"] and step(detail, p.tasks["Triage"])["can_start"]
    run = await turn(p, p.bob, "Triage")
    req = await request_of(p, "Triage")
    assert req["kind"] == "triage" and sorted(req["finding_ids"]) == sorted([flaky["id"], minor["id"], major["id"]])
    t = await session(p, req, "explore")
    diagnose = lambda fid, **b: p.call("POST", f"/api/qa/findings/{fid}/triage", {"actor_agent_id": p.bob, **b})  # noqa: E731
    refused = await client.post(f"/api/qa/findings/{major['id']}/triage", json={
        "actor_agent_id": p.bob, "classification": "product_bug", "attempts": 1, "reproductions": 1})
    assert refused.status_code == 400 and "at least 3 times" in refused.text
    assert (await client.post(f"/api/qa/findings/{major['id']}/triage", json={"actor_agent_id": p.bob, "classification": "not_a_bug"})).status_code == 403
    assert (await diagnose(flaky["id"], classification="flaky", attempts=3, reproductions=1, root_cause="A slow network"))["action"] == "quarantined"
    filed = await diagnose(minor["id"], classification="product_bug", attempts=3, reproductions=3, root_cause="An old string")
    assert filed["action"] == "backlog" and filed["status"] == "filed" and filed["filed_task_id"]
    await diagnose(major["id"], classification="product_bug", attempts=3, reproductions=3, severity="blocker", root_cause="cart.ts drops the code")
    await end(p, t["id"])
    await done(p, p.bob, "Triage", run)
    req = await request_of(p, "Triage")
    assert (req["status"], req["decision"]) == ("failed", "fix") and req["result"]["confirmed_ids"] == [major["id"]]
    triage = step(await p.detail(p.wid), p.tasks["Triage"])
    assert triage["reported_outcome"]["outcome"] == "fix" and not triage["reported_outcome"]["applied"]
    await accept(p, p.bob, "Triage", run)

    # Only the confirmed finding reaches the build step, with how often and why.
    context = await p.call("GET", f"/api/tasks/{p.tasks['Build']}/round-context")
    findings = context["group"]["this_round"]["findings"]
    assert len(findings) == 1 and "fails 3 of 3" in findings[0]["text"] and "cart.ts drops the code" in findings[0]["text"]
    assert findings[0]["severity"] == "blocker"
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT quarantined_at, quarantine_reason, status FROM qa_scenarios WHERE id=%s", (pay,))
        row = cur.fetchone()
        assert row["quarantined_at"] and "fails 1 of 3" in row["quarantine_reason"] and row["status"] == "validated"

    await build(p, plan=False)
    run = await turn(p, p.bob, "QA")
    req = await request_of(p, "QA")
    assert req["round"] == 2
    s = await session(p, req, "explore")
    await line(p, s["id"])
    await end(p, s["id"])
    await done(p, p.bob, "QA", run)
    await accept(p, p.bob, "QA", run)
    detail = await p.detail(p.wid)
    assert step(detail, p.tasks["Triage"])["route_state"] == "not_selected" and step(detail, p.tasks["Sum up"])["can_start"]
    assert detail["repeat_groups"][0]["state"] == "exited" and step(detail, p.tasks["Sum up"])["status"] != "completed"


async def test_an_undiagnosed_finding_asks_the_owner(client):
    p = Project(client)
    await preset(p, "build_qa_triage_fix")
    await build(p, plan=True)
    run = await turn(p, p.bob, "QA")
    s = await session(p, await request_of(p, "QA"), "explore")
    await finding(p, s["id"], "major", "Broken")
    await end(p, s["id"])
    await done(p, p.bob, "QA", run)
    await accept(p, p.bob, "QA", run)
    run = await turn(p, p.bob, "Triage")
    await done(p, p.bob, "Triage", run)
    req = await request_of(p, "Triage")
    assert (req["status"], req["decision"]) == ("blocked", "needs_person")
    assert step(await p.detail(p.wid), p.tasks["Triage"])["reported_outcome"]["outcome"] == "needs_person"


@pytest.mark.parametrize("text,commit", [
    ("The current commit is 87120a0d (from git)", "87120a0d"),
    ("commit: abcdef1", "abcdef1"), ("Built at commit `1234abc`", "1234abc"), ("commit hash 87120a0d", "87120a0d"), ("sha 1234567", "1234567"),
])
def test_a_build_step_saying_its_commit_reaches_the_quality_step(text, commit):
    from portal_backend import qa_handoff

    assert qa_handoff._COMMIT.search(text).group(1) == commit


def test_a_summary_names_the_platform_as_people_do():
    from portal_backend import qa_handoff

    line = qa_handoff._summary({"kind": "check", "platform": "ios"}, "passed", [], [], [], [])
    assert line.startswith("QA check on iOS passed")
