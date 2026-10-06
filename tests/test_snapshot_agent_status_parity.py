from conftest import ts_ago, ts_from_now
"""Snapshot facts that let every portal surface agree on an agent's status.

Linear review r3: the workspace header said "Working" (it reads GET /api/agents/{aid}/runs)
while the roster/board said "No runtime" (they read only the snapshot, whose `active_run`
is lease-gated), and a paused agent's status was guessed. The snapshot now carries,
additively:

  * container.runtime_served / wake_scan_age_secs — the server's "a host runtime serves
    this project" reading (2-minute window, DB clock);
  * agent.running_run — the newest worker_run the /runs list reports as running, with
    `lease_live` (false ⇒ probable orphan awaiting the reaper);
  * agent.wakes_paused / wakes_paused_reason / pause_stops_running_run — the explicit pause
    fact, mirroring wake_claim's refusal order. A pause refuses NEW wakes only; a run in
    flight keeps running (pinned below against the real wake-claim route).
"""


async def _snap(client, cid):
    r = await client.get(f"/api/containers/{cid}")
    assert r.status_code == 200, r.text
    return r.json()


def _agent(snap, aid):
    return next(a for a in snap["agents"] if a["id"] == aid)


def _run(db, aid, *, lane="work", started="now()"):
    return db.execute(
        f"""INSERT INTO worker_runs (agent_id, status, lane, wake_kind, runtime, started_at)
            VALUES (%s, 'running', %s, 'task', 'claude', {started}) RETURNING run_id""",
        (aid, lane),
    )[0]["run_id"]


async def test_runtime_served_is_server_computed(client, db, container):
    cid = container["id"]
    c = (await _snap(client, cid))["container"]
    assert c["runtime_served"] is False and c["wake_scan_age_secs"] is None
    db.execute(f"UPDATE containers SET last_wake_scan_at = {ts_ago(30)} WHERE id=%s", (cid,))
    c = (await _snap(client, cid))["container"]
    assert c["runtime_served"] is True and 25 <= float(c["wake_scan_age_secs"]) < 120
    db.execute(f"UPDATE containers SET last_wake_scan_at = {ts_ago(300)} WHERE id=%s", (cid,))
    c = (await _snap(client, cid))["container"]
    # (>= 299.99: SQLite's julianday() date math is millisecond-precise)
    assert c["runtime_served"] is False and float(c["wake_scan_age_secs"]) >= 299.99


async def test_running_run_matches_the_runs_list(client, db, container, make_agent):
    cid = container["id"]
    a = await make_agent("dev")
    aid = a["agent_id"]
    assert _agent(await _snap(client, cid), aid)["running_run"] is None

    # a running row with NO live lease (no runtime / orphan): /runs says running,
    # active_run (lease-gated) stays null — running_run carries it with lease_live=false
    _run(db, aid, started=f"{ts_ago(600)}")
    newest = _run(db, aid)
    ag = _agent(await _snap(client, cid), aid)
    runs = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"]
    first_running = next(r for r in runs if r["status"] == "running")
    assert ag["active_run"] is None
    assert ag["running_run"]["run_id"] == str(newest) == str(first_running["run_id"])
    assert ag["running_run"]["lease_live"] is False
    assert ag["running_run"]["lane"] == "work" and ag["running_run"]["runtime"] == "claude"

    # with a live work lease it is the same run, lease_live=true, and active_run agrees
    db.execute(
        f"""INSERT INTO agent_wake_state (agent_id, wake_lease_until, lease_kind)
           VALUES (%s, {ts_from_now(300)}, 'ephemeral')""",
        (aid,),
    )
    ag = _agent(await _snap(client, cid), aid)
    assert ag["running_run"]["lease_live"] is True
    assert ag["active_run"]["run_id"] == ag["running_run"]["run_id"]

    # finished runs never surface
    db.execute("UPDATE worker_runs SET status='completed', ended_at=now() WHERE agent_id=%s", (aid,))
    assert _agent(await _snap(client, cid), aid)["running_run"] is None


async def test_conversation_run_lease_is_read_from_its_own_lane(client, db, container, make_agent):
    cid = container["id"]
    aid = (await make_agent("chat"))["agent_id"]
    _run(db, aid, lane="conversation")
    db.execute(
        f"""INSERT INTO agent_wake_state (agent_id, conv_lease_until, conv_lease_kind)
           VALUES (%s, {ts_from_now(300)}, 'resident')""",
        (aid,),
    )
    assert _agent(await _snap(client, cid), aid)["running_run"]["lease_live"] is True


async def test_pause_is_explicit_and_never_stops_a_running_run(client, db, container, make_agent):
    cid = container["id"]
    aid = (await make_agent("dev"))["agent_id"]
    hid = (await make_agent("root", "operator", kind="human"))["agent_id"]
    _run(db, aid)

    snap = await _snap(client, cid)
    ag = _agent(snap, aid)
    assert ag["wakes_paused"] is False and ag["wakes_paused_reason"] is None
    assert ag["pause_stops_running_run"] is False
    assert _agent(snap, hid)["wakes_paused"] is False

    async def claim():
        r = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 60, "lane": "work"})
        assert r.status_code == 200, r.text
        return r.json()["claimed"]

    # agent opt-out: new wakes refused, the in-flight run is still reported running
    db.execute(
        "INSERT INTO agent_reachability (agent_id, wake_enabled) VALUES (%s, false)", (aid,)
    )
    ag = _agent(await _snap(client, cid), aid)
    assert (ag["wakes_paused"], ag["wakes_paused_reason"]) == (True, "agent_wakes_off")
    assert ag["running_run"] is not None
    assert await claim() is False

    # project kill-switch wins over the agent opt-out (wake_claim's order)
    db.execute("UPDATE containers SET wakes_enabled=false WHERE id=%s", (cid,))
    snap = await _snap(client, cid)
    assert _agent(snap, aid)["wakes_paused_reason"] == "project_wakes_off"
    assert _agent(snap, hid)["wakes_paused"] is False  # humans are never woken

    # a paused project (status) wins over both
    db.execute("UPDATE containers SET status='paused' WHERE id=%s", (cid,))
    ag = _agent(await _snap(client, cid), aid)
    assert ag["wakes_paused_reason"] == "project_status"
    assert ag["running_run"] is not None  # pause never ends the run in flight

    # resume everything: not paused, and a claim succeeds again
    db.execute("UPDATE containers SET status='active', wakes_enabled=true WHERE id=%s", (cid,))
    db.execute("UPDATE agent_reachability SET wake_enabled=true WHERE agent_id=%s", (aid,))
    ag = _agent(await _snap(client, cid), aid)
    assert ag["wakes_paused"] is False
    assert await claim() is True
