"""QA run reliability, from what real runs did: a killed worker's session, a lock whose owner died, a
device another project's run holds, and a project with no agent. The waiting path runs for real: real
lock directories, a second process holding the lock, the real device session over a fake idb client,
the real tool server and the real portal routes. No device is driven."""

import datetime as dt
import json
import os
import signal
import subprocess
import sys
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

import main
from orcha_cli.qa import mcp_server
from orcha_cli.qa.device import ios, locks
from orcha_cli.qa.mcp_server import QATools
from portal_backend import qa_explorations as qx
from portal_backend import qa_setup_routes, sql
from conftest import fresh_task_id
from test_qa_device_ios import APP, FakeApp, FakeClient, clock, sims  # noqa: F401 (fixtures)
from test_qa_mcp_portal import AppPortal, Ident
from test_qa_onboarding_portal import flow, people, repo  # noqa: F401 (fixtures)

IPHONE, IPAD = "iPhone 17 Pro", "iPad Pro 13-inch (M5)"
HOLD = """
import sys, time
from pathlib import Path
from orcha_cli.qa.device import locks
locks.LOCK_ROOT = Path(sys.argv[1])
locks.set_holder(project="snug-log", kind="check", session_id="held-session")
if sys.argv[3] == "lock":
    assert locks.claim(sys.argv[2]) is not None
else:
    locks.join_line([sys.argv[2]])
print("ready", flush=True)
time.sleep(600)
"""


@pytest.fixture
def holders(tmp_path):
    """Second processes: each holds a lock (or a place in line) until killed."""
    started = []

    def start(device, what="lock"):
        p = subprocess.Popen([sys.executable, "-c", HOLD, str(tmp_path), device, what], stdout=subprocess.PIPE, text=True)
        assert p.stdout.readline().strip() == "ready"
        started.append(p)
        return p

    yield start
    for p in started:
        p.kill()
        p.wait()


@pytest.fixture(autouse=True)
def clean_module():
    yield
    locks.leave_line()
    locks.set_holder()


def kill(p):
    os.kill(p.pid, signal.SIGKILL)
    p.wait()


def ago(seconds):
    return sql.utcnow() - dt.timedelta(seconds=seconds)


# ---------------------------------------------------------------- the lock and its owner

def test_a_held_lock_is_an_empty_directory_so_a_bare_rmdir_still_works(tmp_path):
    lock = locks.claim(IPHONE, root=tmp_path)
    path = tmp_path / "claude-sim-lock-iPhone-17-Pro"
    assert list(path.iterdir()) == []
    owner = json.loads((tmp_path / "claude-sim-lock-iPhone-17-Pro.owner").read_text())
    assert owner["pid"] == os.getpid() and owner["started"]
    path.rmdir()  # what other agents on this machine do when they are done
    lock.release()
    assert not path.exists() and not (tmp_path / "claude-sim-lock-iPhone-17-Pro.owner").exists()


def test_release_leaves_nothing_behind(tmp_path):
    locks.claim(IPHONE, root=tmp_path).release()
    assert list(tmp_path.iterdir()) == []


def test_an_owner_file_left_by_a_bare_rmdir_says_nothing_about_the_next_lock(tmp_path, holders):
    p = holders(IPHONE)
    path = tmp_path / "claude-sim-lock-iPhone-17-Pro"
    kill(p)
    path.rmdir()  # the owner file stays behind
    time.sleep(0.01)
    path.mkdir()  # another tool's bare mkdir: its lock, not the dead owner's
    assert locks.owner_of(path) is None
    assert locks.claim(IPHONE, root=tmp_path) is None


def test_a_dead_owners_lock_is_taken_at_once(tmp_path, holders):
    p = holders(IPHONE)
    assert locks.claim(IPHONE, root=tmp_path) is None
    assert locks.holder(IPHONE, root=tmp_path)["project"] == "snug-log"
    kill(p)
    assert locks.holder(IPHONE, root=tmp_path) is None
    assert locks.claim(IPHONE, root=tmp_path) is not None


