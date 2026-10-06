"""Agent performance (evals-lite): GET .../metrics/performance[/agents/{aid}].

Every scenario drives the REAL write paths (done → verify approve/reject, plan decisions,
request escalation, worker runs with/without cost) and asserts the read model. The AI
manager send-back is inserted as its audit row (review_routing's `manager_review_recorded`
contract) so this suite does not depend on the pre-review wake plumbing.

Truthfulness under test: rates/medians/costs below MIN_SAMPLE are null + enough:false; a
not-metered task is excluded from cost/verified (never $0); auto-complete is not a
verification; the root task is not counted; viewers may read, non-members may not.
"""
import datetime as dt
import json

import pytest

from portal_backend import agent_performance as perf
from portal_backend import agent_performance_routes  # noqa: F401  (registers the routes)
from conftest import ts_ago
from portal_backend import sql




# ----------------------------------------------------------------- helpers

async def _run(client, aid, tid, cost=None, tokens=True):
    r = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral", "task_id": tid})
    assert r.status_code == 201, r.text
    body = {"status": "exited", "exit_code": 0}
    if tokens:
        body.update(input_tokens=10, output_tokens=10)
    if cost is not None:
        body["total_cost_usd"] = cost
    f = await client.post(f"/api/runs/{r.json()['run_id']}/finish", json=body)
    assert f.status_code == 200, f.text


async def _done(client, work_headers, aid, tid):
    r = await client.post(f"/api/tasks/{tid}/done", json={"agent_id": aid, "result": "done"},
                          headers=await work_headers(aid))
    assert r.status_code == 200, r.text
    return r.json()


async def _verify(client, tid, human_id, approve=True, feedback=None):
    body = {"approve": approve, "actor_agent_id": human_id}
    if feedback:
        body["feedback"] = feedback
    r = await client.post(f"/api/tasks/{tid}/verify", json=body)
    assert r.status_code == 200, r.text


async def _task_verified(client, make_task, work_headers, alias, aid, human_id, *,
                         title, cost=None, reject_first=False):
    t = await make_task(title, "dod", assignee_alias=alias)
    tid = t["id"]
    if cost is not None:
        await _run(client, aid, tid, cost=cost)
    if reject_first:
        await _done(client, work_headers, aid, tid)
        await _verify(client, tid, human_id, approve=False, feedback="needs tests")
    await _done(client, work_headers, aid, tid)
    await _verify(client, tid, human_id)
    return tid


async def _perf(client, cid, range_="30d", headers=None):
    r = await client.get(f"/api/containers/{cid}/metrics/performance",
                         params={"range": range_}, headers=headers or {})
    assert r.status_code == 200, r.text
    return r.json()


def _row(body, alias):
    return next(a for a in body["agents"] if a["alias"] == alias)


# ----------------------------------------------------------------- pure unit tests

def test_ranges_and_buckets_are_utc_calendar_days():
    now = dt.datetime(2026, 9, 29, 15, 30, tzinfo=dt.timezone.utc)
    since = perf.range_since("7d", now)
    assert since == dt.datetime(2026, 9, 23, tzinfo=dt.timezone.utc)
    assert perf.range_since("all", now) is None
    b7 = perf.build_buckets("7d", now)
    assert len(b7) == 7 and b7[0]["start"] == since
    assert b7[-1]["end"] == dt.datetime(2026, 9, 30, tzinfo=dt.timezone.utc)
    b90 = perf.build_buckets("90d", now)
    assert len(b90) == 9 and b90[0]["start"] == perf.range_since("90d", now)
    assert all((b["end"] - b["start"]).days == 10 for b in b90)
    assert len(perf.build_buckets("30d", now)) == 30
    # all-time: weekly from the first activity, capped
    assert perf.build_buckets("all", now, None) == []
    ball = perf.build_buckets("all", now, now - dt.timedelta(days=20))
    assert len(ball) == 3 and ball[-1]["end"] == b7[-1]["end"]
    assert len(perf.build_buckets("all", now, now - dt.timedelta(days=5000))) == perf.MAX_ALL_BUCKETS


