"""ISS-42 (B12, reject-loop) — reject/cancel must not be a dead-end.

A rejected task-request or a human-forced task-cancel wakes the affected agent via a machine
event (`task_request_rejected` / `decision_made`), but those events carry NO content that the
wake/drain turn surfaces — only `prompt`/`task_message` events are injected into the agent's turn
(`_collect_directed_messages`), and a rejected request never shows in the `outbox?status=answered`
drain. So pre-fix the agent woke to nothing actionable and exited: the reason + path forward were
lost (the dead-end). The fix piggybacks the A3 `prompt` poke so the affected agent re-engages with
the reason and concrete next steps. These tests assert the poke lands (and DOESN'T when it
shouldn't), which is the teeth: revert the wiring and they go red.
"""
import pytest

pytestmark = pytest.mark.asyncio


def _task_payload(title="do work", dod="done"):
    return {"title": title, "definition_of_done": dod, "priority": 100}


def _poke_messages(db, agent_id):
    rows = db.execute(
        "SELECT payload FROM agent_events WHERE event_key=%s AND event_name='prompt' ORDER BY ts",
        (agent_id,))
    return [(r["payload"] or {}).get("message") or "" for r in rows]


# ---------- reject-task: the requester gets an actionable path forward ----------

async def test_reject_task_pokes_requester_with_reason_and_paths(client, make_agent, make_request, db):
    a = await make_agent("Requester", kind="ai")
    b = await make_agent("Target", kind="ai")
    req = await make_request(a["agent_id"], "build Y", target_alias="Target",
                             type="task", task=_task_payload())
    rid = req["request_id"]
    r = await client.post(f"/api/requests/{rid}/reject-task",
                          json={"responder_agent_id": b["agent_id"], "reason": "out of scope"})
    assert r.status_code == 200, r.text
    assert r.json()["requester_poked"] is True

    msgs = _poke_messages(db, a["agent_id"])
    assert len(msgs) == 1, "requester should be poked exactly once on reject"
    m = msgs[0]
    assert "out of scope" in m                 # the reason reached them
    assert rid in m                            # the request id, so they can act on THIS one
    # all three paths forward are surfaced (re-ask / suggest-agent / escalate)
    assert "/orcha-ask" in m and "/orcha-suggest-agent" in m and "/orcha-escalate" in m
    # the poke is point-to-point: it must NOT also land on the rejecter
    assert _poke_messages(db, b["agent_id"]) == []


async def test_reject_task_poke_handles_blank_reason(client, make_agent, make_request, db):
    a = await make_agent("Requester", kind="ai")
    b = await make_agent("Target", kind="ai")
    req = await make_request(a["agent_id"], "build", target_alias="Target",
                             type="task", task=_task_payload())
    r = await client.post(f"/api/requests/{req['request_id']}/reject-task",
                          json={"responder_agent_id": b["agent_id"], "reason": ""})
    assert r.status_code == 200, r.text
    msgs = _poke_messages(db, a["agent_id"])
    assert len(msgs) == 1 and "(no reason given)" in msgs[0]


# ---------- cancel-task: the owner gets closure + a path forward (only when forced) ----------

async def test_human_force_cancel_pokes_owner(client, make_agent, make_task, db):
    human = await make_agent("Boss", kind="human")
    worker = await make_agent("Worker", kind="ai")
    task = await make_task("ship it", "done when X", assignee_alias="Worker")
    r = await client.post(f"/api/tasks/{task['id']}/cancel",
                          json={"actor_agent_id": human["agent_id"], "reason": "deprioritised"})
    assert r.status_code == 200, r.text
    assert r.json()["owners_poked"] == 1

    msgs = _poke_messages(db, worker["agent_id"])
    assert len(msgs) == 1, "owner should be poked once on a forced cancel"
    m = msgs[0]
    assert "deprioritised" in m                 # the reason
    assert task["id"] in m                       # which task
    assert "/orcha-task-new" in m                # the path forward
    # the canceller is not poked
    assert _poke_messages(db, human["agent_id"]) == []


async def test_self_cancel_does_not_poke(client, make_agent, make_task, db):
    """An assignee cancelling its OWN task isn't a dead-end (it chose to) — no poke, no decision."""
    worker = await make_agent("Worker", kind="ai")
    task = await make_task("t", "dod", assignee_alias="Worker")
    r = await client.post(f"/api/tasks/{task['id']}/cancel",
                          json={"actor_agent_id": worker["agent_id"]})
    assert r.status_code == 200, r.text
    assert r.json()["owners_poked"] == 0
    assert _poke_messages(db, worker["agent_id"]) == []
