"""FT-SURFACE (B7 / ISS-23) — human authority to close/cancel ANY task or request.

A kind=human actor is the authoritative party: it can abandon a stale request or
force-close a task regardless of owner, and the REASON is routed to the owning agent
via the B0 decision primitive (decision_made{decision:'reject', reason}). Non-humans
keep the owner-only rule (403). Reason is required (API-enforced) when a human closes
something it doesn't own.
"""
import pytest

pytestmark = pytest.mark.asyncio

from conftest import next_event


async def _wait_decision(client, agent_id, timeout=3):
    """The first `decision_made` for this agent, skipping an earlier task_assigned/etc."""
    ev = await next_event(client, agent_id, since_ts=0, timeout=timeout)
    while ev["event"] not in ("decision_made", "timeout"):
        ev = await next_event(client, agent_id, since_ts=ev["ts"], timeout=timeout)
    return ev


async def _wait_prompt(client, agent_id, timeout=3):
    """The first directed `prompt` (the #60 nudge poke) for this agent, skipping
    request_closed / request_created / etc. Returns {"event":"timeout", ...} if none."""
    ev = await next_event(client, agent_id, since_ts=0, timeout=timeout)
    while ev["event"] not in ("prompt", "timeout"):
        ev = await next_event(client, agent_id, since_ts=ev["ts"], timeout=timeout)
    return ev


async def _answered_request(client, make_agent, make_request):
    """A request from owner A to target B, moved to 'answered' (so an owner-close is legal)."""
    a = await make_agent("Owner", kind="ai")
    b = await make_agent("Target", kind="ai")
    req = await make_request(a["agent_id"], "please advise", target_alias="Target")
    r = await client.post(f"/api/requests/{req['id']}/respond",
                          json={"responder_agent_id": b["agent_id"], "response": "advice"})
    assert r.status_code == 200, r.text
    return a, b, req["id"]


# ---------- requests ----------