def test_a_pid_that_came_back_as_another_process_is_a_dead_owner(tmp_path, monkeypatch):
    lock = locks.claim(IPHONE, root=tmp_path)
    assert not locks.owner_gone(lock.path)
    owner = json.loads(locks.owner_path(lock.path).read_text())
    locks.owner_path(lock.path).write_text(json.dumps({**owner, "started": "Thu Jan  1 00:00:00 1970"}))
    assert locks.owner_gone(lock.path)  # the pid is alive, but it is not the process that took the lock


def test_a_lock_with_no_owner_file_keeps_the_two_hour_rule(tmp_path):
    path = tmp_path / "claude-sim-lock-iPhone-17-Pro"
    path.mkdir()
    assert locks.claim(IPHONE, root=tmp_path, is_booted=lambda: False) is None  # fresh
    old = time.time() - locks.STALE_AFTER_S - 60
    os.utime(path, (old, old))
    assert locks.claim(IPHONE, root=tmp_path, is_booted=lambda: True) is None  # old, on a booted device
    assert locks.claim(IPHONE, root=tmp_path, is_booted=lambda: False) is not None


def test_an_older_ticket_goes_first_and_a_dead_one_does_not_hold_up_the_line(tmp_path, holders):
    first = holders(IPHONE, "line")
    assert locks.claim(IPHONE, root=tmp_path) is None  # free, but someone was here first
    assert locks.claim(IPAD, root=tmp_path) is not None  # nobody ahead wants this one
    locks.join_line([IPHONE], root=tmp_path)
    assert locks.place(root=tmp_path) == 2
    kill(first)
    assert locks.place(root=tmp_path) == 1
    assert locks.claim(IPHONE, root=tmp_path) is not None


def test_a_ticket_that_stopped_asking_is_passed(tmp_path, holders, monkeypatch):
    holders(IPHONE, "line")
    monkeypatch.setattr(locks, "TICKET_FRESH_S", -1)
    assert locks.claim(IPHONE, root=tmp_path) is not None


# ---------------------------------------------------------------- the line, for real

@pytest.fixture
def run(client, container, make_agent, make_task, sims, clock, tmp_path, monkeypatch):  # noqa: F811
    """A project with its usual device set, and what opens a real device session on the fake client."""
    monkeypatch.setattr(main, "ATTACHMENTS_DIR", tmp_path / "attachments")

    def opener():
        async def open_(platform, app_id, device_name, **opts):
            s = ios.IosSession(device_name=device_name, any_device=bool(opts.get("any_device")),
                               client_factory=lambda udid: FakeClient(FakeApp(), clock))
            await s.start(app_id)
            s.start_live = None  # no stream from a fake client: the page follows each step's frame
            return s
        return open_

    async def setup():
        human = (await make_agent("Hussein", "owner", kind="human"))["agent_id"]
        bot = (await make_agent("Bot"))["agent_id"]
        task = await make_task("Check the app", "Verdicts in")
        r = await client.put(f"/api/containers/{container['id']}/qa/targets/ios",
                             json={"app_id": APP, "device_name": IPHONE, "actor_agent_id": human})
        assert r.status_code == 200, r.text
        return container["id"], bot, task["id"]

    return setup, opener


