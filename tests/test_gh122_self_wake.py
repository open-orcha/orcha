"""GH #122: self-scheduled one-shot task wakes with restored context."""
import argparse
import json
import pathlib
import sys
import urllib.request

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))
from orcha_cli import __main__ as cli  # noqa: E402
from orcha_cli import notifier  # noqa: E402


async def _scan(client, cid, aid, *, cooldown=0.0, min_idle=0.0):
    r = await client.get(f"/api/containers/{cid}/wake-scan",
                         params={"cooldown": cooldown, "min_idle": min_idle})
    assert r.status_code == 200, r.text
    body = r.json()
    cand = next((c for c in body["candidates"] if c["agent_id"] == aid), None)
    return body, cand


async def _schedule(client, aid, tid, headers, *, context="waiting on CI"):
    return await client.post(
        f"/api/agents/{aid}/self-wake",
        json={"task_id": tid, "delay_secs": 60, "context": context},
        headers=headers,
    )


@pytest.mark.asyncio
async def test_self_wake_requires_work_token_and_active_in_progress_assignee(
        client, container, make_agent, make_task, work_headers):
    a = await make_agent("A")
    b = await make_agent("B")
    task = await make_task("build feature", "done", assignee_alias="A")
    tid = task["task_id"]

    no_token = await client.post(
        f"/api/agents/{a['agent_id']}/self-wake",
        json={"task_id": tid, "delay_secs": 60, "context": "waiting on tests"},
    )
    assert no_token.status_code == 403, no_token.text

    blank = await client.post(
        f"/api/agents/{a['agent_id']}/self-wake",
        json={"task_id": tid, "delay_secs": 60, "context": "   "},
        headers=await work_headers(a["agent_id"]),
    )
    assert blank.status_code == 422, blank.text

    foreign = await _schedule(client, b["agent_id"], tid,
                              await work_headers(b["agent_id"]))
    assert foreign.status_code == 409, foreign.text

    ok = await _schedule(client, a["agent_id"], tid,
                         await work_headers(a["agent_id"]),
                         context="  waiting on test run  ")
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "scheduled"


@pytest.mark.asyncio
async def test_due_self_wake_scans_protocols_and_clears_only_with_task_id(
        client, container, make_agent, make_task, db, work_headers):
    a = await make_agent("A")
    task = await make_task("ship it", "tests pass", assignee_alias="A",
                           description="Implement the feature")
    aid, tid = a["agent_id"], task["task_id"]
    db.execute("DELETE FROM agent_events")

    r = await _schedule(client, aid, tid, await work_headers(aid),
                        context="check the pull request checks")
    assert r.status_code == 200, r.text
    db.execute("UPDATE agent_self_wake SET resume_at=now() - interval '1 second' "
               "WHERE agent_id=%s AND task_id=%s", (aid, tid))

    _, cand = await _scan(client, container["id"], aid)
    assert cand["should_wake"] is True
    assert cand["self_wake_due"] is True
    assert cand["self_wake_injected"] is True
    assert cand["wake_task_id"] == tid
    assert cand["self_wake_task_id"] == tid
    assert "self-scheduled" in cand["reason"]

    proto = await client.get(f"/api/agents/{aid}/protocol", params={"task_id": tid})
    assert proto.status_code == 200, proto.text
    assert proto.json()["resume_context"] == "check the pull request checks"

    no_target = await client.post(f"/api/agents/{aid}/wake-ack",
                                  json={"kind": "ephemeral",
                                        "clear_self_wake": True})
    assert no_target.status_code == 200, no_target.text
    rows = db.execute("SELECT * FROM agent_self_wake WHERE agent_id=%s AND task_id=%s",
                      (aid, tid))
    assert rows, "missing self_wake_task_id must not clear an untargeted row"

    clear = await client.post(f"/api/agents/{aid}/wake-ack",
                              json={"kind": "ephemeral",
                                    "clear_self_wake": True,
                                    "self_wake_task_id": tid})
    assert clear.status_code == 200, clear.text
    assert clear.json()["cleared_self_wake"] is True
    rows = db.execute("SELECT * FROM agent_self_wake WHERE agent_id=%s AND task_id=%s",
                      (aid, tid))
    assert rows == []


