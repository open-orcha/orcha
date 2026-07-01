"""GH #27 — scheduled tasks (a task that re-fires on a fixed interval).

A task with `schedule_interval_secs` runs once like any task; `schedule_interval_secs`
seconds after it COMPLETES, `POST /api/containers/{cid}/fire-due-schedules` (called each
notifier tick) re-arms it back to 'ready', re-opens its assignment, and publishes a
task_assigned event so the normal auto-start wake re-fires it to the same owner.

The re-fire is keyed off completed_at, so it never overlaps itself (no re-fire while
in_progress / needs_verification) and is idempotent across concurrent ticks.
"""
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))
from orcha_cli import notifier  # noqa: E402


def test_tick_fires_due_schedules_before_scan(monkeypatch):
    """The notifier drives the re-arm: each non-dry tick POSTs fire-due-schedules so a re-armed
    task surfaces in the same wake-scan pass."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append(url) or {})
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": []})
    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True)
    assert any("fire-due-schedules" in u for u in posts)


def test_tick_dry_run_does_not_fire_schedules(monkeypatch):
    """--dry-run must not mutate state — no re-arm POST."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append(url) or {})
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": []})
    notifier.tick("http://x", "cid", dry_run=True, cooldown=15, min_idle=0, quiet=True)
    assert not any("fire-due-schedules" in u for u in posts)


async def _complete(client, tid, dev_id, human_id):
    """Drive a task assigned-to-dev → completed via the real done+verify flow."""
    d = await client.post(f"/api/tasks/{tid}/done", json={"agent_id": dev_id, "result": "ran"})
    assert d.status_code == 200, d.text
    v = await client.post(f"/api/tasks/{tid}/verify",
                          json={"approve": True, "actor_agent_id": human_id})
    assert v.status_code == 200 and v.json()["status"] == "completed", v.text


def _status(db, tid):
    return db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]["status"]


def _backdate_completion(db, tid, secs_ago):
    db.execute("UPDATE tasks SET completed_at = now() - make_interval(secs => %s) WHERE id=%s",
               (float(secs_ago), tid))


async def test_create_persists_and_echoes_schedule(client, container, db):
    r = await client.post(f"/api/containers/{container['id']}/tasks",
                          json={"title": "heartbeat", "definition_of_done": "posted",
                                "schedule_interval_secs": 300})
    assert r.status_code == 201, r.text
    assert r.json()["schedule_interval_secs"] == 300
    tid = r.json()["task_id"]
    row = db.execute("SELECT schedule_interval_secs FROM tasks WHERE id=%s", (tid,))[0]
    assert row["schedule_interval_secs"] == 300


async def test_create_rejects_sub_minute_interval(client, container):
    r = await client.post(f"/api/containers/{container['id']}/tasks",
                          json={"title": "too fast", "definition_of_done": "x",
                                "schedule_interval_secs": 30})
    assert r.status_code == 422, r.text   # ge=60 floor


async def test_due_scheduled_task_re_arms_and_rewakes_owner(client, container, make_agent, make_task, db):
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    t = await make_task("nightly", "done", assignee_alias="dev")   # assigned → in_progress
    tid = t["task_id"]
    db.execute("UPDATE tasks SET schedule_interval_secs=300 WHERE id=%s", (tid,))
    await _complete(client, tid, dev["agent_id"], human["agent_id"])
    assert _status(db, tid) == "completed"
    # assignment closed out on completion
    assert db.execute("SELECT assignment_status FROM agent_tasks WHERE task_id=%s", (tid,))[0]["assignment_status"] == "done"

    _backdate_completion(db, tid, secs_ago=301)                    # interval elapsed since completion
    r = await client.post(f"/api/containers/{container['id']}/fire-due-schedules")
    assert r.status_code == 200 and r.json()["fired"] == [tid], r.text
    assert _status(db, tid) == "ready"                             # re-armed
    assert db.execute("SELECT assignment_status FROM agent_tasks WHERE task_id=%s", (tid,))[0]["assignment_status"] == "assigned"

    # the re-armed task is an assigned-ready auto-start target → the owner is woken again
    w = await client.get(f"/api/containers/{container['id']}/wake-scan", params={"min_idle": 0})
    cand = next(c for c in w.json()["candidates"] if c["agent_id"] == dev["agent_id"])
    assert tid in cand["auto_start_task_ids"]


async def test_not_yet_due_is_not_re_armed(client, container, make_agent, make_task, db):
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    t = await make_task("hourly", "done", assignee_alias="dev")
    tid = t["task_id"]
    db.execute("UPDATE tasks SET schedule_interval_secs=3600 WHERE id=%s", (tid,))
    await _complete(client, tid, dev["agent_id"], human["agent_id"])
    _backdate_completion(db, tid, secs_ago=60)                     # only 60s of a 3600s interval
    r = await client.post(f"/api/containers/{container['id']}/fire-due-schedules")
    assert r.json()["fired"] == []
    assert _status(db, tid) == "completed"                         # stays completed


