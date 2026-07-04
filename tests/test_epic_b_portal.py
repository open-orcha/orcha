"""Epic B — portal control surface: backend contracts the portal relies on.

Covers the two slices implemented first:

  P0  the over-length message fix — POST /api/tasks/{tid}/messages with a body
      past MAX_PAYLOAD_LEN now returns a CLEAR 413 (error='body_too_long',
      field/limit/got) instead of the old silently-swallowed 422. Non-length
      validation errors still return the standard 422.

  P1  the verify/reject contract the new portal buttons drive — approve →
      completed (+ task_verified event to the assignee), reject → back to
      in_progress with the feedback posted to the thread as a human (NULL-author)
      message and a task_verified{approved:false} event. Human-only is enforced;
      verifying a non-needs_verification task is a 409.

  P2  the READ-ONLY close-implications aggregation — GET /api/tasks/{tid}/
      close-implications returns downstream tasks (+ would_unblock), in-flight
      agents, spawned-from provenance, open assignee requests, and a summary
      (with completes_container for the root). Mutates nothing.

These exercise the SHIPPED app imported by conftest (templates/portal/main.py).
"""
import uuid

import pytest
from conftest import next_event

pytestmark = pytest.mark.asyncio

MAX = 4000  # mirrors MAX_PAYLOAD_LEN / Field(max_length=...) on TaskMessage.body


async def _done_task(client, make_agent, make_task, work_headers):
    """Helper: a task an AI worker has marked done → needs_verification, plus the
    human who will verify it. Returns (human_id, worker_id, task_id)."""
    human = await make_agent("Operator", kind="human")
    worker = await make_agent("Worker")
    task = await make_task("ship it", "it is shipped", assignee_alias="Worker")
    tid = task["id"]
    r = await client.post(f"/api/tasks/{tid}/done",
                          json={"agent_id": worker["agent_id"], "result": "did the thing"},
                          headers=await work_headers(worker["agent_id"]))
    assert r.status_code == 200, r.text
    return human["agent_id"], worker["agent_id"], tid


# ---------------------------------------------------------------- P0: 413 fix

async def test_oversize_message_returns_clear_413(client, make_agent, make_task):
    worker = await make_agent("Worker")
    task = await make_task("t", "d", assignee_alias="Worker")
    tid = task["id"]
    r = await client.post(f"/api/tasks/{tid}/messages",
                          json={"author_agent_id": worker["agent_id"], "body": "x" * (MAX + 1)})
    assert r.status_code == 413, r.text
    body = r.json()
    assert body["error"] == "body_too_long"
    assert body["field"] == "body"
    assert body["limit"] == MAX
    assert body["got"] == MAX + 1
    assert "split" in body["detail"].lower()


async def test_message_at_exactly_the_cap_is_accepted(client, make_agent, make_task):
    worker = await make_agent("Worker")
    task = await make_task("t", "d", assignee_alias="Worker")
    tid = task["id"]
    r = await client.post(f"/api/tasks/{tid}/messages",
                          json={"author_agent_id": worker["agent_id"], "body": "x" * MAX})
    assert r.status_code == 201, r.text


async def test_non_length_validation_still_422(client, make_task):
    # A missing required field is NOT a length problem — must keep the 422 contract
    # (and not be mis-reported as body_too_long).
    task = await make_task("t", "d")
    tid = task["id"]
    r = await client.post(f"/api/tasks/{tid}/messages", json={})  # no `body`
    assert r.status_code == 422, r.text
    assert "detail" in r.json()


# ----------------------------------------------------------- P1: verify/reject

async def test_verify_approve_completes_and_notifies(client, make_agent, make_task, db, work_headers):
    human_id, worker_id, tid = await _done_task(client, make_agent, make_task, work_headers)
    r = await client.post(f"/api/tasks/{tid}/verify",
                          json={"approve": True, "actor_agent_id": human_id})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "completed"
    row = db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]
    assert row["status"] == "completed"
    # the assignee is pushed a task_verified{approved:true} event (portal/agent rely on it).
    # Drain the earlier task_assigned (from assignment-at-creation) and poll past it.
    assigned = await next_event(client, worker_id)
    assert assigned["event"] == "task_assigned"
    ev = await next_event(client, worker_id, since_ts=assigned["ts"])
    assert ev["event"] == "task_verified"
    assert ev["task_id"] == tid and ev["approved"] is True


