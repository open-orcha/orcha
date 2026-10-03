"""Parity round 2 — backend fixes surfaced by the V2 parity / e2e passes.

One regression test per fix:
  * agent-suggestion `create` is gated on owner-or-manage_agents (e2e-permissions-29);
    reassign stays member-level;
  * escalating your OWN request never routes it back to you; 409 when you are the only
    human who could act;
  * an untargeted ask's create response names the human it was routed to;
  * verification notes + audit rows are attributed to the verifier (not NULL);
  * snapshot task_open_total excludes the root task;
  * GET /api/containers carries a compact live_agents list (working agents only);
  * request read-models expose closed_by_alias + close_decision (the human close reason);
  * unassigned task creation / an un-fanned-out task message still reach the container SSE;
  * SSE streams end on SIGTERM so uvicorn's graceful stop does not hang.
"""
import asyncio
import os
import signal
import socket
import subprocess
import sys
import time

import httpx
import pytest

OCTO = {"X-Auth-Request-User": "octocat"}   # bound owner
HUBOT = {"X-Auth-Request-User": "hubot"}    # invited member


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture
def no_trust_proxy(monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")  # member invites are a Team-plan feature


def _task_payload():
    return {"title": "Build it", "definition_of_done": "It is built", "priority": 100}


async def _owner_and_member(client, container, make_agent):
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    owner_id = r.json()["identity"]["agent_id"]
    r = await client.post(
        f"/api/containers/{container['id']}/members",
        json={"github_login": "hubot", "role": "member"},
        headers=OCTO,
    )
    assert r.status_code == 201, r.text
    return owner_id, r.json()["agent_id"]


async def _pending_suggestion(client, make_agent, make_request, alias):
    a = await make_agent(f"asker-{alias}", "eng")
    b = await make_agent(f"refuser-{alias}", "eng")
    req = await make_request(a["agent_id"], "build", target_alias=f"refuser-{alias}",
                             type="task", task=_task_payload())
    r = await client.post(f"/api/requests/{req['request_id']}/reject-task",
                          json={"responder_agent_id": b["agent_id"], "reason": "no"})
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/requests/{req['request_id']}/suggest-agent",
                          json={"requester_agent_id": a["agent_id"], "proposed_alias": alias,
                                "proposed_role": "eng", "proposed_prompt": "p",
                                "rationale": "r"})
    assert r.status_code == 200, r.text
    return req["request_id"]


# ---------- e2e-permissions-29: suggestion create needs manage_agents ----------

async def test_suggestion_create_requires_manage_agents(
    client, db, container, make_agent, make_request, trust_proxy
):
    cid = container["id"]
    db.execute("UPDATE containers SET max_auto_agents=50 WHERE id=%s", (cid,))
    owner_id, hubot_id = await _owner_and_member(client, container, make_agent)
    rid = await _pending_suggestion(client, make_agent, make_request, "Sentinel1")

    # A plain member (no manage_agents) cannot grow the roster through a suggestion —
    # the same user gets 403 from POST /api/containers/{cid}/agents.
    r = await client.post(f"/api/agent-suggestions/{rid}/decide",
                          json={"kind": "create", "actor_agent_id": hubot_id}, headers=HUBOT)
    assert r.status_code == 403, r.text
    assert "manage_agents" in r.text
    assert db.execute("SELECT 1 FROM agents WHERE alias='Sentinel1'") == []

    # With the grant it works.
    r = await client.patch(f"/api/containers/{cid}/members/{hubot_id}",
                           json={"grants": ["manage_agents"]}, headers=OCTO)
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/agent-suggestions/{rid}/decide",
                          json={"kind": "create", "actor_agent_id": hubot_id}, headers=HUBOT)
    assert r.status_code == 200, r.text
    assert db.execute("SELECT 1 FROM agents WHERE alias='Sentinel1'")


async def test_suggestion_reassign_stays_member_level(
    client, db, container, make_agent, make_request, trust_proxy
):
    owner_id, hubot_id = await _owner_and_member(client, container, make_agent)
    rid = await _pending_suggestion(client, make_agent, make_request, "Sentinel2")
    r = await client.post(f"/api/agent-suggestions/{rid}/decide",
                          json={"kind": "reassign", "target_alias": "refuser-Sentinel2",
                                "actor_agent_id": hubot_id}, headers=HUBOT)
    assert r.status_code == 200, r.text


# ---------- escalation never routes back to the requester ----------

