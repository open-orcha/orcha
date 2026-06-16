"""ISS-48 — every human-authority decision is reflected in the collaboration THREAD.

Decisions were written only to the `decisions` table + a `decision_made` event. But an
agent's source of truth is the task thread (`task_messages`): on wake it re-reads the thread,
saw no approval, and re-posted its plan forever (Invy task 070d631d approved twice, no PR).
The fix posts a structured, ATTRIBUTED decision message to the task thread when the decision's
subject is a task — for plan_approval/task_verify (via /api/decisions) and task_close (via the
cancel/close path). Non-task subjects (request/checkpoint/dummy) have no task thread → no-op.
Attribution is the human decider's agent_id (NOT a null author, which renders as a human
free-text post — the ISS-43 mislabel).
"""
import pytest

pytestmark = pytest.mark.asyncio


async def _thread(client, tid):
    r = await client.get(f"/api/tasks/{tid}/messages")
    assert r.status_code == 200, r.text
    return r.json()["messages"]


async def test_plan_approval_posts_attributed_message_to_thread(client, make_agent, make_task, db):
    """The critical case: approving a plan lands an attributed APPROVED message in the task
    thread so the woken agent reads it and proceeds (no re-plan loop)."""
    human = await make_agent("Boss", kind="human")
    worker = await make_agent("Worker", kind="ai")
    task = await make_task("build widget", "done when shipped", assignee_alias="Worker")

    r = await client.post("/api/decisions", json={
        "subject_type": "plan_approval", "subject_id": task["id"],
        "decision": "approve", "reason": "plan looks right — go",
        "actor_agent_id": human["agent_id"], "target_agent_id": worker["agent_id"],
    })
    assert r.status_code == 201, r.text

    msgs = await _thread(client, task["id"])
    dec = [m for m in msgs if "DECISION" in m["body"]]
    assert len(dec) == 1, msgs
    m = dec[0]
    assert "plan_approval = APPROVED" in m["body"]
    assert "plan looks right — go" in m["body"]            # reason carried
    # attributed to the human decider — NOT a null author (ISS-43 mislabel guard). is_human now
    # reflects the author's KIND, so a human-authored decision reads as human (review P2: else
    # plan detection `author_id && !is_human` mistakes it for an agent plan).
    assert m["author_id"] == human["agent_id"]
    assert m["is_human"] is True
    assert m["author_alias"] == "Boss"


async def test_plan_rejection_posts_reason_to_thread(client, make_agent, make_task, db):
    """Rejecting a plan lands the REASON in the thread so the agent re-engages (ISS-42)."""
    human = await make_agent("Boss", kind="human")
    worker = await make_agent("Worker", kind="ai")
    task = await make_task("build widget", "done when shipped", assignee_alias="Worker")

    r = await client.post("/api/decisions", json={
        "subject_type": "plan_approval", "subject_id": task["id"],
        "decision": "reject", "reason": "split step 2 out first",
        "actor_agent_id": human["agent_id"], "target_agent_id": worker["agent_id"],
    })
    assert r.status_code == 201, r.text

    msgs = await _thread(client, task["id"])
    dec = [m for m in msgs if "DECISION" in m["body"]]
    assert len(dec) == 1 and "plan_approval = REJECTED" in dec[0]["body"]
    assert "split step 2 out first" in dec[0]["body"]
    assert dec[0]["author_id"] == human["agent_id"] and dec[0]["is_human"] is True


async def test_nontask_subject_posts_no_thread_message(client, make_agent, db):
    """A decision on a non-task subject (dummy/checkpoint/request) has no task thread — it must
    no-op cleanly (and never hit the task_messages FK with a non-task subject_id)."""
    human = await make_agent("Boss", kind="human")
    worker = await make_agent("Worker", kind="ai")
    fake_subject = "11111111-1111-1111-1111-111111111111"   # a valid UUID that is NOT a task
    r = await client.post("/api/decisions", json={
        "subject_type": "dummy", "subject_id": fake_subject,
        "decision": "approve", "reason": "ok",
        "actor_agent_id": human["agent_id"], "target_agent_id": worker["agent_id"],
    })
    assert r.status_code == 201, r.text                    # decision still recorded
    # no task_messages row was created against the non-task subject
    assert db.execute("SELECT 1 FROM task_messages WHERE task_id=%s", (fake_subject,)) == []