async def test_a_held_device_is_a_wait_with_a_reason_and_the_run_starts_by_itself(run, holders, tmp_path):
    setup, opener = run
    cid, bot, tid = await setup()
    other = holders(IPHONE)
    holders(IPAD)
    seen = []

    with TestClient(main.app) as tc:
        portal = AppPortal(tc, cid, bot)

        async def sleep(_s):
            seen.append(portal.get_session(portal.list_sessions()["sessions"][0]["id"]))
            if len(seen) == 3:
                kill(other)

        tools = QATools(identity=Ident(cid, bot), portal=portal, device_opener=opener(), sleep=sleep)
        out = await tools.start_session("ios", "check", task_id=tid)
        assert out.startswith("session started"), out

        waiting = seen[0]
        assert waiting["status"] == "running" and waiting["queued"] is True and waiting["stop_reason"] is None
        q = waiting["queue"]
        assert q["device"] == IPHONE and q["used_by"] == "snug-log's check run" and q["project"] == "snug-log"
        assert q["held_session_id"] == "held-session" and q["devices"] == [IPHONE, IPAD] and q["position"] == 1
        assert q["reason"] == "Waiting for iPhone 17 Pro: snug-log's check run has it."

        s = tools.live and portal.get_session(tools.live.id)
        assert s["id"] == waiting["id"] and s["status"] == "running" and s["queued"] is False and s["queue"] is None
        assert s["device_name"] == IPHONE and s["claimed_at"] and s["started_at"] >= waiting["started_at"]
        assert len(portal.list_sessions()["sessions"]) == 1
        assert locks.owner_of(tmp_path / "claude-sim-lock-iPhone-17-Pro")["pid"] == os.getpid()
        tools.live.budget = None
        assert (await tools.end_session("done")).startswith(f"session {s['id']} ended")
    assert not (tmp_path / "claude-sim-lock-iPhone-17-Pro").exists()
    assert not (tmp_path / "claude-sim-lock-iPhone-17-Pro.owner").exists()


async def test_a_second_run_takes_the_other_booted_device(run, holders, tmp_path):
    setup, opener = run
    cid, bot, tid = await setup()
    holders(IPHONE)
    with TestClient(main.app) as tc:
        tools = QATools(identity=Ident(cid, bot), portal=AppPortal(tc, cid, bot), device_opener=opener())
        out = await tools.start_session("ios", "check", task_id=tid)
        assert out.startswith("session started") and tools.live.device.device_name == IPAD, out
        tools.live.budget = None
        await tools.end_session("done")


async def test_a_device_picked_for_this_run_is_waited_for_not_swapped(run, holders, monkeypatch):
    setup, opener = run
    cid, bot, tid = await setup()
    holders(IPHONE)
    monkeypatch.setattr(mcp_server, "QUEUE_WAIT_S", 0.0)
    with TestClient(main.app) as tc:
        tools = QATools(identity=Ident(cid, bot), portal=AppPortal(tc, cid, bot), device_opener=opener())
        out = await tools.start_session("ios", "check", task_id=tid, device=IPHONE)
        assert out.startswith("waiting: Waiting for iPhone 17 Pro: snug-log's check run has it."), out
        assert not out.startswith("error") and tools.live is None


async def test_a_person_sends_a_run_in_line_to_the_free_device(run, holders, make_agent, monkeypatch):
    setup, opener = run
    cid, bot, tid = await setup()
    human = (await make_agent("Ana", "owner", kind="human"))["agent_id"]
    holders(IPHONE)
    monkeypatch.setattr(mcp_server, "QUEUE_RETRY_S", 0.0)
    with TestClient(main.app) as tc:
        portal = AppPortal(tc, cid, bot)
        asked = []

        async def sleep(_s):
            if not asked:
                sid = portal.list_sessions()["sessions"][0]["id"]
                asked.append(tc.post(f"/api/qa/sessions/{sid}/use-device", json={"actor_agent_id": human, "device": IPAD}))

        tools = QATools(identity=Ident(cid, bot), portal=portal, device_opener=opener(), sleep=sleep)
        out = await tools.start_session("ios", "check", task_id=tid, device=IPHONE)
        assert asked[0].status_code == 200, asked[0].text
        assert out.startswith("session started"), out
        assert tools.live.device_name == IPAD
        await tools.end_session("done", force=True)