@pytest.mark.asyncio
async def test_self_wake_defers_behind_auto_start_and_pending_task_request(
        client, container, make_agent, make_task, make_request, db, work_headers):
    human = await make_agent("Human", kind="human")
    a = await make_agent("A")
    aid = a["agent_id"]
    task_a = await make_task("blocked task", "done", assignee_alias="A")
    tid_a = task_a["task_id"]
    db.execute("DELETE FROM agent_events")
    assert (await _schedule(client, aid, tid_a, await work_headers(aid))).status_code == 200
    db.execute("UPDATE agent_self_wake SET resume_at=now() - interval '1 second' "
               "WHERE agent_id=%s AND task_id=%s", (aid, tid_a))

    ready = await make_task("new ready task", "done")
    assign = await client.post(f"/api/tasks/{ready['task_id']}/assign",
                               json={"actor_agent_id": human["agent_id"],
                                     "agent_id": aid})
    assert assign.status_code == 200, assign.text
    _, cand = await _scan(client, container["id"], aid)
    assert cand["auto_start_task_ids"]
    assert cand["self_wake_due"] is False
    assert cand["self_wake_injected"] is False
    assert db.execute("SELECT * FROM agent_self_wake WHERE agent_id=%s AND task_id=%s",
                      (aid, tid_a))

    db.execute("DELETE FROM agent_tasks WHERE task_id=%s", (ready["task_id"],))
    db.execute("UPDATE tasks SET status='in_progress' WHERE id=%s", (tid_a,))
    requester = await make_agent("Requester")
    req = await make_request(requester["agent_id"], "please do this", target_alias="A",
                             type="task",
                             task={"title": "request task", "definition_of_done": "done"})
    assert req["request_id"]
    _, cand = await _scan(client, container["id"], aid)
    assert cand["has_pending_task_request"] is True
    assert cand["self_wake_due"] is False
    assert cand["self_wake_injected"] is False
    assert db.execute("SELECT * FROM agent_self_wake WHERE agent_id=%s AND task_id=%s",
                      (aid, tid_a))


@pytest.mark.asyncio
async def test_directed_task_without_self_wake_does_not_consume_other_due_row(
        client, container, make_agent, make_task, db, work_headers):
    a = await make_agent("A")
    aid = a["agent_id"]
    task_a = await make_task("blocked task", "done", assignee_alias="A")
    task_b = await make_task("message task", "done", assignee_alias="A")
    tid_a, tid_b = task_a["task_id"], task_b["task_id"]
    db.execute("DELETE FROM agent_events")

    assert (await _schedule(client, aid, tid_a, await work_headers(aid),
                            context="check task A")).status_code == 200
    db.execute("UPDATE agent_self_wake SET resume_at=now() - interval '1 second' "
               "WHERE agent_id=%s AND task_id=%s", (aid, tid_a))
    msg = await client.post(f"/api/tasks/{tid_b}/messages",
                            json={"body": "please inspect task B"})
    assert msg.status_code == 201, msg.text

    _, cand = await _scan(client, container["id"], aid)
    assert cand["wake_task_id"] == tid_b
    assert cand["self_wake_due"] is False
    assert cand["self_wake_injected"] is False
    proto = await client.get(f"/api/agents/{aid}/protocol", params={"task_id": tid_b})
    assert proto.status_code == 200, proto.text
    assert "resume_context" not in proto.json()

    ack = await client.post(f"/api/agents/{aid}/wake-ack",
                            json={"kind": "ephemeral",
                                  "delivered_ts": cand["ack_through_ts"]})
    assert ack.status_code == 200, ack.text
    assert db.execute("SELECT * FROM agent_self_wake WHERE agent_id=%s AND task_id=%s",
                      (aid, tid_a))

    _, next_cand = await _scan(client, container["id"], aid)
    assert next_cand["self_wake_due"] is True
    assert next_cand["wake_task_id"] == tid_a


