"""Retry storms, visible provider errors, and restart recovery on a disposable DB."""

import json
import types
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

import main
from orcha_cli.notifier_worker_results import drain_task_failure
from portal_backend import sql, worker_run_support

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


async def test_failure_reason_survives_run_detail_pruning_and_summary_view(client, make_agent, make_task, db, monkeypatch):
    # Main's retention cuts older runs to their output tail; the provider error is in that tail.
    monkeypatch.setattr(worker_run_support, "RUN_DETAIL_KEEP_PER_AGENT", 1)
    aid = (await make_agent("Builder"))["agent_id"]
    task = await make_task("do it", "done when X", assignee_alias="Builder")
    started = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral", "wake_event": "task_assigned", "task_id": task["id"]})
    rid = started.json()["run_id"]
    noisy = "\n".join(["tool output " + "x" * 200] * 40 + [OUTPUT])
    assert (await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 1, "output": noisy})).status_code == 200
    await finish(client, aid, code=0, output="ok")  # a newer finish prunes the failed run
    assert len(db.execute("SELECT output FROM worker_runs WHERE run_id=%s", (rid,))[0]["output"]) < len(noisy)

    def failed(path):
        return next(r for r in client_rows[path] if r["run_id"] == rid)

    client_rows = {path: (await client.get(path)).json()["runs"] for path in (
        f"/api/agents/{aid}/runs", f"/api/tasks/{task['id']}/runs", f"/api/tasks/{task['id']}/runs?view=summary")}
    assert failed(f"/api/agents/{aid}/runs")["failure_reason"] == ERROR
    assert failed(f"/api/tasks/{task['id']}/runs")["failure_reason"] == ERROR
    summary = failed(f"/api/tasks/{task['id']}/runs?view=summary")
    assert summary["output"] is None and summary["failure_reason"] is None


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


@pytest.mark.parametrize("message,expected", [
    ("aPi ErRoR: unavailable", "aPi ErRoR: unavailable"),
    ("eRrOr: unavailable", "eRrOr: unavailable"),
    ("fAtAl: unavailable", "fAtAl: unavailable"),
    ("The tool returned Error: unavailable", None),
    ("API Error reporting is enabled", None),
])
def test_assistant_error_prefix_after_large_whitespace(message, expected):
    from portal_backend.run_failure_text import last_error

    output = json.dumps({"type": "assistant", "message": {
        "content": [{"type": "text", "text": " \t\n" * 100000 + message}],
    }})
    assert last_error(output) == expected


async def test_late_human_notice_is_claimed_once_even_with_stale_scan_state(client, container, make_agent, db, monkeypatch):
    from portal_backend import run_failure_backoff as breaker
    from portal_backend.database import db_cursor
    aid = (await make_agent("Builder"))["agent_id"]
    with monkeypatch.context() as patch:
        patch.setattr(breaker, "find_actionable_human", lambda *a, **kw: None)
        for _ in range(3):
            await finish(client, aid)
    await make_agent("owner", kind="human")
    with db_cursor() as (conn, cur):
        stale = breaker.failure_state(cur, aid)
        assert stale["notified_at"] is None
        breaker.notify_failure(cur, container["id"], aid, stale, ERROR)
        breaker.notify_failure(cur, container["id"], aid, stale, ERROR)
        conn.commit()
    assert len(db.execute("SELECT id FROM requests WHERE requester_id=%s", (aid,))) == 1