async def test_non_scheduled_task_never_re_armed(client, container, make_agent, make_task, db):
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    t = await make_task("one-shot", "done", assignee_alias="dev")  # no schedule
    tid = t["task_id"]
    await _complete(client, tid, dev["agent_id"], human["agent_id"])
    _backdate_completion(db, tid, secs_ago=99999)
    r = await client.post(f"/api/containers/{container['id']}/fire-due-schedules")
    assert r.json()["fired"] == []
    assert _status(db, tid) == "completed"


async def test_paused_container_does_not_re_arm(client, container, make_agent, make_task, db):
    """GH #24 invariant: a paused/stopped workspace must not resurrect completed work. The
    re-arm no-ops while the container isn't 'active' (wake-scan suppresses wakes off the same
    gate, so firing here would bypass /orcha-pause + /orcha-stop)."""
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    t = await make_task("paused-job", "done", assignee_alias="dev")
    tid = t["task_id"]
    db.execute("UPDATE tasks SET schedule_interval_secs=300 WHERE id=%s", (tid,))
    await _complete(client, tid, dev["agent_id"], human["agent_id"])
    _backdate_completion(db, tid, secs_ago=301)                    # due
    db.execute("UPDATE containers SET status='paused' WHERE id=%s", (container["id"],))

    r = await client.post(f"/api/containers/{container['id']}/fire-due-schedules")
    assert r.status_code == 200 and r.json()["fired"] == [], r.text
    assert r.json().get("skipped") == "container_not_active"
    assert _status(db, tid) == "completed"                         # NOT resurrected
    # assignment stays closed out; the owner is not re-woken
    assert db.execute("SELECT assignment_status FROM agent_tasks WHERE task_id=%s",
                      (tid,))[0]["assignment_status"] == "done"

    # resuming the container lets the same due task re-arm on the next call
    db.execute("UPDATE containers SET status='active' WHERE id=%s", (container["id"],))
    r2 = await client.post(f"/api/containers/{container['id']}/fire-due-schedules")
    assert r2.json()["fired"] == [tid], r2.text
    assert _status(db, tid) == "ready"


async def test_scheduled_task_cannot_depend_on_others(client, container, make_task):
    """GH #27 / dependency-gate safety: a scheduled task re-arms completed→ready, so it can't
    sit on the consumer side of a dependency edge — rejected at create (400)."""
    blocker = await make_task("blocker", "done")
    r = await client.post(f"/api/containers/{container['id']}/tasks",
                          json={"title": "sched-with-dep", "definition_of_done": "x",
                                "schedule_interval_secs": 300,
                                "depends_on": [blocker["task_id"]]})
    assert r.status_code == 400, r.text
    assert "schedule" in r.json()["detail"].lower()


async def test_scheduled_task_cannot_be_a_dependency(client, container):
    """The other edge direction: nothing may depend ON a scheduled task — its periodic re-arm
    means it never stays 'completed' to satisfy a downstream gate. Rejected at create (400)."""
    # make_task has no schedule kwarg, so create the scheduled task directly
    r0 = await client.post(f"/api/containers/{container['id']}/tasks",
                           json={"title": "real-sched", "definition_of_done": "x",
                                 "schedule_interval_secs": 300})
    assert r0.status_code == 201, r0.text
    sched_tid = r0.json()["task_id"]
    r = await client.post(f"/api/containers/{container['id']}/tasks",
                          json={"title": "depends-on-sched", "definition_of_done": "x",
                                "depends_on": [sched_tid]})
    assert r.status_code == 400, r.text
    assert "scheduled task" in r.json()["detail"].lower()


async def test_re_arm_is_idempotent(client, container, make_agent, make_task, db):
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    t = await make_task("idem", "done", assignee_alias="dev")
    tid = t["task_id"]
    db.execute("UPDATE tasks SET schedule_interval_secs=300 WHERE id=%s", (tid,))
    await _complete(client, tid, dev["agent_id"], human["agent_id"])
    _backdate_completion(db, tid, secs_ago=301)
    first = await client.post(f"/api/containers/{container['id']}/fire-due-schedules")
    assert first.json()["fired"] == [tid]
    # second call: the task is now 'ready' (not completed), so nothing re-fires again
    second = await client.post(f"/api/containers/{container['id']}/fire-due-schedules")
    assert second.json()["fired"] == []
    assert _status(db, tid) == "ready"