@pytest.mark.asyncio
async def test_directed_task_with_due_self_wake_clears_only_that_task(
        client, container, make_agent, make_task, db, work_headers):
    a = await make_agent("A")
    aid = a["agent_id"]
    task_a = await make_task("blocked task A", "done", assignee_alias="A")
    task_b = await make_task("blocked task B", "done", assignee_alias="A")
    tid_a, tid_b = task_a["task_id"], task_b["task_id"]
    db.execute("DELETE FROM agent_events")

    headers = await work_headers(aid)
    assert (await _schedule(client, aid, tid_a, headers,
                            context="check task A")).status_code == 200
    assert (await _schedule(client, aid, tid_b, headers,
                            context="check task B")).status_code == 200
    db.execute("UPDATE agent_self_wake SET resume_at=now() - interval '1 second' "
               "WHERE agent_id=%s", (aid,))
    msg = await client.post(f"/api/tasks/{tid_b}/messages",
                            json={"body": "please inspect task B"})
    assert msg.status_code == 201, msg.text

    _, cand = await _scan(client, container["id"], aid)
    assert cand["wake_task_id"] == tid_b
    assert cand["self_wake_due"] is True
    assert cand["self_wake_injected"] is True
    assert cand["self_wake_task_id"] == tid_b
    proto = await client.get(f"/api/agents/{aid}/protocol", params={"task_id": tid_b})
    assert proto.status_code == 200, proto.text
    assert proto.json()["resume_context"] == "check task B"

    ack = await client.post(f"/api/agents/{aid}/wake-ack",
                            json={"kind": "ephemeral",
                                  "delivered_ts": cand["ack_through_ts"],
                                  "clear_self_wake": True,
                                  "self_wake_task_id": tid_b})
    assert ack.status_code == 200, ack.text
    assert not db.execute("SELECT * FROM agent_self_wake WHERE agent_id=%s AND task_id=%s",
                          (aid, tid_b))
    assert db.execute("SELECT * FROM agent_self_wake WHERE agent_id=%s AND task_id=%s",
                      (aid, tid_a))

    _, next_cand = await _scan(client, container["id"], aid)
    assert next_cand["self_wake_due"] is True
    assert next_cand["wake_task_id"] == tid_a


@pytest.mark.asyncio
async def test_done_clears_scheduled_self_wake(
        client, container, make_agent, make_task, db, work_headers):
    a = await make_agent("A")
    aid = a["agent_id"]
    task = await make_task("blocked task", "done", assignee_alias="A")
    tid = task["task_id"]
    headers = await work_headers(aid)
    assert (await _schedule(client, aid, tid, headers,
                            context="check deploy")).status_code == 200
    db.execute("UPDATE agent_self_wake SET resume_at=now() - interval '1 second' "
               "WHERE agent_id=%s AND task_id=%s", (aid, tid))

    done = await client.post(f"/api/tasks/{tid}/done",
                             json={"agent_id": aid, "result": "ready for review"},
                             headers=headers)
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "needs_verification"
    assert not db.execute("SELECT * FROM agent_self_wake WHERE agent_id=%s AND task_id=%s",
                          (aid, tid))

    _, cand = await _scan(client, container["id"], aid)
    assert cand["self_wake_due"] is False


def test_notifier_renders_resume_only_when_scan_bound_self_wake(monkeypatch):
    def fake_get_json(url):
        if url.endswith("/persona"):
            return {"system_prompt": "You are A."}
        if url.endswith("/digest"):
            return {"digest": None}
        if "/protocol" in url:
            return {"task_id": "task-A", "title": "Task A", "description": "D",
                    "definition_of_done": "DoD", "resume_context": "check CI"}
        return None

    monkeypatch.setattr(notifier, "_get_json", fake_get_json)
    rendered, resume_rendered = notifier._build_persona(
        "http://x", "agent-A", task_id="task-A",
        self_wake={"injected": True, "task_id": "task-A"},
        return_resume_rendered=True)
    assert resume_rendered is True
    assert "## Resuming" in rendered
    assert "check CI" in rendered

    suppressed, resume_rendered = notifier._build_persona(
        "http://x", "agent-A", task_id="task-A",
        self_wake={"injected": False, "task_id": "task-A"},
        return_resume_rendered=True, force_fresh=True)
    assert resume_rendered is False
    assert "## Resuming" not in suppressed


