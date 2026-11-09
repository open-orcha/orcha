"""One run's timeline (`GET /api/qa/run-log`): every source in plain words, a tail that reads only new
bytes, the truth about who holds a device, and a read that takes no write lock."""
import datetime as dt
import json
import os
from uuid import uuid4

import pytest

from orcha_cli.qa.device import locks
from portal_backend import qa_run_log as rl
from portal_backend import sql

IPHONE, IPAD = "iPhone 17 Pro", "iPad Pro 13-inch (M5)"


@pytest.fixture
async def team(make_agent, make_task):
    human = await make_agent("Hussein", "owner", kind="human")
    bot = await make_agent("QAEngineer")
    task = await make_task("First run", "Findings in")
    return human["agent_id"], bot["agent_id"], task["id"]


@pytest.fixture(autouse=True)
def fresh(monkeypatch, tmp_path):
    rl._tails.clear()
    monkeypatch.setattr(locks, "LOCK_ROOT", tmp_path)
    monkeypatch.setattr(rl, "machine_pressure", lambda: None)
    monkeypatch.setattr(rl, "_free", {"at": 1.0e12, "rows": [], "busy": False})


def assistant(*blocks, at="2026-11-05T10:00:00.000Z", **more):
    return json.dumps({"type": "assistant", "message": {"content": list(blocks)}, "timestamp": at, **more}) + "\n"


def use(name, **args):
    return {"type": "tool_use", "name": name, "input": args}


def say(text):
    return {"type": "text", "text": text}


def worker(db, bot, tid, status="running", ended=None, log=None, **more):
    rid = str(uuid4())
    cols = {"run_id": rid, "agent_id": bot, "task_id": tid, "status": status, "ended_at": ended, "log_path": log, **more}
    db.execute(f"INSERT INTO worker_runs ({','.join(cols)}) VALUES ({','.join(['%s'] * len(cols))})", tuple(cols.values()))
    return rid


async def session(client, cid, bot, tid):
    r = await client.post(f"/api/containers/{cid}/qa/sessions", json={"actor_agent_id": bot, "kind": "check", "platform": "ios", "task_id": tid})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def read(client, **q):
    r = await client.get("/api/qa/run-log", params=q)
    assert r.status_code == 200, r.text
    return r.json()


def texts(log, level=None):
    return [e["text"] for e in log["entries"] if level is None or e["level"] == level]


# ---------------------------------------------------------------- the agent's words

@pytest.mark.parametrize("name,args,text", [
    ("Read", {"file_path": "/a/secret.swift"}, "Reading the code"),
    ("Grep", {"pattern": "x"}, "Reading the code"),
    ("Bash", {"command": "orcha job --task 1 -- xcodebuild -scheme App build"}, "Building the app"),
    ("Bash", {"command": "xcrun simctl list"}, "Checked the device"),
    ("Bash", {"command": "cd /x && rg foo"}, "Reading the code"),
    ("mcp__orcha-qa__start_session", {}, "Asked for a device"),
    ("mcp__orcha-qa__some_new_tool", {}, "Used some new tool"),
])
def test_a_tool_call_reads_in_plain_words(name, args, text):
    assert rl.tool_words(name, args)["text"] == text


@pytest.mark.parametrize("name", ["TodoWrite", "mcp__orcha-qa__tap", "mcp__orcha-qa__screen"])
def test_what_steps_already_say_is_not_said_twice(name):
    assert rl.tool_words(name, {}) is None


def test_a_command_is_never_shown_only_its_description():
    row = rl.tool_words("Bash", {"command": "curl -H 'Authorization: Bearer abcdefghijklmnop' http://x", "description": "Check the portal"})
    assert "curl" not in json.dumps(row) and "abcdefgh" not in json.dumps(row)
    assert row["detail"] == "Check the portal"


@pytest.mark.parametrize("text", [
    "use token=abc123def456 now", "Bearer abcdefghijklmnopqrstuvwxyz is it", "password: hunter2hunter2",
    "key sk-ant-abcdefghijklmnopqrstuvwxyz", "ghp_abcdefghijklmnopqrstuvwxyz0123",
])
def test_a_secret_never_reaches_a_line(text):
    got = rl.plain(text)
    assert "redacted" in got
    for secret in ("abc123", "abcdefghijklmnop", "hunter2", "ghp_"):
        assert secret not in got


