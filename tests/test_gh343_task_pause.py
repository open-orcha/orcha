"""GH #343: a person pauses a task or a whole workflow, and every entry point respects it.

Covers the wake scan, claiming the next task, self-wakes, held messages and answers,
nudges, stopping a live run, the restart after the run cap, people-only controls and the
workflow cascade (pause everything, resume only what the workflow paused).
"""

import types

from orcha_cli import notifier_checkpoint
from portal_backend import sql
from portal_backend import workflow_service as ws
from portal_backend.database import db_cursor
from portal_backend.task_pause import pause_task
from portal_backend.wake_scan_queries import WorkflowParking
from test_workflows import create, prepare_and_start, setup_workflow  # noqa: F401 (fixture)


async def candidate(client, cid, aid):
    response = await client.get(f"/api/containers/{cid}/wake-scan?cooldown=0&min_idle=0")
    assert response.status_code == 200, response.text
    return next(c for c in response.json()["candidates"] if c["agent_id"] == aid)


async def setup(make_agent, make_task):
    human = (await make_agent("Owner", kind="human"))["agent_id"]
    aid = (await make_agent("Builder"))["agent_id"]
    paused = (await make_task("Paused work", "Done", assignee_alias="Builder", priority=1))["id"]
    other = (await make_task("Other work", "Done", assignee_alias="Builder", priority=5))["id"]
    return human, aid, paused, other


def pause(client, tid, actor, reason="Waiting on legal", **kw):
    return client.post(f"/api/tasks/{tid}/pause", json={"actor_agent_id": actor, "reason": reason}, **kw)


def resume(client, tid, actor, **kw):
    return client.post(f"/api/tasks/{tid}/resume", json={"actor_agent_id": actor}, **kw)


async def test_pause_is_saved_shown_and_idempotent_and_status_is_untouched(
    client, container, make_agent, make_task, db,
):
    human, _, tid, _ = await setup(make_agent, make_task)
    before = db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]["status"]
    first = await pause(client, tid, human)
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["paused"] and body["changed"] and body["paused_by"] == human
    assert body["paused_by_alias"] == "Owner" and body["reason"] == "Waiting on legal"
    assert body["via_workflow"] is False and body["paused_at"]
    again = (await pause(client, tid, human, reason="other")).json()
    assert again["changed"] is False and again["reason"] == "Waiting on legal"
    # Saved on the row (a portal or notifier restart reads the same state) and visible.
    row = db.execute("SELECT status, paused_at FROM tasks WHERE id=%s", (tid,))[0]
    assert row["status"] == before and row["paused_at"] is not None
    state = (await client.get(f"/api/tasks/{tid}/pause")).json()
    assert state["paused"] and state["paused_by_alias"] == "Owner"
    listed = (await client.get(f"/api/containers/{container['id']}/tasks?limit=100")).json()["tasks"]
    card = next(t for t in listed if str(t["id"]) == tid)
    assert card["paused_at"] and card["paused_by_alias"] == "Owner" and card["paused_reason"] == "Waiting on legal"

    lifted = (await resume(client, tid, human)).json()
    assert lifted["changed"] and not lifted["paused"] and lifted["paused_at"] is None
    assert db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]["status"] == before
    assert (await resume(client, tid, human)).json()["changed"] is False


async def test_only_a_person_can_pause_or_resume(client, container, make_agent, make_task):
    human, aid, tid, _ = await setup(make_agent, make_task)
    assert (await pause(client, tid, aid)).status_code == 403
    token = {"X-Orcha-Run-Token": "agent-run-token"}
    assert (await pause(client, tid, human, headers=token)).status_code == 403
    assert (await pause(client, tid, human)).status_code == 200
    assert (await resume(client, tid, aid)).status_code == 403
    assert (await resume(client, tid, human, headers=token)).status_code == 403
    assert (await client.get(f"/api/tasks/{tid}/pause")).json()["paused"] is True


async def test_finished_and_root_tasks_cannot_be_paused(client, container, make_agent, make_task, db):
    human, _, tid, _ = await setup(make_agent, make_task)
    db.execute("UPDATE tasks SET status='completed' WHERE id=%s", (tid,))
    assert (await pause(client, tid, human)).status_code == 409
    root = db.execute("SELECT id FROM tasks WHERE container_id=%s AND is_root", (container["id"],))
    if root:
        assert (await pause(client, str(root[0]["id"]), human)).status_code == 409