async def test_task_close_reason_lands_in_thread(client, make_agent, make_task, db):
    """task_close: a human force-cancelling another agent's task routes the reason through the
    same primitive — it must also appear, attributed, in the task thread."""
    human = await make_agent("Boss", kind="human")
    worker = await make_agent("Worker", kind="ai")
    task = await make_task("build widget", "done when shipped", assignee_alias="Worker")

    r = await client.post(f"/api/tasks/{task['id']}/cancel", json={
        "actor_agent_id": human["agent_id"], "reason": "scope dropped for v1",
    })
    assert r.status_code == 200, r.text

    msgs = await _thread(client, task["id"])
    dec = [m for m in msgs if "DECISION" in m["body"]]
    assert len(dec) == 1 and "task_close = REJECTED" in dec[0]["body"]
    assert "scope dropped for v1" in dec[0]["body"]
    assert dec[0]["author_id"] == human["agent_id"] and dec[0]["is_human"] is True


async def test_decision_message_not_detected_as_agent_plan(client, make_agent, make_task, db):
    """Review P2: a decision message must NOT look like an agent plan. Plan detection
    (tasks.html planMessage / agents taskBlock) treats `author_id && !is_human` as an agent
    plan — a human-authored decision message would wrongly qualify if is_human were derived
    from a null author alone. With is_human keyed to the author's KIND it reads as human, so a
    task whose thread holds ONLY a decision message exposes no spurious 'Approve this plan'."""
    human = await make_agent("Boss", kind="human")
    worker = await make_agent("Worker", kind="ai")
    task = await make_task("build widget", "done when shipped", assignee_alias="Worker")
    r = await client.post("/api/decisions", json={
        "subject_type": "plan_approval", "subject_id": task["id"],
        "decision": "approve", "reason": "go",
        "actor_agent_id": human["agent_id"], "target_agent_id": worker["agent_id"],
    })
    assert r.status_code == 201, r.text
    msgs = await _thread(client, task["id"])
    # the EXACT predicate the frontend uses to pick an agent's plan post
    plan_like = [m for m in msgs if m["author_id"] and not m["is_human"]]
    assert plan_like == [], plan_like        # the decision message must not qualify as a plan


async def test_multi_assignee_close_posts_single_thread_message(client, make_agent, make_task, db):
    """Review P3: _route_close_reason runs once per owning assignee (one decision row + wake
    each); the task-thread mirror must be posted ONCE per close, not stacked per assignee."""
    human = await make_agent("Boss", kind="human")
    w1 = await make_agent("W1", kind="ai")
    w2 = await make_agent("W2", kind="ai")
    task = await make_task("build widget", "done when shipped", assignee_alias="W1")
    db.execute("INSERT INTO agent_tasks (agent_id, task_id, assignment_status) VALUES (%s, %s, 'working')",
               (w2["agent_id"], task["id"]))

    r = await client.post(f"/api/tasks/{task['id']}/cancel", json={
        "actor_agent_id": human["agent_id"], "reason": "scope dropped"})
    assert r.status_code == 200, r.text

    msgs = await _thread(client, task["id"])
    dec = [m for m in msgs if "DECISION" in m["body"]]
    assert len(dec) == 1, dec                # ONE thread message despite two assignees
    # …but each owner still got their own decision row (per-owner audit + routing preserved)
    rows = db.execute("SELECT 1 FROM decisions WHERE subject_type='task_close' AND subject_id=%s",
                      (task["id"],))
    assert len(rows) == 2