async def test_a_wait_that_runs_out_keeps_its_row_and_place_and_the_next_call_goes_on(run, holders, monkeypatch):
    setup, opener = run
    cid, bot, tid = await setup()
    other = holders(IPHONE)
    monkeypatch.setattr(mcp_server, "QUEUE_WAIT_S", 0.0)
    with TestClient(main.app) as tc:
        portal = AppPortal(tc, cid, bot)
        tools = QATools(identity=Ident(cid, bot), portal=portal, device_opener=opener())
        one = await tools.start_session("ios", "check", task_id=tid, device=IPHONE)
        two = await tools.start_session("ios", "check", task_id=tid, device=IPHONE)
        assert one.startswith("waiting:") and two.startswith("waiting:")
        rows = portal.list_sessions()["sessions"]
        assert len(rows) == 1 and rows[0]["status"] == "running" and rows[0]["queued"]
        kill(other)
        out = await tools.start_session("ios", "check", task_id=tid, device=IPHONE)
        assert out.startswith("session started"), out
        assert [r["id"] for r in portal.list_sessions()["sessions"]] == [rows[0]["id"]]
        tools.live.budget = None
        await tools.end_session("done")


async def test_leaving_the_line_is_no_failure_and_frees_the_place(run, holders, tmp_path, monkeypatch):
    setup, opener = run
    cid, bot, tid = await setup()
    holders(IPHONE)
    monkeypatch.setattr(mcp_server, "QUEUE_WAIT_S", 0.0)
    with TestClient(main.app) as tc:
        portal = AppPortal(tc, cid, bot)
        tools = QATools(identity=Ident(cid, bot), portal=portal, device_opener=opener())
        await tools.start_session("ios", "check", task_id=tid, device=IPHONE)
        assert "left the line" in await tools.end_session("giving up")
        rows = portal.list_sessions()["sessions"]
        assert rows[0]["status"] == "abandoned" and rows[0]["stop_reason"]
    assert locks.line(tmp_path) == []


async def test_a_session_the_portal_ended_lets_the_device_go_at_once(run, tmp_path):
    setup, opener = run
    cid, bot, tid = await setup()
    with TestClient(main.app) as tc:
        portal = AppPortal(tc, cid, bot)
        tools = QATools(identity=Ident(cid, bot), portal=portal, device_opener=opener())
        await tools.start_session("ios", "check", task_id=tid)
        sid = tools.live.id
        portal.patch_session(sid, {"status": "abandoned", "result": {"error": "The agent's worker was stopped before it finished."}})
        await tools._ended_elsewhere(tools.live)
        assert not (tmp_path / "claude-sim-lock-iPhone-17-Pro").exists()
        out = await tools.screen()
        assert out.startswith(f"error: session {sid} has ended (The agent's worker was stopped before it finished.)"), out


# ---------------------------------------------------------------- sessions nobody is running

async def session(client, cid, bot, tid):
    tid = tid or await fresh_task_id(client, cid, bot)
    r = await client.post(f"/api/containers/{cid}/qa/sessions", json={"actor_agent_id": bot, "kind": "explore", "platform": "ios", "task_id": tid})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def worker(db, bot, tid, status="running", ended=None):
    db.execute("INSERT INTO worker_runs (run_id, agent_id, task_id, status, ended_at) VALUES (%s,%s,%s,%s,%s)",
               (str(uuid4()), bot, tid, status, ended))


@pytest.fixture
async def team(make_agent, make_task):
    human = await make_agent("Hussein", "owner", kind="human")
    bot = await make_agent("Bot")
    task = await make_task("Explore", "Findings in")
    return human["agent_id"], bot["agent_id"], task["id"]


async def assign(client, tid, bot, human):
    r = await client.post(f"/api/tasks/{tid}/assign", json={"actor_agent_id": human, "agent_id": bot})
    assert r.status_code == 200, r.text