async def test_human_closes_non_owned_request_and_routes_reason(client, make_agent, make_request, db):
    human = await make_agent("Boss", kind="human")
    owner = await make_agent("Owner", kind="ai")
    await make_agent("Target", kind="ai")
    req = await make_request(owner["agent_id"], "stale ask", target_alias="Target")  # open
    r = await client.post(f"/api/requests/{req['id']}/close",
                          json={"requester_agent_id": human["agent_id"], "reason": "no longer needed"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "closed" and r.json()["forced_by_human"] is True
    # owner learns WHY on next wake
    ev = await _wait_decision(client, owner["agent_id"])
    assert ev["event"] == "decision_made", ev
    assert ev["decision"] == "reject"
    assert ev["reason"] == "no longer needed"
    assert ev["subject_type"] == "request_close"
    assert ev["subject_id"] == req["id"]
    # persisted decision
    assert db.execute("SELECT 1 FROM decisions WHERE subject_type='request_close' AND subject_id=%s",
                      (req["id"],))


async def test_non_human_cannot_close_others_request(client, make_agent, make_request):
    owner = await make_agent("Owner", kind="ai")
    other = await make_agent("Bystander", kind="ai")
    req = await make_request(owner["agent_id"], "ask", target_alias="Bystander")
    r = await client.post(f"/api/requests/{req['id']}/close",
                          json={"requester_agent_id": other["agent_id"], "reason": "x"})
    assert r.status_code == 403, r.text


async def test_human_close_others_request_requires_reason(client, make_agent, make_request, db):
    human = await make_agent("Boss", kind="human")
    owner = await make_agent("Owner", kind="ai")
    await make_agent("Target", kind="ai")
    req = await make_request(owner["agent_id"], "ask", target_alias="Target")
    r = await client.post(f"/api/requests/{req['id']}/close",
                          json={"requester_agent_id": human["agent_id"]})  # no reason
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "reason_required"
    # not closed, nothing routed
    assert db.execute("SELECT 1 FROM decisions WHERE subject_type='request_close'") == []


async def test_owner_closes_own_answered_request_unchanged(client, make_agent, make_request, db):
    owner, target, rid = await _answered_request(client, make_agent, make_request)
    r = await client.post(f"/api/requests/{rid}/close",
                          json={"requester_agent_id": owner["agent_id"]})
    assert r.status_code == 200, r.text
    assert r.json()["forced_by_human"] is False
    # owner closing own item routes no decision
    assert db.execute("SELECT 1 FROM decisions WHERE subject_type='request_close'") == []


# ---------- #60: nudge the agent handling a closed request ----------

async def test_human_close_with_nudge_pokes_target_and_routes_reason(client, make_agent, make_request, db):
    """#60: a human force-closing an ANSWERED request it doesn't own delivers an optional nudge to
    the agent HANDLING it (the target) as a closure-framed `prompt`, while the close REASON still
    routes to the OWNER. Both land; nudged_target=true."""
    human = await make_agent("Boss", kind="human")
    owner, target, rid = await _answered_request(client, make_agent, make_request)
    r = await client.post(f"/api/requests/{rid}/close",
                          json={"requester_agent_id": human["agent_id"],
                                "reason": "superseded", "nudge": "pick up the new thread instead"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "closed" and d["forced_by_human"] is True and d["nudged_target"] is True
    # the TARGET (handler) gets a closure-framed prompt carrying the nudge + closer + request id
    pev = await _wait_prompt(client, target["agent_id"])
    assert pev["event"] == "prompt", pev
    assert "closed by Boss" in pev["message"]
    assert "No further work is needed" in pev["message"]
    assert "pick up the new thread instead" in pev["message"]
    assert rid[:8] in pev["message"]
    assert pev["from_agent_id"] == human["agent_id"]
    # the OWNER still learns WHY via the B0 decision primitive (reason routing unchanged)
    dev = await _wait_decision(client, owner["agent_id"])
    assert dev["event"] == "decision_made" and dev["decision"] == "reject"
    assert dev["reason"] == "superseded" and dev["subject_id"] == rid


async def test_close_without_nudge_pokes_nobody(client, make_agent, make_request, db):
    """#60: no nudge supplied → no prompt to the target, nudged_target=false. (The reason still
    routes to the owner as before — that path is untouched.)"""
    human = await make_agent("Boss", kind="human")
    owner, target, rid = await _answered_request(client, make_agent, make_request)
    r = await client.post(f"/api/requests/{rid}/close",
                          json={"requester_agent_id": human["agent_id"], "reason": "no longer needed"})
    assert r.status_code == 200, r.text
    assert r.json()["nudged_target"] is False
    pev = await _wait_prompt(client, target["agent_id"], timeout=2)
    assert pev["event"] == "timeout", pev   # the handler is never poked


async def test_already_closed_close_with_nudge_sends_no_late_poke(client, make_agent, make_request, db):
    """#60: closing an ALREADY-closed request (idempotent no-op) must NOT fire a late nudge — the
    early-return happens before any poke. The target sees no prompt even though a nudge was passed."""
    owner, target, rid = await _answered_request(client, make_agent, make_request)
    # owner closes its own answered request first (no nudge)
    r1 = await client.post(f"/api/requests/{rid}/close", json={"requester_agent_id": owner["agent_id"]})
    assert r1.status_code == 200 and r1.json().get("already_closed") is not True
    # a human now re-closes WITH a nudge — idempotent no-op, no late poke
    human = await make_agent("Boss", kind="human")
    r2 = await client.post(f"/api/requests/{rid}/close",
                           json={"requester_agent_id": human["agent_id"],
                                 "reason": "x", "nudge": "too late"})
    assert r2.status_code == 200 and r2.json().get("already_closed") is True
    assert r2.json().get("nudged_target") in (None, False)
    pev = await _wait_prompt(client, target["agent_id"], timeout=2)
    assert pev["event"] == "timeout", pev   # no late nudge escaped


async def test_nudge_skipped_when_target_is_the_closer(client, make_agent, make_request, db):
    """#60: when the request's target IS the actor closing it (no distinct handler to inform), the
    nudge is skipped — an agent is never poked about closing its own assignment. nudged_target=false."""
    human = await make_agent("Boss", kind="human")
    owner = await make_agent("Owner", kind="ai")
    req = await make_request(owner["agent_id"], "ask the boss", target_alias="Boss")  # target == human
    r = await client.post(f"/api/requests/{req['id']}/close",
                          json={"requester_agent_id": human["agent_id"],
                                "reason": "handled offline", "nudge": "ignored"})
    assert r.status_code == 200, r.text
    assert r.json()["nudged_target"] is False
    pev = await _wait_prompt(client, human["agent_id"], timeout=2)
    assert pev["event"] == "timeout", pev   # the closer/target is not poked about its own close


# ---------- tasks ----------

async def test_human_force_cancels_task_and_routes_reason(client, make_agent, make_task, db):
    human = await make_agent("Boss", kind="human")
    worker = await make_agent("Worker", kind="ai")
    task = await make_task("do the thing", "done when X", assignee_alias="Worker")
    r = await client.post(f"/api/tasks/{task['id']}/cancel",
                          json={"actor_agent_id": human["agent_id"], "reason": "deprioritised"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "cancelled" and r.json()["forced_by_human"] is True
    ev = await _wait_decision(client, worker["agent_id"])  # skip the task_assigned
    assert ev["event"] == "decision_made"
    assert ev["decision"] == "reject" and ev["reason"] == "deprioritised"
    assert ev["subject_type"] == "task_close" and ev["subject_id"] == task["id"]
    assert db.execute("SELECT status FROM tasks WHERE id=%s", (task["id"],))[0]["status"] == "cancelled"


async def test_ai_orchestrator_cancels_others_task_with_reason(client, make_agent, make_task, db):
    """#327: a non-assignee AI orchestrator may now force-cancel a teammate's task — but, like a
    human, it MUST give a reason, which is routed to the displaced owner (decision + path-forward
    poke). TEETH: restore the 'non-assignee non-human → 403' guard and the with-reason 200 → 403."""
    worker = await make_agent("Worker", kind="ai")
    orch = await make_agent("Orchestrator", kind="ai")
    task = await make_task("do the thing", "done when X", assignee_alias="Worker")
    # no reason → 422 (reason is now required for ANY actor cancelling another's task)
    r = await client.post(f"/api/tasks/{task['id']}/cancel",
                          json={"actor_agent_id": orch["agent_id"]})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "reason_required"
    # with reason → 200, cancelled, forced (but NOT forced_by_human), owner poked
    r = await client.post(f"/api/tasks/{task['id']}/cancel",
                          json={"actor_agent_id": orch["agent_id"], "reason": "superseded by #999"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "cancelled" and d["forced"] is True and d["forced_by_human"] is False
    assert d["owners_poked"] == 1
    # displaced owner learns WHY via the B0 decision primitive
    ev = await _wait_decision(client, worker["agent_id"])
    assert ev["event"] == "decision_made" and ev["decision"] == "reject"
    assert ev["reason"] == "superseded by #999"
    assert ev["subject_type"] == "task_close" and ev["subject_id"] == task["id"]
    assert db.execute("SELECT status FROM tasks WHERE id=%s",
                      (task["id"],))[0]["status"] == "cancelled"


async def test_assignee_cancels_own_task_no_decision(client, make_agent, make_task, db):
    worker = await make_agent("Worker", kind="ai")
    task = await make_task("t", "dod", assignee_alias="Worker")
    r = await client.post(f"/api/tasks/{task['id']}/cancel",
                          json={"actor_agent_id": worker["agent_id"]})
    assert r.status_code == 200, r.text
    assert r.json()["forced_by_human"] is False
    assert db.execute("SELECT 1 FROM decisions WHERE subject_type='task_close'") == []


async def test_human_cancel_others_task_requires_reason(client, make_agent, make_task):
    human = await make_agent("Boss", kind="human")
    await make_agent("Worker", kind="ai")
    task = await make_task("t", "dod", assignee_alias="Worker")
    r = await client.post(f"/api/tasks/{task['id']}/cancel",
                          json={"actor_agent_id": human["agent_id"]})  # no reason
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "reason_required"


async def test_cancel_idempotent_and_completed_409(client, make_agent, make_task, db):
    human = await make_agent("Boss", kind="human")
    worker = await make_agent("Worker", kind="ai")
    task = await make_task("t", "dod", assignee_alias="Worker")
    r1 = await client.post(f"/api/tasks/{task['id']}/cancel",
                           json={"actor_agent_id": human["agent_id"], "reason": "stop"})
    assert r1.status_code == 200
    r2 = await client.post(f"/api/tasks/{task['id']}/cancel",
                           json={"actor_agent_id": human["agent_id"], "reason": "again"})
    assert r2.status_code == 200 and r2.json().get("already_cancelled") is True
    # completed task can't be cancelled
    db.execute("UPDATE tasks SET status='completed' WHERE id=%s", (task["id"],))
    r3 = await client.post(f"/api/tasks/{task['id']}/cancel",
                           json={"actor_agent_id": human["agent_id"], "reason": "late"})
    assert r3.status_code == 409, r3.text


async def test_cancel_bad_uuid_400_and_unknown_404(client, make_agent):
    human = await make_agent("Boss", kind="human")
    assert (await client.post("/api/tasks/not-a-uuid/cancel",
            json={"actor_agent_id": human["agent_id"]})).status_code == 400
    assert (await client.post("/api/tasks/00000000-0000-0000-0000-000000000000/cancel",
            json={"actor_agent_id": human["agent_id"], "reason": "x"})).status_code == 404


async def test_root_task_cannot_be_cancelled(client, container, make_agent, db):
    """Review P2: cancelling the root would wedge container completion — must be 409."""
    human = await make_agent("Boss", kind="human")
    r = await client.post(f"/api/tasks/{container['root_task_id']}/cancel",
                          json={"actor_agent_id": human["agent_id"], "reason": "stop"})
    assert r.status_code == 409, r.text
    # root untouched, container still active
    assert db.execute("SELECT status FROM tasks WHERE id=%s",
                      (container["root_task_id"],))[0]["status"] != "cancelled"
    assert db.execute("SELECT status FROM containers WHERE id=%s",
                      (container["id"],))[0]["status"] == "active"


async def test_cancel_clears_assignee_working_status(client, make_agent, make_task, db):
    """Review P2: a cancelled task's assignee must not stay 'working'."""
    human = await make_agent("Boss", kind="human")
    worker = await make_agent("Worker", kind="ai")
    task = await make_task("t", "dod", assignee_alias="Worker")
    # claimed-on-assign → working
    assert db.execute("SELECT status FROM agents WHERE id=%s",
                      (worker["agent_id"],))[0]["status"] == "working"
    r = await client.post(f"/api/tasks/{task['id']}/cancel",
                          json={"actor_agent_id": human["agent_id"], "reason": "drop it"})
    assert r.status_code == 200, r.text
    # the stale assignment is cleared and the agent is no longer 'working'
    assert db.execute("SELECT status FROM agents WHERE id=%s",
                      (worker["agent_id"],))[0]["status"] != "working"
    assert db.execute(
        "SELECT 1 FROM agent_tasks WHERE task_id=%s AND assignment_status IN ('assigned','accepted','working')",
        (task["id"],)) == []