async def test_verify_reject_sends_back_with_feedback(client, make_agent, make_task, db, work_headers):
    human_id, worker_id, tid = await _done_task(client, make_agent, make_task, work_headers)
    r = await client.post(f"/api/tasks/{tid}/verify",
                          json={"approve": False, "feedback": "missing tests", "actor_agent_id": human_id})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "in_progress"
    row = db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]
    assert row["status"] == "in_progress"
    # feedback is posted to the thread as a human (NULL-author) message
    msgs = db.execute(
        "SELECT author_id, body FROM task_messages WHERE task_id=%s ORDER BY created_at", (tid,))
    assert any(m["author_id"] is None and "missing tests" in m["body"] for m in msgs)
    assigned = await next_event(client, worker_id)
    assert assigned["event"] == "task_assigned"
    ev = await next_event(client, worker_id, since_ts=assigned["ts"])
    assert ev["event"] == "task_verified" and ev["approved"] is False
    assert ev["feedback"] == "missing tests"


async def test_verify_requires_human_actor(client, make_agent, make_task, work_headers):
    _, worker_id, tid = await _done_task(client, make_agent, make_task, work_headers)
    # an AI agent cannot verify — the _require_kind(...,'human') gate the portal
    # identity picker is built around must hold server-side too.
    r = await client.post(f"/api/tasks/{tid}/verify",
                          json={"approve": True, "actor_agent_id": worker_id})
    assert r.status_code == 403, r.text


async def test_verify_rejected_when_not_awaiting_verification(client, make_agent, make_task):
    human = await make_agent("Operator", kind="human")
    await make_agent("Worker")
    task = await make_task("t", "d", assignee_alias="Worker")  # in_progress, not done
    r = await client.post(f"/api/tasks/{task['id']}/verify",
                          json={"approve": True, "actor_agent_id": human["agent_id"]})
    assert r.status_code == 409, r.text


# ------------------------------------------------ P2: close-implications (RO)

async def test_close_implications_aggregates_blast_radius(client, make_agent, make_task):
    await make_agent("Worker")
    t = await make_task("base", "d", assignee_alias="Worker")          # in_progress, Worker working
    t2 = await make_task("sibling-dep", "d")                            # an unrelated other dep
    d1 = await make_task("downstream-solo", "d", depends_on=[t["id"]])  # completing t alone readies it
    d2 = await make_task("downstream-two", "d", depends_on=[t["id"], t2["id"]])  # still blocked on t2

    r = await client.get(f"/api/tasks/{t['id']}/close-implications")
    assert r.status_code == 200, r.text
    body = r.json()
    ds = {x["task_id"]: x for x in body["downstream_tasks"]}
    assert set(ds) == {d1["id"], d2["id"]}            # t2 is NOT downstream of t
    assert ds[d1["id"]]["would_unblock"] is True
    assert ds[d2["id"]]["would_unblock"] is False
    assert body["summary"]["would_unblock"] == 1
    assert body["summary"]["still_blocked"] == 1
    assert any(a["alias"] == "Worker" for a in body["in_flight_agents"])
    assert body["summary"]["in_flight_agents"] == 1
    assert body["summary"]["completes_container"] is False


async def test_close_implications_surfaces_assignee_open_requests(client, make_agent, make_task, make_request):
    worker = await make_agent("Worker")
    await make_agent("Peer")
    t = await make_task("base", "d", assignee_alias="Worker")
    # an assignee with an open outgoing request → flagged as an orphan risk
    await make_request(worker["agent_id"], "Worker asks Peer something", target_alias="Peer")
    body = (await client.get(f"/api/tasks/{t['id']}/close-implications")).json()
    assert body["summary"]["open_requests"] == 1
    assert body["open_requests_from_assignees"][0]["requester_alias"] == "Worker"


async def test_close_implications_root_flags_container_completion(client, container):
    r = await client.get(f"/api/tasks/{container['root_task_id']}/close-implications")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["is_root"] is True
    assert body["summary"]["completes_container"] is True


async def test_close_implications_bad_uuid_400(client):
    r = await client.get("/api/tasks/not-a-uuid/close-implications")
    assert r.status_code == 400, r.text


async def test_close_implications_unknown_task_404(client):
    r = await client.get(f"/api/tasks/{uuid.uuid4()}/close-implications")
    assert r.status_code == 404, r.text