async def test_wake_scan_skips_the_paused_task_and_keeps_the_agents_other_work(
    client, container, make_agent, make_task, db,
):
    human, aid, paused, other = await setup(make_agent, make_task)
    assert (await pause(client, paused, human)).status_code == 200
    scan = await candidate(client, container["id"], aid)
    assert scan["should_wake"] and scan["context_task_id"] == other
    # With the other task gone too, the paused task alone never wakes the agent.
    db.execute("UPDATE tasks SET status='completed' WHERE id=%s", (other,))
    db.execute("DELETE FROM agent_events WHERE event_key=%s", (aid,))
    idle = await candidate(client, container["id"], aid)
    assert not idle["should_wake"] and idle["context_task_id"] != paused

    assert (await resume(client, paused, human)).status_code == 200
    woken = await candidate(client, container["id"], aid)
    assert woken["should_wake"] and woken["context_task_id"] == paused


async def test_claim_next_skips_a_paused_task_and_takes_the_next_one(
    client, container, make_agent, make_task, db,
):
    human, aid, paused, other = await setup(make_agent, make_task)
    db.execute("UPDATE tasks SET status='ready' WHERE id IN (%s,%s)", (paused, other))
    minted = await client.post(f"/api/agents/{aid}/embodiment-tokens", json={"lane": "work", "kind": "headless"})
    work = {"X-Orcha-Run-Token": minted.json()["run_token"]}

    async def claim_next():
        response = await client.post(f"/api/agents/{aid}/next", headers=work)
        assert response.status_code == 200, response.text
        return response.json()["task"]

    assert (await pause(client, paused, human)).status_code == 200
    assert (await claim_next())["id"] == other
    assert await claim_next() is None
    assert (await resume(client, paused, human)).status_code == 200
    assert (await claim_next())["id"] == paused


async def test_messages_and_self_wakes_wait_while_paused_then_arrive_on_resume(
    client, container, make_agent, make_task, db,
):
    human, aid, paused, other = await setup(make_agent, make_task)
    db.execute("UPDATE tasks SET status='in_progress' WHERE id=%s", (paused,))
    db.execute("UPDATE tasks SET status='completed' WHERE id=%s", (other,))
    db.execute("DELETE FROM agent_events WHERE event_key=%s", (aid,))
    assert (await pause(client, paused, human)).status_code == 200
    sent = await client.post(f"/api/tasks/{paused}/messages", json={"author_agent_id": human, "body": "Any update?"})
    assert sent.status_code == 201, sent.text
    db.execute(
        "INSERT INTO agent_self_wake(agent_id,task_id,resume_at,context) VALUES (%s,%s,%s,'check back')",
        (aid, paused, sql.ago(60)),
    )
    delivery = (await client.get(f"/api/tasks/{paused}/messages/delivery")).json()
    assert delivery["recipients"][0]["state"] == "wake_disabled_or_paused"
    assert "paused this task" in delivery["recipients"][0]["reason"]

    held = await candidate(client, container["id"], aid)
    assert not held["should_wake"]
    assert not held.get("self_wake_due")
    assert not db.execute("SELECT * FROM agent_event_acks WHERE agent_id=%s", (aid,))

    assert (await resume(client, paused, human)).status_code == 200
    ready = await candidate(client, container["id"], aid)
    assert ready["should_wake"] and ready["context_task_id"] == paused
    names = {e["id"]: e["event_name"] for e in db.event_rows(aid)}
    handled = [names[i] for i in ready["handled_event_ids"] if i in names]
    assert "task_message" in handled


async def test_answers_and_nudges_for_a_paused_task_wait(
    client, container, make_agent, make_task, make_request, db,
):
    human, aid, paused, other = await setup(make_agent, make_task)
    db.execute("UPDATE tasks SET status='in_progress' WHERE id=%s", (paused,))
    db.execute("UPDATE tasks SET status='completed' WHERE id=%s", (other,))
    asked = await make_request(aid, "Which logo should I use?", target_alias="Owner",
                               originating_task_id=paused)
    db.execute("DELETE FROM agent_events WHERE event_key=%s", (aid,))
    assert (await pause(client, paused, human)).status_code == 200
    answered = await client.post(f"/api/requests/{asked['id']}/respond", json={
        "responder_agent_id": human, "response": "The blue one"})
    assert answered.status_code == 200, answered.text
    assert not (await candidate(client, container["id"], aid))["should_wake"]
    nudge = await client.post(f"/api/requests/{asked['id']}/nudge", json={"actor_agent_id": human})
    assert nudge.status_code == 409 and "paused task" in nudge.text

    assert (await resume(client, paused, human)).status_code == 200
    ready = await candidate(client, container["id"], aid)
    assert ready["should_wake"] and ready["context_task_id"] == paused