def test_notifier_self_wake_prompt_event_and_ack_gate():
    cand = {"alias": "A", "self_wake_due": True, "self_wake_injected": True,
            "self_wake_task_id": "task-A"}
    prompt = notifier.build_wake_prompt(cand)
    assert "self-scheduled task wake" in prompt
    assert "schedule another self-wake" in prompt
    assert notifier.derive_wake_event(cand) == "self_wake"

    assert notifier.self_wake_ack_fields(
        cand, kind="ephemeral", sent=True, resume_rendered=True) == {
            "clear_self_wake": True, "self_wake_task_id": "task-A"}
    assert notifier.self_wake_ack_fields(
        cand, kind="tmux", sent=True, resume_rendered=True) == {}
    assert notifier.self_wake_ack_fields(
        cand, kind="ephemeral", sent=False, resume_rendered=True) == {}
    assert notifier.self_wake_ack_fields(
        cand, kind="ephemeral", sent=True, resume_rendered=False) == {}


class _FakeResponse:
    def __init__(self, data):
        self._data = data

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return json.dumps(self._data).encode()


def _write_cli_binding(root, *, alias="A", agent_id="agent-A"):
    (root / ".claude" / "orcha-tabs").mkdir(parents=True)
    (root / ".claude" / "orcha.json").write_text(
        json.dumps({"api_base_url": "http://orcha.test"}) + "\n")
    (root / ".claude" / "orcha-tabs" / f"{alias}.json").write_text(
        json.dumps({"alias": alias, "agent_id": agent_id}) + "\n")


def test_cli_self_wake_schedules_with_duration_and_work_token(monkeypatch, tmp_path, capsys):
    _write_cli_binding(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ORCHA_ALIAS", "A")
    monkeypatch.setenv("ORCHA_RUN_TOKEN", "run-token")
    seen = {}

    def fake_urlopen(req, timeout):
        seen["url"] = req.full_url
        seen["method"] = req.get_method()
        seen["token"] = req.get_header("X-orcha-run-token")
        seen["body"] = json.loads(req.data.decode())
        return _FakeResponse({"resume_at": "2026-07-12T18:50:00+00:00"})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    cli.cmd_self_wake(argparse.Namespace(
        task_id="task-A", delay="10m", context="  check CI  ", cancel_task_id=None,
        all=False, alias=None))

    assert seen == {
        "url": "http://orcha.test/api/agents/agent-A/self-wake",
        "method": "POST",
        "token": "run-token",
        "body": {"task_id": "task-A", "delay_secs": 600, "context": "check CI"},
    }
    assert "Exit now instead of polling" in capsys.readouterr().out


def test_cli_self_wake_cancel_all_uses_delete(monkeypatch, tmp_path, capsys):
    _write_cli_binding(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ORCHA_ALIAS", "A")
    monkeypatch.setenv("ORCHA_RUN_TOKEN", "run-token")
    seen = {}

    def fake_urlopen(req, timeout):
        seen["url"] = req.full_url
        seen["method"] = req.get_method()
        seen["token"] = req.get_header("X-orcha-run-token")
        return _FakeResponse({"deleted": 2})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    cli.cmd_self_wake(argparse.Namespace(
        task_id=None, delay=None, context=None, cancel_task_id="", all=True, alias=None))

    assert seen == {
        "url": "http://orcha.test/api/agents/agent-A/self-wake?all=true",
        "method": "DELETE",
        "token": "run-token",
    }
    assert "cancelled 2 scheduled wake" in capsys.readouterr().out
