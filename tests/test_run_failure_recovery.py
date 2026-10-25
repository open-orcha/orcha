"""Retry storms, visible provider errors, and restart recovery on a disposable DB."""

import json

import pytest

from portal_backend import sql

ERROR = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"
OUTPUT = "\n".join([
    json.dumps({"type": "system", "subtype": "api_retry"}),
    json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": ERROR}]}}),
    json.dumps({"type": "result", "is_error": True, "result": ERROR}),
])


async def finish(client, aid, *, code=1, event="request_created", **fields):
    started = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral", "wake_event": event})
    assert started.status_code == 201, started.text
    rid = started.json()["run_id"]
    body = {"status": "exited", "exit_code": code, "output": OUTPUT, **fields}
    response = await client.post(f"/api/runs/{rid}/finish", json=body)
    assert response.status_code == 200, response.text
    return rid, body


async def scan(client, cid, aid):
    response = await client.get(f"/api/containers/{cid}/wake-scan?cooldown=0&min_idle=0")
    assert response.status_code == 200, response.text
    return next(c for c in response.json()["candidates"] if c["agent_id"] == aid)


async def test_failed_runs_back_off_then_pause_once_across_triggers(client, container, make_agent, make_task, db):
    human = await make_agent("owner", kind="human")
    aid = (await make_agent("Builder"))["agent_id"]
    await make_task("Build", "Reviewed", assignee_alias="Builder")
    cid = container["id"]
    for n, event in enumerate(("request_created", "task_assigned", "self_wake"), 1):
        rid, body = await finish(client, aid, event=event)
        # Re-delivery of a finish must not add a strike or another human request.
        await client.post(f"/api/runs/{rid}/finish", json=body)
        for _ in range(4):
            c = await scan(client, cid, aid)
            assert not c["should_wake"]
        state = db.execute("SELECT * FROM wake_backoff WHERE agent_id=%s AND wake_key='run_failure'", (aid,))[0]
        assert state["strikes"] == n
        claim = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_kind": "ephemeral"})
        assert claim.json()["claimed"] is False
        if n < 3:
            delay = (state["suppressed_until"] - state["last_strike_at"]).total_seconds()
            assert 29 <= delay <= 31 if n == 1 else 59 <= delay <= 61
            db.execute("UPDATE wake_backoff SET suppressed_until=%s WHERE agent_id=%s", (sql.ago(1), aid))
            assert (await scan(client, cid, aid))["should_wake"]
        else:
            assert c["failure_paused"]
            # The circuit is not a timer that a restart or an elapsed cooldown can clear.
            db.execute("UPDATE wake_backoff SET suppressed_until=%s WHERE agent_id=%s", (sql.ago(86400), aid))
            assert not (await scan(client, cid, aid))["should_wake"]
    requests = db.execute("SELECT * FROM requests WHERE requester_id=%s", (aid,))
    assert len(requests) == 1
    assert str(requests[0]["target_id"]) == human["agent_id"]
    assert ERROR in requests[0]["payload"]
    snap = (await client.get(f"/api/containers/{cid}")).json()
    assert any(str(r["id"]) == str(requests[0]["id"]) and r["status"] == "open" for r in snap["requests"])
    # Only a human release resets the circuit, even after the wake reason changes.
    path = f"/api/containers/{cid}/agents/{aid}/wake-backoff/run_failure"
    assert (await client.request("DELETE", path, json={"actor_agent_id": aid})).status_code == 403
    assert (await client.request("DELETE", path, json={"actor_agent_id": human["agent_id"]})).status_code == 200
    assert (await scan(client, cid, aid))["should_wake"]


async def test_success_resets_failure_streak_and_other_agent_keeps_working(client, container, make_agent, make_task, db):
    aid = (await make_agent("Builder"))["agent_id"]
    other = (await make_agent("Other"))["agent_id"]
    await make_task("Build", "Done", assignee_alias="Builder")
    await make_task("Other work", "Done", assignee_alias="Other")
    await finish(client, aid, event="task_assigned")
    assert (await scan(client, container["id"], other))["should_wake"]
    await finish(client, aid, code=0, event="task_assigned")
    assert not db.execute("SELECT * FROM wake_backoff WHERE agent_id=%s AND wake_key='run_failure'", (aid,))
    await finish(client, aid, event="task_assigned")
    assert db.execute("SELECT strikes FROM wake_backoff WHERE agent_id=%s AND wake_key='run_failure'", (aid,))[0]["strikes"] == 1
    db.execute("UPDATE wake_backoff SET suppressed_until=%s WHERE agent_id=%s", (sql.ago(1), aid))
    for _ in range(4):
        assert (await scan(client, container["id"], aid))["should_wake"]


@pytest.mark.parametrize("output", [OUTPUT, json.dumps({"type": "turn.failed", "error": {"message": ERROR}}), ERROR])
async def test_run_feed_exposes_real_error_for_existing_history(client, make_agent, db, output):
    aid = (await make_agent("Builder"))["agent_id"]
    rid, _ = await finish(client, aid, output=output)
    # Read-time derivation also repairs old rows without rewriting their history.
    rows = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"]
    assert next(r for r in rows if r["run_id"] == rid)["failure_reason"] == ERROR


@pytest.mark.parametrize("terminal,assigned,stop", [(False, True, False), (True, True, False), (False, False, False), (False, True, True)])
async def test_restart_requeues_only_unfinished_owned_work_once(client, container, make_agent, make_task, db, terminal, assigned, stop):
    aid = (await make_agent("Builder"))["agent_id"]
    task = await make_task("Recover me", "Reviewed", assignee_alias="Builder")
    tid = task["id"]
    db.execute("UPDATE tasks SET status=%s WHERE id=%s", ("completed" if terminal else "in_progress", tid))
    if not assigned:
        db.execute("DELETE FROM agent_tasks WHERE task_id=%s", (tid,))
    # Simulate the original directive having been delivered before the daemon died.
    c = await scan(client, container["id"], aid)
    await client.post(f"/api/agents/{aid}/events/ack-handled", json={"event_ids": c["handled_event_ids"]})
    started = await client.post(f"/api/agents/{aid}/runs", json={"task_id": tid, "pid": 2000000})
    rid = started.json()["run_id"]
    if stop:
        db.execute("UPDATE worker_runs SET stop_requested_at=now() WHERE run_id=%s", (rid,))
    body = {"status": "killed", "exit_code": -1, "kill_reason": json.dumps({"cause": "host_process_missing_after_notifier_restart"})}
    for _ in range(2):
        response = await client.post(f"/api/runs/{rid}/finish", json=body)
        assert response.status_code == 200, response.text
    events = db.execute("SELECT payload FROM agent_events WHERE event_key=%s AND payload->>'interrupted_run_id'=%s", (aid, rid))
    eligible = not terminal and assigned and not stop
    assert len(events) == int(eligible)
    if eligible:
        c = await scan(client, container["id"], aid)
        assert c["should_wake"]
        assert c["context_task_id"] == tid
        assert c["handled_event_ids"]  # acked only when the replacement turn succeeds
    assert not db.execute("SELECT * FROM wake_backoff WHERE agent_id=%s AND wake_key='run_failure'", (aid,))


def test_error_extraction_ignores_tool_failures_and_retry_noise():
    from portal_backend.run_failure_text import last_error
    tool = json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "content": "Error: test failed"}]}})
    assert last_error(tool) is None
    assert last_error(OUTPUT + "\n" + tool + '\n{"type":"system","subtype":"api_retry"}') == ERROR