async def test_human_escalation_skips_the_requester(
    client, db, container, make_agent, make_request, no_trust_proxy
):
    alice = await make_agent("alice", "operator", kind="human")
    bob = await make_agent("bob", "operator", kind="human")
    await make_agent("worker", "eng")
    req = await make_request(alice["agent_id"], "help?", target_alias="worker")
    # alice is the freshest human (she just clicked) — pre-fix she got her own ask back.
    db.execute("UPDATE agents SET last_heartbeat_at = now() - interval '1 hour' WHERE id=%s",
               (bob["agent_id"],))
    db.execute("UPDATE agents SET last_heartbeat_at = now() WHERE id=%s", (alice["agent_id"],))
    r = await client.post(f"/api/requests/{req['request_id']}/escalate",
                          json={"requester_agent_id": alice["agent_id"]})
    assert r.status_code == 200, r.text
    assert r.json()["target_id"] == bob["agent_id"]


async def test_escalation_409s_when_requester_is_the_only_human(
    client, db, container, make_agent, make_request, no_trust_proxy
):
    alice = await make_agent("alice", "operator", kind="human")
    worker = await make_agent("worker", "eng")
    req = await make_request(alice["agent_id"], "help?", target_alias="worker")
    r = await client.post(f"/api/requests/{req['request_id']}/escalate",
                          json={"requester_agent_id": alice["agent_id"]})
    assert r.status_code == 409, r.text
    assert "only member" in r.text
    row = db.execute("SELECT target_id FROM requests WHERE id=%s", (req["request_id"],))[0]
    assert str(row["target_id"]) == worker["agent_id"]  # untouched


async def test_ai_escalation_unchanged(client, container, make_agent, make_request):
    h = await make_agent("boss", "operator", kind="human")
    a = await make_agent("a", "eng")
    await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "q", target_alias="b")
    r = await client.post(f"/api/requests/{req['request_id']}/escalate",
                          json={"requester_agent_id": a["agent_id"]})
    assert r.status_code == 200, r.text
    assert r.json()["target_id"] == h["agent_id"]


# ---------- untargeted create response names the human ----------

async def test_untargeted_request_response_names_routed_human(
    client, db, container, make_agent
):
    await make_agent("hussein", "operator", kind="human")
    ai = await make_agent("atlas", "eng")
    r = await client.post(f"/api/containers/{container['id']}/requests",
                          json={"requester_agent_id": ai["agent_id"], "payload": "which db?",
                                "type": "info"})
    assert r.status_code == 201, r.text
    assert r.json()["target_alias"] == "hussein"
    # the audit row still records the caller's (absent) addressee
    ev = db.execute("SELECT detail FROM events WHERE entity_id=%s AND event_type='created'",
                    (r.json()["request_id"],))[0]
    assert ev["detail"]["target_alias"] is None


# ---------- verification attribution ----------

async def test_verification_messages_are_attributed_to_the_verifier(
    client, db, container, make_agent, make_task
):
    h = await make_agent("hussein", "operator", kind="human")
    await make_agent("forge", "eng")
    t = await make_task("Fix it", "fixed", assignee_alias="forge")
    db.execute("UPDATE tasks SET status='needs_verification' WHERE id=%s", (t["id"],))
    r = await client.post(f"/api/tasks/{t['id']}/verify",
                          json={"approve": False, "feedback": "tests fail",
                                "actor_agent_id": h["agent_id"]})
    assert r.status_code == 200, r.text
    msg = db.execute("SELECT author_id, body FROM task_messages WHERE task_id=%s", (t["id"],))[0]
    assert msg["body"] == "[verification rejected] tests fail"
    assert str(msg["author_id"]) == h["agent_id"]
    ev = db.execute("SELECT actor_id FROM events WHERE entity_id=%s AND event_type='verified'",
                    (t["id"],))[0]
    assert str(ev["actor_id"]) == h["agent_id"]

    # the thread read path now names the verifier (and flags the post as human)
    r = await client.get(f"/api/tasks/{t['id']}/messages")
    assert r.status_code == 200, r.text
    m = r.json()["messages"][-1]
    assert m["author_alias"] == "hussein" and m["is_human"] is True

    db.execute("UPDATE tasks SET status='needs_verification' WHERE id=%s", (t["id"],))
    r = await client.post(f"/api/tasks/{t['id']}/verify",
                          json={"approve": True, "feedback": "ship it",
                                "actor_agent_id": h["agent_id"]})
    assert r.status_code == 200, r.text
    rows = db.execute("SELECT author_id FROM task_messages WHERE task_id=%s AND body LIKE "
                      "'[verification approved]%%'", (t["id"],))
    assert rows and str(rows[0]["author_id"]) == h["agent_id"]


# ---------- task_open_total excludes the root task ----------