def test_compute_metrics_thresholds_and_never_zero_cost():
    t0 = dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc)
    h = dt.timedelta(hours=1)
    verified = [
        {"task_id": "a", "verified_at": t0 + 2 * h, "started_at": t0},
        {"task_id": "b", "verified_at": t0 + 4 * h, "started_at": t0},
        {"task_id": "c", "verified_at": t0 + 6 * h, "started_at": t0},
    ]
    rework = [{"task_id": "b", "at": t0 + h, "kind": "rejection"},
              {"task_id": "c", "at": t0 + 7 * h, "kind": "send_back"}]  # after verification
    costs = {"a": {"runs": 1, "priced": 1, "cost": 1.0},
             "b": {"runs": 2, "priced": 2, "cost": 3.0},
             "c": {"runs": 2, "priced": 1, "cost": 0.5}}  # partially priced → not metered
    m = perf.compute_metrics(verified=verified, rework=rework, plan_decisions=[],
                             escalations=[], task_costs=costs, since=None)
    assert m["tasks_verified"] == 3
    assert m["first_pass_rate"] == {"value": 2 / 3, "numerator": 2, "denominator": 3, "enough": True}
    assert m["rework"] == {"total": 2, "human_rejections": 1, "manager_send_backs": 1}
    assert m["median_time_to_verified_seconds"]["value"] == 4 * 3600
    c = m["cost_per_verified_task_usd"]
    assert c["metered_tasks"] == 2 and c["unmetered_tasks"] == 1
    assert c["value"] is None and c["enough"] is False          # 2 < MIN_SAMPLE
    assert m["plan_approval_rate"]["value"] is None and m["plan_approval_rate"]["denominator"] == 0

    # all zero-cost → nothing metered → null, never 0
    zero = perf.compute_metrics(verified=verified, rework=[], plan_decisions=[], escalations=[],
                                task_costs={k: {"runs": 1, "priced": 0, "cost": 0.0} for k in "abc"},
                                since=None)
    assert zero["cost_per_verified_task_usd"]["value"] is None
    assert zero["cost_per_verified_task_usd"]["unmetered_tasks"] == 3


# ----------------------------------------------------------------- API tests

@pytest.mark.asyncio
async def test_empty_project_reports_counts_and_not_enough_data(client, container, make_agent):
    await make_agent("Forge")
    body = await _perf(client, container["id"])
    assert body["range"] == "30d" and body["min_sample"] == perf.MIN_SAMPLE
    assert body["bucket_days"] == 1 and len(body["project"]["series"]) == 30
    pm = body["project"]["metrics"]
    assert pm["tasks_verified"] == 0 and pm["escalations"] == 0 and pm["rework"]["total"] == 0
    assert pm["first_pass_rate"]["value"] is None and pm["first_pass_rate"]["enough"] is False
    assert pm["cost_per_verified_task_usd"]["value"] is None
    forge = _row(body, "Forge")
    assert forge["retired"] is False and forge["metrics"]["tasks_verified"] == 0