def test_the_old_name_never_reaches_a_line():
    assert rl.plain("Using the Verdikt tools now") == "Using the Embodent tools now"


@pytest.mark.parametrize("text", ['{"a": "b"}', '[{"x": 1}]', "```json\n{}\n```"])
def test_raw_json_is_never_a_line(text):
    assert rl.plain(text) is None


def test_markdown_is_taken_off():
    assert rl.plain("## Plan\n**Build** the `app` then [run](http://x)") == "Plan Build the app then run"


def test_tool_output_and_stream_deltas_are_not_even_parsed(monkeypatch):
    def boom(*_):
        raise AssertionError("parsed")
    monkeypatch.setattr(rl.json, "loads", boom)
    assert rl.lines_of(b'{"type":"stream_event","event":{}}') == []
    assert rl.lines_of(b'{"type":"user","message":{}}') == []


def test_a_helpers_steps_stay_out_and_a_rate_limit_shows():
    assert rl.lines_of(assistant(say("inner"), parent_tool_use_id="t1").encode()) == []
    got = rl.lines_of(json.dumps({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected"}}).encode())
    assert got[0]["level"] == "warn" and "rate limit" in got[0]["text"]


def test_codex_events_read_the_same():
    raw = json.dumps({"type": "item.completed", "item": {"type": "command_execution", "command": "xcodebuild build"}}).encode()
    assert rl.lines_of(raw)[0]["text"] == "Building the app"


# ---------------------------------------------------------------- the tail

def test_a_tail_reads_only_new_bytes_and_counts_up_a_run_of_the_same_tool(tmp_path, monkeypatch):
    log = tmp_path / "QAEngineer-1.log"
    log.write_text(assistant(say("Starting")) + assistant(use("Read")) + assistant(use("Grep")))
    rows = rl.log_rows(str(log), "r" * 8, None, False)
    assert [r["text"] for r in rows] == ["Starting", "Reading the code (2)"]
    tail = rl._tails[str(log)]
    done = tail.offset
    calls = []
    real = rl.lines_of
    monkeypatch.setattr(rl, "lines_of", lambda raw: calls.append(raw) or real(raw))
    rl.log_rows(str(log), "r" * 8, None, False)
    assert calls == [] and tail.offset == done  # nothing new, nothing read
    with open(log, "a") as f:
        f.write(assistant(use("Read")))
    rows = rl.log_rows(str(log), "r" * 8, None, False)
    assert len(calls) == 1 and rows[-1]["text"] == "Reading the code (3)"
    assert rows[-1]["id"] == [r for r in rows if "Reading" in r["text"]][0]["id"]


def test_a_huge_log_is_read_from_its_tail_and_a_half_line_waits(tmp_path):
    log = tmp_path / "w.log"
    log.write_bytes(b'{"type":"stream_event"}\n' * 200_000 + assistant(say("Latest")).encode())
    assert log.stat().st_size > rl.READ_BYTES
    assert [r["text"] for r in rl.log_rows(str(log), "r" * 8, None, False)] == ["Latest"]
    whole = assistant(say("Half"))
    with open(log, "a") as f:
        f.write(whole[:20])
    assert len(rl.log_rows(str(log), "r" * 8, None, False)) == 1
    with open(log, "a") as f:
        f.write(whole[20:])
    assert [r["text"] for r in rl.log_rows(str(log), "r" * 8, None, False)] == ["Latest", "Half"]


def test_a_line_too_long_to_read_is_skipped_to_its_end(tmp_path):
    log = tmp_path / "w.log"
    log.write_text('{"type":"assistant","x":"' + "y" * (rl.READ_BYTES // 2))
    assert rl.log_rows(str(log), "r" * 8, None, False) == []
    with open(log, "a") as f:
        f.write("y" * 100 + '"}\n' + assistant(say("After")))
    assert [r["text"] for r in rl.log_rows(str(log), "r" * 8, None, False)] == ["After"]


# ---------------------------------------------------------------- the timeline

async def test_a_task_nobody_picked_up_says_so(client, container, team):
    _, _, tid = team
    log = await read(client, task_id=tid)
    assert "session_id" not in log
    assert log["live"] is True
    assert log["now"]["state"] in ("blocked", "waiting") and log["now"]["text"]
    assert "This run was started" in texts(log)


async def test_the_whole_story_of_a_run_in_order(client, container, team, db, tmp_path):
    human, bot, tid = team
    cid = container["id"]
    path = tmp_path / "QAEngineer-1.log"
    path.write_text(assistant(say("I will **check** the app"), use("Bash", command="orcha job -- xcodebuild build")))
    worker(db, bot, tid, log=str(path))
    log = await read(client, task_id=tid)
    assert "QAEngineer picked it up" in texts(log)
    assert "I will check the app" in texts(log) and "Building the app" in texts(log)
    assert log["now"] == {**log["now"], "state": "building", "text": "Building the app"}
    assert not any(c in json.dumps(texts(log)) for c in ("xcodebuild", "tool_use"))
    sid = await session(client, cid, bot, tid)
    await client.post(f"/api/qa/sessions/{sid}/steps", json={"actor_agent_id": bot, "steps": [
        {"seq": 1, "kind": "tap", "args": {"target": "Done"}, "result": "ok"},
        {"seq": 2, "kind": "type", "args": {"target": "Email", "text": "me@secret.example"}, "result": "ok"},
        {"seq": 3, "kind": "screen", "args": {}, "result": "ok"},
    ]})
    r = await client.post(f"/api/qa/sessions/{sid}/findings", json={"actor_agent_id": bot, "severity": "major", "title": "Save does nothing"})
    assert r.status_code == 201, r.text
    await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": bot, "status": "done"})
    log = await read(client, session_id=sid)
    got = texts(log)
    assert "Tapped Done" in got and "Typed into Email" in got
    assert "secret.example" not in json.dumps(log)
    assert "Found a major problem: Save does nothing" in texts(log, "warn")
    assert any(t.startswith("The session finished · 3 steps") for t in texts(log, "done"))
    stamps = [e["at"] for e in log["entries"]]
    assert stamps == sorted(stamps)


async def test_a_killed_worker_says_why_in_words_with_its_cost(client, container, team, db):
    _, bot, tid = team
    worker(db, bot, tid, status="killed", ended=sql.utcnow(), kill_reason=json.dumps({"cause": "stalled"}), total_cost_usd=1.234)
    log = await read(client, task_id=tid)
    assert "QAEngineer was stopped: it stopped producing anything for too long" in texts(log, "warn")


async def test_a_failed_start_with_no_steps_still_shows(client, container, team):
    _, bot, tid = team
    sid = await session(client, container["id"], bot, tid)
    await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": bot, "status": "failed", "result": {"error": "No simulator is booted."}})
    log = await read(client, task_id=tid)
    assert "No simulator is booted." in texts(log, "error")
    assert "session_id" not in log  # nothing to watch: the page stays and says why


async def test_a_managed_job_shows_with_its_status(client, container, team, db):
    _, bot, tid = team
    run = worker(db, bot, tid)
    jid = str(uuid4())
    db.execute("""INSERT INTO managed_jobs (job_id, task_id, job_key, launch_nonce, owner_run_id, state, budget_until)
                  VALUES (%s,%s,%s,%s,%s,'running',%s)""", (jid, tid, str(uuid4()), str(uuid4()), run, sql.utcnow() + dt.timedelta(hours=1)))
    log = await read(client, task_id=tid)
    assert "A background job started" in texts(log) and log["now"]["text"] == "A background job is running"
    db.execute("UPDATE managed_jobs SET state='interrupted' WHERE job_id=%s", (jid,))
    assert "A background job was interrupted" in texts(await read(client, task_id=tid), "warn")


async def test_a_question_the_agent_asked_blocks_the_headline(client, container, team, db):
    human, bot, tid = team
    rid = str(uuid4())
    db.execute("""INSERT INTO requests (id, container_id, type, requester_id, target_id, status, payload, originating_task_id)
                  VALUES (%s,%s,'info',%s,%s,'open',%s,%s)""", (rid, container["id"], bot, human, "Which account should I use?", tid))
    worker(db, bot, tid)
    log = await read(client, task_id=tid)
    assert "QAEngineer asked: Which account should I use?" in texts(log, "wait")
    assert log["now"]["state"] == "blocked" and log["now"]["request_id"] == rid
    assert log["now"]["text"] == "QAEngineer is waiting for an answer"


async def test_the_stage_of_opening_the_device_is_the_headline_until_it_is_open(client, container, team, db):
    _, bot, tid = team
    worker(db, bot, tid)
    r = await client.post(f"/api/containers/{container['id']}/qa/sessions", json={"actor_agent_id": bot, "kind": "map", "platform": "ios", "task_id": tid})
    sid = r.json()["id"]
    r = await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": bot, "starting": "Connecting to iPhone 17 Pro"})
    assert r.status_code == 200, r.text
    log = await read(client, task_id=tid)
    assert log["now"]["text"] == "Connecting to iPhone 17 Pro"
    r = await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": bot, "starting": "", "device_name": "iPhone 17 Pro"})
    assert r.status_code == 200, r.text
    log = await read(client, task_id=tid)
    assert log["now"]["text"] != "Connecting to iPhone 17 Pro"
    assert not any("Connecting to" in e["text"] for e in log["entries"])


async def test_after_brings_only_what_is_new(client, container, team, db):
    _, bot, tid = team
    worker(db, bot, tid)
    first = await read(client, task_id=tid)
    assert first["cursor"]
    later = (dt.datetime.fromisoformat(first["cursor"]) + dt.timedelta(seconds=rl.OVERLAP_S + 60)).isoformat()
    assert (await read(client, task_id=tid, after=later))["entries"] == []


async def test_a_read_needs_a_run_and_a_member(client, container, team):
    assert (await client.get("/api/qa/run-log")).status_code == 400
    assert (await client.get("/api/qa/run-log", params={"task_id": "nope"})).status_code == 400
    assert (await client.get("/api/qa/run-log", params={"task_id": str(uuid4())})).status_code == 404


async def test_a_session_decides_when_a_task_from_elsewhere_is_given(client, container, team, make_task):
    _, bot, tid = team
    sid = await session(client, container["id"], bot, tid)
    other = (await make_task("Other", "x"))["id"]
    assert (await read(client, session_id=sid, task_id=other))["task_id"] == tid


# ---------------------------------------------------------------- the device

async def wait_on(client, bot, sid, device=IPHONE, **more):
    r = await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": bot, "waiting": {
        "device": device, "reason": f"Waiting for {device}.", "devices": [device], **more}})
    assert r.status_code == 200, r.text


async def test_a_device_with_no_owner_file_is_said_as_it_is(client, container, team, tmp_path):
    _, bot, tid = team
    sid = await session(client, container["id"], bot, tid)
    (tmp_path / "claude-sim-lock-iPhone-17-Pro").mkdir()  # Xcode, or another tool's bare mkdir
    await wait_on(client, bot, sid)
    log = await read(client, task_id=tid)
    assert log["now"]["state"] == "waiting" and log["now"]["text"] == "Waiting for iPhone 17 Pro · held by another tool"
    assert log["now"]["device"] == IPHONE and log["now"]["since"]
    line = next(e for e in log["entries"] if e["level"] == "wait")
    assert "no owner record" in line["detail"] and IPHONE in line["detail"]


async def test_a_device_held_by_a_run_names_it(client, container, team, tmp_path):
    _, bot, tid = team
    sid = await session(client, container["id"], bot, tid)
    locks.set_holder(project="snug-log", kind="check")
    held = locks.claim(IPHONE)
    try:
        await wait_on(client, bot, sid)
        assert (await read(client, task_id=tid))["now"]["held_by"] == "snug-log's check run"
    finally:
        held.release()
        locks.set_holder()


async def test_a_free_device_is_offered_and_a_person_can_send_the_run_there(client, container, team, monkeypatch):
    human, bot, tid = team
    sid = await session(client, container["id"], bot, tid)
    (locks.LOCK_ROOT / "claude-sim-lock-iPhone-17-Pro").mkdir()
    await wait_on(client, bot, sid)
    monkeypatch.setattr(rl, "_free", {"at": 1.0e12, "busy": False, "rows": [
        {"kind": "ios", "name": IPHONE, "held_by": {"device": IPHONE}}, {"kind": "ios", "name": IPAD, "held_by": None}]})
    log = await read(client, task_id=tid)
    assert log["now"]["free_device"] == IPAD and log["now"]["session_id"] == sid
    assert (await client.post(f"/api/qa/sessions/{sid}/use-device", json={"actor_agent_id": bot, "device": IPAD})).status_code == 403
    r = await client.post(f"/api/qa/sessions/{sid}/use-device", json={"actor_agent_id": human, "device": IPAD})
    assert r.status_code == 200, r.text
    log = await read(client, task_id=tid)
    assert log["now"]["moving_to"] == IPAD and log["now"]["text"].startswith(f"Moving to {IPAD}")


async def test_only_a_run_in_line_can_be_moved(client, container, team):
    human, bot, tid = team
    sid = await session(client, container["id"], bot, tid)
    r = await client.post(f"/api/qa/sessions/{sid}/use-device", json={"actor_agent_id": human, "device": IPAD})
    assert r.status_code == 409


def test_the_list_of_devices_never_runs_on_a_poll(monkeypatch):
    started = []

    class Fake:
        def __init__(self, **_):
            pass

        def start(self):
            started.append(True)

    monkeypatch.setattr(rl.threading, "Thread", Fake)
    monkeypatch.setattr(rl, "_free", {"at": 0.0, "rows": [], "busy": False})
    assert rl.free_device("ios", [IPHONE]) is None
    assert rl.free_device("ios", [IPHONE]) is None
    assert started == [True]
    assert rl.free_device("web", []) is None


# ---------------------------------------------------------------- this machine

def test_pressure_says_what_is_short(monkeypatch):
    monkeypatch.setattr(rl, "_swap", lambda: (19 << 30, 20 << 30))
    monkeypatch.setattr(rl.os, "getloadavg", lambda: (500.0, 0, 0))
    assert "short of memory" in rl.read_pressure()["text"]
    assert "95%" in rl.read_pressure()["detail"]
    monkeypatch.setattr(rl, "_swap", lambda: (1 << 30, 20 << 30))
    assert "overloaded" in rl.read_pressure()["text"]
    monkeypatch.setattr(rl.os, "getloadavg", lambda: (1.0, 0, 0))
    assert rl.read_pressure() is None


def test_swap_can_be_read_without_a_process():
    got = rl._swap()
    assert got is None or (got[0] >= 0 and got[1] >= 0)


async def test_pressure_shows_only_when_it_is_the_likely_cause(client, container, team, db, monkeypatch):
    _, bot, tid = team
    monkeypatch.setattr(rl, "machine_pressure", lambda: {"text": "This Mac is short of memory, so everything is slow", "detail": "Swap 95% full"})
    worker(db, bot, tid)
    assert not any("short of memory" in t for t in texts(await read(client, task_id=tid)))  # it just started
    db.execute("UPDATE worker_runs SET started_at=%s WHERE task_id=%s", (sql.utcnow() - dt.timedelta(minutes=5), tid))
    db.execute("UPDATE tasks SET created_at=%s WHERE id=%s", (sql.utcnow() - dt.timedelta(minutes=5), tid))
    assert any("short of memory" in t for t in texts(await read(client, task_id=tid), "warn"))


async def test_a_person_at_the_device_is_what_the_run_says(client, container, team, db):
    from portal_backend import qa_live_routes

    _human, bot, tid = team
    cid = container["id"]
    worker(db, bot, tid)
    sid = await session(client, cid, bot, tid)
    qa_live_routes._LIVE[sid] = qa_live_routes._Live(cid=cid, takeover={"by": "Tess", "since": "2026-11-05T10:00:00+00:00"})
    try:
        log = await read(client, session_id=sid)
    finally:
        qa_live_routes._LIVE.pop(sid, None)
    assert log["now"]["state"] == "waiting" and "A person has the device" in log["now"]["text"]


async def test_a_person_stopping_a_run_stops_its_worker(client, container, team, db):
    human, bot, tid = team
    worker(db, bot, tid)
    sid = await session(client, container["id"], bot, tid)
    r = await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": human, "status": "cancelled"})
    assert r.status_code == 200, r.text
    assert db.execute("SELECT stop_requested_at FROM worker_runs WHERE task_id=%s", (tid,))[0]["stop_requested_at"]


async def test_a_person_stopping_a_run_closes_its_task_so_no_wake_starts_it_over(client, container, team, db):
    human, bot, tid = team
    db.execute("INSERT INTO qa_runs (task_id, container_id, origin) VALUES (%s,%s,'exploration')", (tid, container["id"]))
    worker(db, bot, tid)
    sid = await session(client, container["id"], bot, tid)
    r = await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": human, "status": "cancelled"})
    assert r.status_code == 200, r.text
    assert db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]["status"] == "cancelled"