async def test_snapshot_open_task_total_excludes_root(client, container, make_task):
    r = await client.get(f"/api/containers/{container['id']}")
    assert r.status_code == 200, r.text
    assert r.json()["task_open_total"] == 0  # a brand-new project: only the root exists
    await make_task("Real work", "done")
    r = await client.get(f"/api/containers/{container['id']}")
    assert r.json()["task_open_total"] == 1


# ---------- live_agents on GET /api/containers ----------

async def test_container_list_live_agents(client, db, container, make_agent, make_task):
    await make_agent("hussein", "operator", kind="human")
    forge = await make_agent("forge", "eng")
    idle = await make_agent("idle-bot", "eng")
    leased_idle = await make_agent("lease-only", "eng")
    t = await make_task("Fix double-charge", "fixed", assignee_alias="forge")
    # forge: live work lease + a running work-lane run on the task
    db.execute("INSERT INTO agent_wake_state (agent_id, wake_lease_until, lease_kind) "
               "VALUES (%s, now() + interval '5 minutes', 'ephemeral') "
               "ON CONFLICT (agent_id) DO UPDATE SET wake_lease_until=EXCLUDED.wake_lease_until, "
               "lease_kind=EXCLUDED.lease_kind", (forge["agent_id"],))
    db.execute("INSERT INTO worker_runs (agent_id, task_id, status, lane) "
               "VALUES (%s, %s, 'running', 'work')", (forge["agent_id"], t["id"]))
    # lease-only: a live lease with no run and no task reads idle — never listed
    db.execute("INSERT INTO agent_wake_state (agent_id, wake_lease_until, lease_kind) "
               "VALUES (%s, now() + interval '5 minutes', 'ephemeral') "
               "ON CONFLICT (agent_id) DO UPDATE SET wake_lease_until=EXCLUDED.wake_lease_until",
               (leased_idle["agent_id"],))

    r = await client.get("/api/containers")
    assert r.status_code == 200, r.text
    row = next(c for c in r.json()["containers"] if c["id"] == container["id"])
    assert row["live_agents_total"] == 1
    [la] = row["live_agents"]
    assert la["alias"] == "forge"
    assert la["status"] == "working"
    assert la["task_title"] == "Fix double-charge"
    assert la["started_at"]
    assert idle["agent_id"]

    # VD-09: a lapsed lease with the run still 'running' stays Working — the snapshot's
    # running_run (roster / board / selected sidebar) reports it regardless of lease.
    db.execute("UPDATE agent_wake_state SET wake_lease_until = now() - interval '1 minute'")
    r = await client.get("/api/containers")
    row = next(c for c in r.json()["containers"] if c["id"] == container["id"])
    assert [x["alias"] for x in row["live_agents"]] == ["forge"]
    assert row["live_agents"][0]["status"] == "working"
    # ...even with an open outgoing ask (stored status awaiting_request)
    scout = await make_agent("scout", "eng")
    await client.post(f"/api/containers/{container['id']}/requests", json={
        "requester_agent_id": forge["agent_id"], "payload": "q", "type": "info", "target_alias": "scout"})
    r = await client.get("/api/containers")
    row = next(c for c in r.json()["containers"] if c["id"] == container["id"])
    assert row["live_agents"][0]["status"] == "working"
    # once the run ends and the lease is gone, the agent drops off
    db.execute("UPDATE worker_runs SET status='exited', ended_at=now() WHERE agent_id=%s", (forge["agent_id"],))
    r = await client.get("/api/containers")
    row = next(c for c in r.json()["containers"] if c["id"] == container["id"])
    assert row["live_agents"] == [] and row["live_agents_total"] == 0
    assert scout["agent_id"]


# ---------- close reason is readable ----------

async def test_request_read_models_expose_close_reason(
    client, container, make_agent, make_request
):
    h = await make_agent("hussein", "operator", kind="human")
    a = await make_agent("atlas", "eng")
    await make_agent("scout", "eng")
    req = await make_request(a["agent_id"], "q", target_alias="scout")
    r = await client.post(f"/api/requests/{req['request_id']}/close",
                          json={"requester_agent_id": h["agent_id"], "reason": "duplicate"})
    assert r.status_code == 200, r.text

    snap = (await client.get(f"/api/containers/{container['id']}")).json()
    row = next(x for x in snap["requests"] if str(x["id"]) == req["request_id"])
    assert row["closed_by_alias"] == "hussein"
    assert row["close_decision"]["reason"] == "duplicate"
    assert row["close_decision"]["actor"] == "hussein"

    lst = (await client.get(f"/api/containers/{container['id']}/requests")).json()
    row = next(x for x in lst["requests"] if str(x["id"]) == req["request_id"])
    assert row["close_decision"]["reason"] == "duplicate"

    # a second forced close keeps its own reason (latest decision per request)
    req2 = await make_request(a["agent_id"], "q2", target_alias="scout")
    r = await client.post(f"/api/requests/{req2['request_id']}/close",
                          json={"requester_agent_id": h["agent_id"], "reason": "stale"})
    assert r.status_code == 200
    snap = (await client.get(f"/api/containers/{container['id']}")).json()
    row2 = next(x for x in snap["requests"] if str(x["id"]) == req2["request_id"])
    assert row2["close_decision"]["reason"] == "stale"