async def test_a_killed_workers_session_is_abandoned_with_a_reason_and_run_again_keeps_the_task(client, container, team, db):
    cid, (human, bot, tid) = container["id"], team
    await assign(client, tid, bot, human)
    sid = await session(client, cid, bot, tid)
    db.execute("UPDATE qa_sessions SET started_at=%s WHERE id=%s", (ago(600), sid))
    worker(db, bot, tid, "killed", ago(300))
    s = (await client.get(f"/api/qa/sessions/{sid}")).json()
    assert s["status"] == "abandoned" and s["stop_reason"] == "The agent's worker was stopped before it finished."
    assert s["run_again"]["mode"] == "resume" and s["run_again"]["task_id"] == tid and s["run_again"]["agent_alias"] == "Bot"
    assert "no second task" in s["run_again"]["says"]
    before = db.execute("SELECT count(*) AS n FROM tasks WHERE container_id=%s", (cid,))[0]["n"]
    again = await client.post(f"/api/qa/sessions/{sid}/again", json={"actor_agent_id": human})
    assert again.status_code == 201, again.text
    assert again.json()["task_id"] == tid and again.json()["run_again"]["mode"] == "resume"
    assert db.execute("SELECT count(*) AS n FROM tasks WHERE container_id=%s", (cid,))[0]["n"] == before
    row = (await client.get(f"/api/qa/sessions/{again.json()['session_id']}")).json()
    assert row["queued"] is True and row["status"] == "running"  # the old run does not abandon the new one


async def test_a_worker_alive_keeps_its_session_and_a_grace_covers_a_respawn(client, container, team, db):
    cid, (human, bot, tid) = container["id"], team
    sid = await session(client, cid, bot, tid)
    worker(db, bot, tid)
    qx.sweep_abandoned(cid, force=True)
    assert (await client.get(f"/api/qa/sessions/{sid}")).json()["status"] == "running"
    db.execute("UPDATE worker_runs SET status='exited', ended_at=%s WHERE task_id=%s", (sql.utcnow(), tid))
    qx.sweep_abandoned(cid, force=True)
    assert (await client.get(f"/api/qa/sessions/{sid}")).json()["status"] == "running"


async def test_silence_ends_a_session_with_no_worker_and_the_portals_sweeper_finds_it(client, container, team, db):
    cid, (_, bot, tid) = container["id"], team
    sid = await session(client, cid, bot, None)
    db.execute("UPDATE qa_sessions SET last_seen_at=%s WHERE id=%s", (ago(qx.SILENT_SECONDS + 5), sid))
    qx.sweep_all()
    row = db.execute("SELECT status FROM qa_sessions WHERE id=%s", (sid,))[0]
    assert row["status"] == "abandoned"
    assert (await client.get(f"/api/qa/sessions/{sid}")).json()["stop_reason"] == "Nothing was heard from the agent for 15 minutes."


async def test_a_heartbeat_that_just_came_in_wins_over_the_sweep(client, container, team, db):
    cid, (_, bot, _t) = container["id"], team
    sid = await session(client, cid, bot, None)
    db.execute("UPDATE qa_sessions SET last_seen_at=%s WHERE id=%s", (ago(qx.SILENT_SECONDS + 5), sid))
    await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": bot, "heartbeat": True})
    qx.sweep_all()
    assert db.execute("SELECT status FROM qa_sessions WHERE id=%s", (sid,))[0]["status"] == "running"


async def test_a_session_a_person_queued_keeps_waiting_for_an_agent(client, container, team, db):
    cid, (human, _bot, tid) = container["id"], team
    r = await client.post(f"/api/containers/{cid}/qa/sessions/queue", json={"actor_agent_id": human, "kind": "explore", "platform": "ios", "task_id": tid})
    sid = r.json()["id"]
    db.execute("UPDATE qa_sessions SET last_seen_at=%s WHERE id=%s", (ago(qx.SILENT_SECONDS * 4), sid))
    qx.sweep_all()
    s = (await client.get(f"/api/qa/sessions/{sid}")).json()
    assert s["status"] == "running" and s["queue"]["reason"] == "Waiting for an agent to pick it up."


async def test_a_server_that_died_in_line_is_swept(client, container, team, db):
    cid, (_, bot, _t) = container["id"], team
    sid = await session(client, cid, bot, None)
    await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": bot, "waiting": {"device": IPHONE, "reason": "Waiting for iPhone 17 Pro."}})
    db.execute("UPDATE qa_sessions SET last_seen_at=%s WHERE id=%s", (ago(qx.SILENT_SECONDS + 5), sid))
    qx.sweep_all()
    assert db.execute("SELECT status FROM qa_sessions WHERE id=%s", (sid,))[0]["status"] == "abandoned"


