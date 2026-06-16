"""FT-SURFACE (B0 / G1) — the shared approval primitive's API contract.

Proves the uniform decision endpoint that every surface (B3 requests, B4 verify +
checkpoint) reuses:
  * approve+reason and reject+reason PERSIST and ROUTE {decision,reason} to the
    target agent (it sees WHY on its next wake, not just yes/no);
  * a reason-less (or blank-reason) reject is blocked BY THE API — not only the UI;
  * only a human may decide;
  * approve may omit a reason;
  * a persisted decision is queryable for audit.
"""
import pytest

pytestmark = pytest.mark.asyncio

from conftest import next_event


async def _human_and_target(make_agent):
    human = await make_agent("Boss", kind="human")
    target = await make_agent("Worker", kind="ai")
    return human["agent_id"], target["agent_id"]


async def test_approve_with_reason_persists_and_routes(client, make_agent, db):
    human_id, target_id = await _human_and_target(make_agent)
    r = await client.post("/api/decisions", json={
        "subject_type": "dummy", "subject_id": "demo-1",
        "decision": "approve", "reason": "ship it",
        "actor_agent_id": human_id, "target_agent_id": target_id,
    })
    assert r.status_code == 201, r.text
    did = r.json()["decision_id"]

    # (a) persisted + queryable for audit
    g = await client.get(f"/api/decisions/{did}")
    assert g.status_code == 200, g.text
    assert g.json()["decision"] == "approve"
    assert g.json()["reason"] == "ship it"
    rows = db.execute("SELECT decision, reason, target_agent_id FROM decisions WHERE id=%s", (did,))
    assert rows and rows[0]["decision"] == "approve" and rows[0]["reason"] == "ship it"

    # (b) routed to the agent: it sees {decision, reason} on its next wake
    # /wait flattens payload to the top level: {event, ts, **payload}
    ev = await next_event(client, target_id, since_ts=0, timeout=3)
    assert ev["event"] == "decision_made", ev
    assert ev["decision"] == "approve"
    assert ev["reason"] == "ship it"
    assert ev["subject_type"] == "dummy"
    assert ev["decision_id"] == did


async def test_reject_with_reason_routes_the_reason(client, make_agent, db):
    human_id, target_id = await _human_and_target(make_agent)
    r = await client.post("/api/decisions", json={
        "subject_type": "task_verify", "subject_id": "t-9",
        "decision": "reject", "reason": "tests are missing",
        "actor_agent_id": human_id, "target_agent_id": target_id,
    })
    assert r.status_code == 201, r.text
    did = r.json()["decision_id"]
    assert db.execute("SELECT reason FROM decisions WHERE id=%s", (did,))[0]["reason"] == "tests are missing"

    ev = await next_event(client, target_id, since_ts=0, timeout=3)
    assert ev["event"] == "decision_made"
    assert ev["decision"] == "reject"
    assert ev["reason"] == "tests are missing"


async def test_reject_without_reason_blocked_by_api(client, make_agent, db):
    human_id, target_id = await _human_and_target(make_agent)
    r = await client.post("/api/decisions", json={
        "subject_type": "dummy", "subject_id": "demo-2",
        "decision": "reject",  # no reason
        "actor_agent_id": human_id, "target_agent_id": target_id,
    })
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "reason_required"
    # nothing persisted, nothing routed
    assert db.execute("SELECT 1 FROM decisions") == []
    ev = await next_event(client, target_id, since_ts=0, timeout=1)
    assert ev["event"] == "timeout", ev


async def test_reject_with_blank_reason_blocked_by_api(client, make_agent, db):
    human_id, target_id = await _human_and_target(make_agent)
    r = await client.post("/api/decisions", json={
        "subject_type": "dummy", "subject_id": "demo-3",
        "decision": "reject", "reason": "   ",  # whitespace only
        "actor_agent_id": human_id, "target_agent_id": target_id,
    })
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "reason_required"
    assert db.execute("SELECT 1 FROM decisions") == []


async def test_actor_must_be_human(client, make_agent, db):
    not_human = await make_agent("Imposter", kind="ai")
    target = await make_agent("Worker", kind="ai")
    r = await client.post("/api/decisions", json={
        "subject_type": "dummy", "subject_id": "demo-4",
        "decision": "approve", "reason": "ok",
        "actor_agent_id": not_human["agent_id"], "target_agent_id": target["agent_id"],
    })
    assert r.status_code == 403, r.text
    assert db.execute("SELECT 1 FROM decisions") == []


async def test_approve_reason_optional(client, make_agent):
    human_id, target_id = await _human_and_target(make_agent)
    r = await client.post("/api/decisions", json={
        "subject_type": "dummy", "subject_id": "demo-5",
        "decision": "approve",  # no reason — allowed on approve
        "actor_agent_id": human_id, "target_agent_id": target_id,
    })
    assert r.status_code == 201, r.text
    assert r.json()["reason"] is None


async def test_decision_no_target_persists_without_event(client, make_agent, db):
    human = await make_agent("Boss", kind="human")
    r = await client.post("/api/decisions", json={
        "subject_type": "dummy", "subject_id": "demo-6",
        "decision": "approve", "reason": "noted",
        "actor_agent_id": human["agent_id"],  # no target_agent_id
    })
    assert r.status_code == 201, r.text
    did = r.json()["decision_id"]
    assert db.execute("SELECT 1 FROM decisions WHERE id=%s", (did,))
    # no target → nothing in the bus
    assert db.execute("SELECT 1 FROM agent_events WHERE event_name='decision_made'") == []


async def test_get_unknown_decision_404_and_bad_uuid_400(client):
    assert (await client.get("/api/decisions/not-a-uuid")).status_code == 400
    assert (await client.get("/api/decisions/00000000-0000-0000-0000-000000000000")).status_code == 404