@pytest.mark.asyncio
async def test_full_scenario_per_agent_and_project(client, container, make_agent, make_task,
                                                    work_headers, db):
    cid = container["id"]
    human = (await make_agent("Owner", kind="human"))["agent_id"]
    forge = (await make_agent("Forge"))["agent_id"]
    pixel = (await make_agent("Pixel"))["agent_id"]

    # Forge: 4 verified, one after a rejection; 3 fully metered, 1 on a subscription (no cost)
    f1 = await _task_verified(client, make_task, work_headers, "Forge", forge, human, title="f1", cost=0.40)
    f2 = await _task_verified(client, make_task, work_headers, "Forge", forge, human, title="f2", cost=0.60,
                              reject_first=True)
    await _task_verified(client, make_task, work_headers, "Forge", forge, human, title="f3", cost=0.20)
    await _task_verified(client, make_task, work_headers, "Forge", forge, human, title="f4", cost=None)
    # a Forge run with NO cost on f3 as well → f3 becomes not metered
    await _run(client, forge, f1, cost=0.10)  # f1 total 0.50, still fully priced
    # backdate f1's start so the median has spread
    db.execute(f"UPDATE tasks SET started_at = {ts_ago(7200)} WHERE id=%s", (f1,))

    # Pixel: 1 verified (below threshold for rates)
    await _task_verified(client, make_task, work_headers, "Pixel", pixel, human, title="p1", cost=1.0)

    # AI manager send-back on a Pixel task (audit row contract from review_routing)
    p2 = (await make_task("p2", "dod", assignee_alias="Pixel"))["id"]
    db.execute(
        "INSERT INTO events (container_id, actor_type, actor_id, entity_type, entity_id, event_type, detail) "
        "VALUES (%s, 'ai', NULL, 'task', %s, 'manager_review_recorded', %s)",
        (cid, p2, json.dumps({"decision": "send_back", "status": "sent_back",
                              "reassigned_to_agent_ids": [pixel]})),
    )
    # a 'commented' manager review is NOT rework
    db.execute(
        "INSERT INTO events (container_id, actor_type, entity_type, entity_id, event_type, detail) "
        "VALUES (%s, 'ai', 'task', %s, 'manager_review_recorded', %s)",
        (cid, p2, json.dumps({"decision": "comment", "status": "commented"})),
    )

    # Plan decisions on Forge's tasks: 3 approve, 1 reject (target = Forge)
    for i, dec in enumerate(["approve", "approve", "reject", "approve"]):
        tid = (await make_task(f"plan{i}", "dod", assignee_alias="Forge"))["id"]
        body = {"subject_type": "plan_approval", "subject_id": tid, "decision": dec,
                "actor_agent_id": human, "target_agent_id": forge}
        if dec == "reject":
            body["reason"] = "too broad"
        r = await client.post("/api/decisions", json=body)
        assert r.status_code == 201, r.text

    # Pixel escalates an ask to the human
    r = await client.post(f"/api/containers/{cid}/requests",
                          json={"requester_agent_id": pixel, "payload": "which API?",
                                "type": "info", "target_alias": "Forge"})
    assert r.status_code == 201, r.text
    rid = r.json().get("request_id") or r.json().get("id")
    r = await client.post(f"/api/requests/{rid}/escalate",
                          json={"requester_agent_id": pixel, "reason": "blocked"})
    assert r.status_code == 200, r.text

    body = await _perf(client, cid, "30d")
    fm = _row(body, "Forge")["metrics"]
    assert fm["tasks_verified"] == 4
    assert fm["first_pass_rate"]["numerator"] == 3 and fm["first_pass_rate"]["denominator"] == 4
    assert fm["first_pass_rate"]["value"] == pytest.approx(0.75)
    assert fm["rework"] == {"total": 1, "human_rejections": 1, "manager_send_backs": 0}
    med = fm["median_time_to_verified_seconds"]
    assert med["enough"] and med["n"] == 4 and med["value"] is not None and med["value"] >= 0
    cost = fm["cost_per_verified_task_usd"]
    assert cost["metered_tasks"] == 3 and cost["unmetered_tasks"] == 1
    assert cost["value"] == pytest.approx((0.50 + 0.60 + 0.20) / 3)
    assert cost["value"] > 0
    pr = fm["plan_approval_rate"]
    assert (pr["approved"], pr["rejected"]) == (3, 1) and pr["value"] == pytest.approx(0.75)
    assert fm["escalations"] == 0

    pm = _row(body, "Pixel")["metrics"]
    assert pm["tasks_verified"] == 1
    assert pm["first_pass_rate"]["value"] is None and pm["first_pass_rate"]["enough"] is False
    assert pm["cost_per_verified_task_usd"]["value"] is None       # 1 metered < MIN_SAMPLE
    assert pm["rework"] == {"total": 1, "human_rejections": 0, "manager_send_backs": 1}
    assert pm["escalations"] == 1

    proj = body["project"]["metrics"]
    assert proj["tasks_verified"] == 5
    assert proj["first_pass_rate"]["numerator"] == 4
    assert proj["rework"]["total"] == 2
    assert proj["escalations"] == 1
    assert proj["cost_per_verified_task_usd"]["metered_tasks"] == 4
    assert proj["cost_per_verified_task_usd"]["value"] == pytest.approx((0.5 + 0.6 + 0.2 + 1.0) / 4)
    assert proj["plan_approval_rate"]["denominator"] == 4
    # series: today's bucket carries every verification
    assert sum(b["verified"] for b in body["project"]["series"]) == 5
    assert body["project"]["series"][-1]["verified"] == 5
    assert sum(b["rework"] for b in _row(body, "Forge")["series"]) == 1

    # single-agent read matches the table row
    r = await client.get(f"/api/containers/{cid}/metrics/performance/agents/{forge}",
                         params={"range": "30d"})
    assert r.status_code == 200, r.text
    assert r.json()["agent"]["metrics"] == fm

    # the reject event of f2 before the window still breaks first-pass when the
    # approval is in the window: move f2's rejection back 40 days
    db.execute(
        f"UPDATE events SET created_at = {ts_ago(3456000)} WHERE entity_id=%s "
        f"AND event_type='verified' AND NOT {sql.json_bool_is_true('detail', 'approved')}", (f2,))
    fm2 = _row(await _perf(client, cid, "30d"), "Forge")["metrics"]
    assert fm2["first_pass_rate"]["numerator"] == 3          # still not first-pass
    assert fm2["rework"]["total"] == 0                        # but rework counted only in range


@pytest.mark.asyncio
async def test_range_window_excludes_old_verifications(client, container, make_agent, make_task,
                                                       work_headers, db):
    cid = container["id"]
    human = (await make_agent("Owner", kind="human"))["agent_id"]
    forge = (await make_agent("Forge"))["agent_id"]
    old = await _task_verified(client, make_task, work_headers, "Forge", forge, human, title="old")
    await _task_verified(client, make_task, work_headers, "Forge", forge, human, title="new")
    db.execute(f"UPDATE events SET created_at = {ts_ago(1728000)} "
               "WHERE entity_id=%s AND event_type='verified'", (old,))
    assert _row(await _perf(client, cid, "7d"), "Forge")["metrics"]["tasks_verified"] == 1
    assert _row(await _perf(client, cid, "30d"), "Forge")["metrics"]["tasks_verified"] == 2
    all_body = await _perf(client, cid, "all")
    assert all_body["since"] is None and all_body["bucket_days"] == 7
    assert _row(all_body, "Forge")["metrics"]["tasks_verified"] == 2
    assert sum(b["verified"] for b in _row(all_body, "Forge")["series"]) == 2
    b90 = await _perf(client, cid, "90d")
    assert b90["bucket_days"] == 10 and len(b90["project"]["series"]) == 9