async def test_pausing_stops_a_live_run_on_that_task_only(
    client, container, make_agent, make_task, db,
):
    human, aid, paused, other = await setup(make_agent, make_task)
    runs = {}
    for tid in (paused, other):
        run = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral", "task_id": tid})
        assert run.status_code == 201, run.text
        runs[tid] = run.json()["run_id"]
    body = (await pause(client, paused, human)).json()
    assert body["stopped_runs"] == [runs[paused]]
    stop = {str(r["run_id"]): r["stop_requested_at"] for r in db.execute(
        "SELECT run_id, stop_requested_at FROM worker_runs WHERE agent_id=%s", (aid,))}
    assert stop[runs[paused]] is not None and stop[runs[other]] is None


async def test_restart_after_the_run_cap_does_not_respawn_a_paused_task(
    client, container, make_agent, make_task, monkeypatch,
):
    human, _, paused, other = await setup(make_agent, make_task)
    assert (await pause(client, paused, human)).status_code == 200
    states = {
        tid: (await client.get(f"/api/tasks/{tid}/pause")).json() for tid in (paused, other)
    }
    services = types.SimpleNamespace(_get_json=lambda url: states[url.rsplit("/", 2)[-2]])
    assert notifier_checkpoint._task_paused("http://x", paused, services) is True
    assert notifier_checkpoint._task_paused("http://x", other, services) is False
    # An unreachable portal is treated like the ordinary wake: the server re-checks.
    assert notifier_checkpoint._task_paused("http://x", other, types.SimpleNamespace(_get_json=lambda url: None)) is False


def test_workflow_pause_pauses_every_open_task_and_resume_lifts_only_its_own(setup_workflow):
    cid, actor, worker, other_human, hooks, execute = setup_workflow
    w = prepare_and_start(setup_workflow, create(setup_workflow, mode="parallel", count=3))
    first, second, third = (t["id"] for t in w["tasks"])
    with db_cursor() as (_, cur):
        cur.execute("UPDATE tasks SET status='completed' WHERE id=%s", (third,))
        cur.execute("SELECT * FROM tasks WHERE id=%s", (second,))
        pause_task(cur, cur.fetchone(), other_human, "Mine")  # a person's own pause first

    execute("pause", {}, w["id"])
    with db_cursor() as (_, cur):
        cur.execute("SELECT id, paused_at, paused_via_workflow, paused_by FROM tasks WHERE workflow_id=%s", (w["id"],))
        rows = {str(r["id"]): r for r in cur.fetchall()}
    assert rows[first]["paused_at"] and rows[first]["paused_via_workflow"]
    assert rows[second]["paused_at"] and not rows[second]["paused_via_workflow"]
    assert str(rows[second]["paused_by"]) == other_human
    assert rows[third]["paused_at"] is None  # finished tasks are left alone

    snapshot = execute("resume", {}, w["id"])
    with db_cursor() as (_, cur):
        cur.execute("SELECT id, paused_at FROM tasks WHERE workflow_id=%s", (w["id"],))
        rows = {str(r["id"]): r for r in cur.fetchall()}
    assert rows[first]["paused_at"] is None
    assert rows[second]["paused_at"] is not None  # the person's own pause stays
    byid = {t["id"]: t for t in snapshot["tasks"]}
    assert not any(b["code"] == "task_paused" for b in byid[first].get("blockers", []))


def test_a_paused_workflow_task_is_parked_with_a_clear_reason(setup_workflow):
    cid, actor, worker, other_human, hooks, execute = setup_workflow
    w = prepare_and_start(setup_workflow, create(setup_workflow, mode="parallel", count=1))
    tid = w["tasks"][0]["id"]
    with db_cursor() as (_, cur):
        cur.execute("SELECT * FROM tasks WHERE id=%s", (tid,))
        pause_task(cur, cur.fetchone(), other_human, None)
        assert WorkflowParking(cur, worker).parked(tid) is True
        snapshot = ws.WorkflowService(cur, hooks).snapshot(w["id"])
    choice = snapshot["eligibility"][tid]
    assert not choice["can_start"]
    assert any(b["code"] == "task_paused" for b in choice["blockers"])