async def test_waiting_on_a_session_that_ended_is_refused(client, container, team):
    cid, (_, bot, _t) = container["id"], team
    sid = await session(client, cid, bot, None)
    await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": bot, "status": "cancelled"})
    r = await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": bot, "waiting": {"device": IPHONE, "reason": "x"}})
    assert r.status_code == 409


# ---------------------------------------------------------------- onboarding phases

async def test_a_phase_on_a_killed_worker_says_why_and_run_goes_on_with_the_task(flow, people, repo, db, monkeypatch):  # noqa: F811
    from portal_backend import qa_onboarding as qo

    monkeypatch.setattr(qo, "WORKER_GONE_SECONDS", 0.0)
    monkeypatch.setattr(qx, "SWEEP_EVERY_SECONDS", 0)
    bot = people["bot"]
    await flow.mapped()
    tid = (await flow.act("run_live", agent_id=bot))["phases"]["live"]["task_id"]
    sid = await session(flow.client, flow.cid, bot, tid)
    db.execute("UPDATE qa_sessions SET started_at=%s WHERE id=%s", (ago(900), sid))
    worker(db, bot, tid, "killed", ago(300))
    g = await flow.until(lambda g: g["phases"]["live"]["state"] == "failed")
    live = g["phases"]["live"]
    assert live["blocked_reason"] == "The agent's worker was stopped before it finished."
    assert live["run_again"]["mode"] == "resume" and live["run_again"]["task_id"] == tid
    tasks = db.execute("SELECT count(*) AS n FROM tasks WHERE container_id=%s", (flow.cid,))[0]["n"]
    again = await flow.act("run_live")
    assert again["phases"]["live"]["task_id"] == tid and again["phases"]["live"]["state"] == "running"
    assert "run_again" not in again["phases"]["live"]
    assert db.execute("SELECT count(*) AS n FROM tasks WHERE container_id=%s", (flow.cid,))[0]["n"] == tasks


async def test_a_phase_waiting_for_a_device_says_who_has_it_and_never_fails(flow, people, repo, db):  # noqa: F811
    bot = people["bot"]
    await flow.mapped()
    tid = (await flow.act("run_live", agent_id=bot))["phases"]["live"]["task_id"]
    sid = await session(flow.client, flow.cid, bot, tid)
    worker(db, bot, tid)
    reason = "Waiting for iPhone 17 Pro: snug-log's check run has it."
    await flow.client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": bot, "waiting": {"device": IPHONE, "reason": reason}})
    g = await flow.until(lambda g: g["phases"]["live"].get("blocked_reason") == reason)
    assert g["phases"]["live"]["state"] == "running"


async def test_no_agent_says_so_and_adding_one_takes_the_waiting_task(flow, people, repo, db):  # noqa: F811
    db.execute("UPDATE agents SET terminated_at=%s WHERE id=%s", (sql.utcnow(), people["bot"]))
    await flow.mapped()
    tid = (await flow.act("run_live"))["phases"]["live"]["task_id"]
    g = await flow.until(lambda g: g["phases"]["live"].get("blocked_reason") == "no agent")
    assert "Add a QA agent" in g["phases"]["live"]["note"]
    assert (await flow.client.post(f"/api/containers/{flow.cid}/qa/agent", json={"actor_agent_id": people["bot"]})).status_code in (403, 409)
    tasks = db.execute("SELECT count(*) AS n FROM tasks WHERE container_id=%s", (flow.cid,))[0]["n"]
    r = await flow.client.post(f"/api/containers/{flow.cid}/qa/agent", json={"actor_agent_id": people["human"]})
    assert r.status_code == 200, r.text
    made = r.json()
    assert made["created"] is True and made["alias"] == "QA" and made["assigned_task_ids"] == [tid]
    row = db.execute("SELECT alias, role, kind, system_prompt FROM agents WHERE id=%s", (made["agent_id"],))[0]
    assert (row["role"], row["kind"]) == ("QA", "ai") and "QA agent" in row["system_prompt"]
    assert db.execute("SELECT agent_id FROM agent_tasks WHERE task_id=%s", (tid,))[0]["agent_id"] == made["agent_id"]
    assert db.execute("SELECT count(*) AS n FROM tasks WHERE container_id=%s", (flow.cid,))[0]["n"] == tasks
    await flow.until(lambda g: g["phases"]["live"].get("blocked_reason") != "no agent")
    second = (await flow.client.post(f"/api/containers/{flow.cid}/qa/agent", json={"actor_agent_id": people["human"]})).json()
    assert second["created"] is False and second["agent_id"] == made["agent_id"] and second["assigned_task_ids"] == []