@pytest.mark.asyncio
async def test_auto_complete_and_root_are_not_verifications(client, container, make_agent, make_task,
                                                            work_headers, db):
    cid = container["id"]
    human = (await make_agent("Owner", kind="human"))["agent_id"]
    forge = (await make_agent("Forge"))["agent_id"]
    db.execute("UPDATE containers SET autonomy_level='full' WHERE id=%s", (cid,))
    t = (await make_task("auto", "dod", assignee_alias="Forge"))["id"]
    res = await _done(client, work_headers, forge, t)
    assert res["status"] == "completed" and res.get("auto_completed") is True
    # the human verifies the ROOT task (declares the project done)
    await _verify(client, container["root_task_id"], human)
    body = await _perf(client, cid)
    assert body["project"]["metrics"]["tasks_verified"] == 0
    assert _row(body, "Forge")["metrics"]["tasks_verified"] == 0


@pytest.mark.asyncio
async def test_retired_agent_hidden_unless_active(client, container, make_agent, make_task,
                                                  work_headers, db):
    cid = container["id"]
    human = (await make_agent("Owner", kind="human"))["agent_id"]
    forge = (await make_agent("Forge"))["agent_id"]
    ghost = (await make_agent("Ghost"))["agent_id"]
    await _task_verified(client, make_task, work_headers, "Forge", forge, human, title="x")
    db.execute("UPDATE agents SET terminated_at = now() WHERE id IN (%s, %s)", (forge, ghost))
    body = await _perf(client, cid)
    aliases = {a["alias"] for a in body["agents"]}
    assert "Forge" in aliases and "Ghost" not in aliases and "Owner" not in aliases
    assert _row(body, "Forge")["retired"] is True


@pytest.mark.asyncio
async def test_validation_and_not_found(client, container, make_agent):
    cid = container["id"]
    human = (await make_agent("Owner", kind="human"))["agent_id"]
    assert (await client.get("/api/containers/not-a-uuid/metrics/performance")).status_code == 400
    r = await client.get(f"/api/containers/{cid}/metrics/performance", params={"range": "1y"})
    assert r.status_code == 422
    r = await client.get("/api/containers/00000000-0000-0000-0000-000000000000/metrics/performance")
    assert r.status_code == 404
    r = await client.get(f"/api/containers/{cid}/metrics/performance/agents/bad")
    assert r.status_code == 400
    # a HUMAN is not an AI agent for this read
    r = await client.get(f"/api/containers/{cid}/metrics/performance/agents/{human}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_membership_gate(client, container, make_agent, monkeypatch):
    """Trusted proxy login: members (incl. viewers) read, non-members get 403."""
    cid = container["id"]
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    monkeypatch.setenv("ORCHA_PLAN", "team")
    forge = (await make_agent("Forge"))["agent_id"]
    await make_agent("root", "operator", kind="human")
    boss = {"X-Auth-Request-User": "boss"}
    r = await client.get(f"/api/me?cid={cid}", headers=boss)
    assert r.status_code == 200 and r.json()["identity"]["member_role"] == "owner", r.text
    r = await client.post(f"/api/containers/{cid}/members",
                          json={"github_login": "vera", "role": "viewer"}, headers=boss)
    assert r.status_code == 201, r.text
    for who in ("boss", "vera"):
        h = {"X-Auth-Request-User": who}
        ok = await client.get(f"/api/containers/{cid}/metrics/performance", headers=h)
        assert ok.status_code == 200, ok.text
        ok = await client.get(f"/api/containers/{cid}/metrics/performance/agents/{forge}", headers=h)
        assert ok.status_code == 200, ok.text
    stranger = {"X-Auth-Request-User": "mallory"}
    no = await client.get(f"/api/containers/{cid}/metrics/performance", headers=stranger)
    assert no.status_code == 403, no.text
    no = await client.get(f"/api/containers/{cid}/metrics/performance/agents/{forge}", headers=stranger)
    assert no.status_code == 403, no.text


@pytest.mark.asyncio
async def test_openapi_documents_the_routes(client):
    spec = (await client.get("/openapi.json")).json()
    p = spec["paths"]
    assert "/api/containers/{cid}/metrics/performance" in p
    assert "/api/containers/{cid}/metrics/performance/agents/{aid}" in p
    schemas = spec["components"]["schemas"]
    assert "PerformanceResponse" in schemas and "PerfMetrics" in schemas