# ---------- container SSE carries unassigned tasks + un-fanned messages ----------

async def test_unassigned_task_and_solo_message_reach_container_stream(
    client, db, container, make_agent, make_task
):
    key = f"c:{container['id']}"
    h = await make_agent("hussein", "operator", kind="human")
    before = len(db.event_rows(key))
    t = await make_task("Unassigned", "done")
    rows = db.event_rows(key)[before:]
    assert [r["event_name"] for r in rows] == ["task_created"]
    assert rows[0]["target_id"] is None  # container-only: wakes nobody

    before = len(db.event_rows(key))
    r = await client.post(f"/api/tasks/{t['id']}/messages",
                          json={"author_agent_id": h["agent_id"], "body": "note"})
    assert r.status_code in (200, 201), r.text
    rows = db.event_rows(key)[before:]
    assert [r["event_name"] for r in rows] == ["task_message"]
    # no agent-keyed delivery row was created (nobody to wake)
    assert db.execute("SELECT 1 FROM agent_events WHERE event_name='task_message' "
                      "AND target_id IS NOT NULL") == []


# ---------- SSE streams end on SIGTERM ----------

async def test_wait_for_event_returns_on_shutdown_flag():
    from portal_backend import events

    events._SHUTTING_DOWN.set()
    try:
        started = time.monotonic()
        got = await events.wait_for_event("nobody", 0.0, 10.0)
        assert got is None and time.monotonic() - started < 1.0
    finally:
        events._SHUTTING_DOWN.clear()


def test_shutdown_hook_chains_previous_handler():
    from portal_backend import events

    seen = []
    prev = signal.signal(signal.SIGTERM, lambda s, f: seen.append(s))
    try:
        events.install_stream_shutdown_hook()
        events.install_stream_shutdown_hook()  # idempotent: no double-wrap
        handler = signal.getsignal(signal.SIGTERM)
        handler(signal.SIGTERM, None)
        assert events.shutting_down()
        assert seen == [signal.SIGTERM]  # uvicorn's handler still runs, once
    finally:
        events._SHUTTING_DOWN.clear()
        signal.signal(signal.SIGTERM, prev)
        signal.signal(signal.SIGINT, signal.default_int_handler)


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def test_sigterm_with_open_sse_exits_promptly():
    """Real uvicorn process + an open container /events stream: SIGTERM must finish the
    graceful stop in well under 3 s (it previously hung until SIGKILL)."""
    pytest.importorskip("uvicorn")
    import conftest

    port = _free_port()
    env = dict(os.environ, DATABASE_URL=os.environ["DATABASE_URL"])
    code = (
        "import sys; sys.path.insert(0, %r); import uvicorn, main; "
        "uvicorn.run(main.app, host='127.0.0.1', port=%d, log_level='warning')"
        % (str(conftest.PORTAL_DIR), port)
    )
    proc = subprocess.Popen([sys.executable, "-c", code], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        base = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                if httpx.get(base + "/api/containers", timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.2)
        else:
            pytest.fail("uvicorn did not start")
        cid = httpx.post(base + "/api/containers", json={"name": "sse-stop"},
                         timeout=5).json()["container_id"]

        async def _hold_stream_then_term():
            async with httpx.AsyncClient(timeout=None) as c:
                async with c.stream("GET", f"{base}/api/containers/{cid}/events") as resp:
                    assert resp.status_code == 200
                    await asyncio.sleep(0.5)
                    t0 = time.monotonic()
                    proc.send_signal(signal.SIGTERM)
                    async def _drain():
                        try:
                            async for _ in resp.aiter_raw():
                                pass
                        except httpx.HTTPError:
                            pass
                    try:  # bounded: pre-fix the stream (and the process) never ended
                        await asyncio.wait_for(_drain(), timeout=5.0)
                    except asyncio.TimeoutError:
                        pass
                    return t0

        t0 = asyncio.run(_hold_stream_then_term())
        try:
            proc.wait(timeout=max(0.1, t0 + 3.0 - time.monotonic()))
        except subprocess.TimeoutExpired:
            pytest.fail("graceful stop hung on the open SSE stream (> 3 s after SIGTERM)")
        assert time.monotonic() - t0 < 3.0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