# ---------------------------------------------------------------- tools

async def test_tools_status_and_turning_them_on(client, container, team, tmp_path, monkeypatch):
    cid, (human, bot, _t) = container["id"], team
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(tmp_path))
    assert (await client.get(f"/api/containers/{cid}/qa/tools")).json() == {"tools_on": False, "can_enable": True, "reason": None}
    assert (await client.post(f"/api/containers/{cid}/qa/tools", json={"actor_agent_id": bot})).status_code == 403
    r = await client.post(f"/api/containers/{cid}/qa/tools", json={"actor_agent_id": human})
    assert r.status_code == 200 and r.json()["tools_on"] is True
    assert (tmp_path / ".orcha" / "qa" / "mcp.json").is_file()
    setup = (await client.get(f"/api/containers/{cid}/qa/setup")).json()
    assert setup["tools_on"] is True and setup["ai_agents"] == 1  # the older route reads the same state
    assert (await client.post(f"/api/containers/{cid}/qa/setup/tools/off", json={"actor_agent_id": bot})).status_code == 403
    off = await client.post(f"/api/containers/{cid}/qa/setup/tools/off", json={"actor_agent_id": human})
    assert off.status_code == 200 and off.json()["tools_on"] is False
    assert not (tmp_path / ".orcha" / "qa" / "mcp.json").exists()


async def test_a_portal_without_the_package_says_so_in_a_sentence(client, container, team, tmp_path, monkeypatch):
    cid, (human, _bot, _t) = container["id"], team
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(tmp_path))
    monkeypatch.setattr(qa_setup_routes, "_launch", lambda: None)
    got = (await client.get(f"/api/containers/{cid}/qa/tools")).json()
    assert got == {"tools_on": False, "can_enable": False, "reason": qa_setup_routes.NO_PACKAGE}
    r = await client.post(f"/api/containers/{cid}/qa/tools", json={"actor_agent_id": human})
    assert r.status_code == 409 and "orcha qa enable" in r.json()["detail"]


async def test_a_session_a_new_worker_replaced_ends_with_that_reason(client, container, team, db):
    cid, (_human, bot, tid) = container["id"], team
    body = {"actor_agent_id": bot, "kind": "check", "platform": "web", "task_id": tid}
    old = (await client.post(f"/api/containers/{cid}/qa/sessions", json=body)).json()["id"]
    new = (await client.post(f"/api/containers/{cid}/qa/sessions", json=body)).json()["id"]
    qx.sweep_abandoned(cid, force=True)
    rows = {r["id"]: r for r in db.execute("SELECT id, status FROM qa_sessions WHERE id IN (%s,%s)", (old, new))}
    assert rows[old]["status"] == "abandoned" and rows[new]["status"] == "running"


def test_the_tool_server_knows_when_its_agent_is_gone(monkeypatch):
    from orcha_cli.qa import mcp_server

    tools = mcp_server.QATools(identity=object(), portal=object())
    assert tools.parent_gone() is False  # outside `run`, nothing is watched
    tools.parent_pid = os.getppid()
    assert tools.parent_gone() is False
    tools.parent_pid = -1
    assert tools.parent_gone() is True