@pytest.mark.parametrize("status,code", [("failed", 1), ("rate_limited", 0), ("rate_limited", None)])
async def test_real_failed_drain_preserves_task_through_pause_and_resume(
    client, container, make_agent, make_task, db, status, code,
):
    human = (await make_agent("owner", kind="human"))["agent_id"]
    aid = (await make_agent("Builder"))["agent_id"]
    tid = (await make_task("Build", "Reviewed", assignee_alias="Builder"))["id"]
    db.execute("UPDATE tasks SET status='in_progress' WHERE id=%s", (tid,))
    failed_drains = {}
    # conftest has already migrated the scratch DB; do not run application startup again.
    with closing(TestClient(main.app)) as sync:
        def post(url, body):
            response = sync.post(url, json=body)
            assert response.status_code < 300, response.text
            return response.json()

        # Exercise the real finish, ack, scan and resume routes. Only local process/artifact
        # housekeeping is replaced: this test never starts a notifier or a worker.
        services = types.SimpleNamespace(
            _finish_run=lambda base, rid, status, code, log, diff, **kw: post(
                f"/api/runs/{rid}/finish", {"status": status, "exit_code": code, "output": OUTPUT, **kw},
            ),
            _post_json=post, _reap_sandbox_artifacts=lambda w: None,
            _saved_ref=lambda *a: {}, _record_task_saved_ref=lambda *a: None,
            _retire_headless=lambda *a: None, _parse_rate_limit_reset=lambda *a: 30,
            FAILED_DRAIN_MAX=3,
        )
        for n in range(3):
            candidate = await scan(client, container["id"], aid)
            assert candidate["should_wake"], candidate
            assert candidate["context_task_id"] == tid
            run = await client.post(f"/api/agents/{aid}/runs", json={"task_id": tid})
            assert run.status_code == 201
            worker = {"run_id": run.json()["run_id"], "wake_ack_ts": candidate["ack_through_ts"]}
            drain_task_failure(
                "", worker, aid, tid, status, code, None, failed_drains=failed_drains,
                agent_hold_until={}, now=0, quiet=True, lane="work", live_workers={},
                pid=1, drain_desc="drained", services=services,
            )
            state = db.execute("SELECT strikes FROM wake_backoff WHERE agent_id=%s AND wake_key='run_failure'", (aid,))
            assert state and state[0]["strikes"] == n + 1
            db.execute("UPDATE wake_backoff SET suppressed_until=%s WHERE agent_id=%s", (sql.ago(1), aid))
        paused = await scan(client, container["id"], aid)
        assert paused["failure_paused"] and not paused["should_wake"]
        response = await client.request(
            "DELETE", f"/api/containers/{container['id']}/agents/{aid}/wake-backoff/run_failure",
            json={"actor_agent_id": human},
        )
        assert response.status_code == 200, response.text
        resumed = await scan(client, container["id"], aid)
        assert resumed["should_wake"], resumed
        assert resumed["context_task_id"] == tid
        assert resumed["pending_events"] > 0
        assert db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]["status"] == "in_progress"


@pytest.mark.parametrize("status", ["failed", "rate_limited"])
@pytest.mark.parametrize("code", [0, None])
async def test_terminal_failure_with_no_error_exit_keeps_cause_for_late_notice(
    client, container, make_agent, db, status, code,
):
    aid = (await make_agent("Builder"))["agent_id"]
    for _ in range(3):
        await finish(client, aid, status=status, code=code)
    state = db.execute("SELECT * FROM wake_backoff WHERE agent_id=%s AND wake_key='run_failure'", (aid,))
    assert state and state[0]["strikes"] == 3
    assert not db.execute("SELECT id FROM requests WHERE requester_id=%s", (aid,))
    await make_agent("owner", kind="human")
    await scan(client, container["id"], aid)
    notice = db.execute("SELECT payload FROM requests WHERE requester_id=%s", (aid,))
    assert len(notice) == 1 and ERROR in notice[0]["payload"]


@pytest.mark.parametrize("recipient_role,grants", [("owner", []), ("member", ["manage_autonomy"])])
async def test_pause_notice_recipient_can_actually_resume(
    client, container, make_agent, db, monkeypatch, recipient_role, grants,
):
    recipient = (await make_agent("resumer", kind="human"))["agent_id"]
    member = (await make_agent("member", kind="human"))["agent_id"]
    aid = (await make_agent("Builder"))["agent_id"]
    db.execute("UPDATE agents SET github_login='resumer-login', member_role=%s, grants=%s WHERE id=%s",
               (recipient_role, json.dumps(grants), recipient))
    db.execute("UPDATE agents SET github_login='member-login', member_role='member', grants='[]', last_heartbeat_at=now() WHERE id=%s", (member,))
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    for _ in range(3):
        await finish(client, aid)
    notice = db.execute("SELECT target_id FROM requests WHERE requester_id=%s", (aid,))
    assert len(notice) == 1 and str(notice[0]["target_id"]) == recipient
    path = f"/api/containers/{container['id']}/agents/{aid}/wake-backoff/run_failure"
    refused = await client.request("DELETE", path, headers={"X-Auth-Request-User": "member-login"}, json={"actor_agent_id": member})
    assert refused.status_code == 403
    resumed = await client.request("DELETE", path, headers={"X-Auth-Request-User": "resumer-login"}, json={"actor_agent_id": recipient})
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["released"] is True
