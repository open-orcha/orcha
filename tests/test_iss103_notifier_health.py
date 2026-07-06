"""#103: portal-visible notifier health + one-click restart.

The notifier is a HOST daemon; the portal (in a container) can't see or signal it. This covers the
shared channel that closes the "wakes on but nothing polling" silent failure:
  - the daemon's heartbeat ingest (POST /notifier/heartbeat) + running/stale/offline derivation,
  - the health read (GET /notifier-health) and its fold into the 5s container snapshot,
  - the human-gated restart REQUEST (intent only) and the heartbeat piggyback a live daemon uses to
    self-heal (re-exec) then ack the request so it never loops.
"""
import time

import main


async def _hb(client, cid, **body):
    return await client.post(f"/api/containers/{cid}/notifier/heartbeat", json=body)


async def _health(client, cid):
    return await client.get(f"/api/containers/{cid}/notifier-health")


# ---------------------------------------------------------------- heartbeat ingest + derivation

async def test_no_heartbeat_is_offline(client, container):
    """A container whose daemon has never reported reads offline (not an error)."""
    r = await _health(client, container["id"])
    assert r.status_code == 200
    assert r.json()["status"] == "offline"


async def test_heartbeat_creates_row_and_reads_running(client, container, db):
    r = await _hb(client, container["id"], pid=4242, version="1.2.3", cwd="/proj",
                  started_at=time.time())
    assert r.status_code == 200, r.text
    assert r.json()["restart_pending"] is False
    h = (await _health(client, container["id"])).json()
    assert h["status"] == "running"
    assert h["pid"] == 4242 and h["version"] == "1.2.3"
    rows = db.execute("SELECT count(*) AS n FROM notifier_health WHERE container_id=%s",
                      (container["id"],))
    assert rows[0]["n"] == 1


async def test_heartbeat_upserts_single_row(client, container, db):
    """Two heartbeats update the same row (one daemon per container), not two rows."""
    await _hb(client, container["id"], pid=1, version="a", started_at=time.time())
    await _hb(client, container["id"], pid=2, version="b", started_at=time.time())
    rows = db.execute("SELECT pid, version FROM notifier_health WHERE container_id=%s",
                      (container["id"],))
    assert len(rows) == 1
    assert rows[0]["pid"] == 2 and rows[0]["version"] == "b"


async def test_stale_then_offline_by_age(client, container, db):
    """Age past the stale threshold reads stale; past the offline threshold reads offline."""
    await _hb(client, container["id"], pid=1, started_at=time.time())
    db.execute("UPDATE notifier_health SET last_seen_at = now() - interval '30 seconds' "
               "WHERE container_id=%s", (container["id"],))
    assert (await _health(client, container["id"])).json()["status"] == "stale"
    db.execute("UPDATE notifier_health SET last_seen_at = now() - interval '120 seconds' "
               "WHERE container_id=%s", (container["id"],))
    assert (await _health(client, container["id"])).json()["status"] == "offline"


async def test_stopped_state_is_offline_even_when_fresh(client, container):
    """A clean shutdown heartbeat (state=stopped) reads offline immediately."""
    await _hb(client, container["id"], pid=1, started_at=time.time(), state="stopped")
    assert (await _health(client, container["id"])).json()["status"] == "offline"


async def test_bad_state_rejected(client, container):
    r = await _hb(client, container["id"], pid=1, started_at=time.time(), state="bogus")
    assert r.status_code == 400


async def test_heartbeat_bad_container_400(client):
    r = await _hb(client, "not-a-uuid", pid=1)
    assert r.status_code == 400


# ---------------------------------------------------------------- snapshot fold

async def test_snapshot_includes_notifier(client, container):
    """GET /api/containers/{cid} carries a compact notifier block for the 5s poll."""
    snap = (await client.get(f"/api/containers/{container['id']}")).json()
    assert snap["container"]["notifier"]["status"] == "offline"   # nothing reported yet
    await _hb(client, container["id"], pid=7, version="9.9", started_at=time.time())
    snap = (await client.get(f"/api/containers/{container['id']}")).json()
    n = snap["container"]["notifier"]
    assert n["status"] == "running" and n["version"] == "9.9" and n["restart_pending"] is False


# ---------------------------------------------------------------- restart request (human-gated)

async def test_restart_request_requires_human(client, container, make_agent):
    ai = await make_agent("dev", "eng")   # kind=ai
    r = await client.post(f"/api/containers/{container['id']}/notifier/restart-request",
                          json={"actor_agent_id": ai["agent_id"]})
    assert r.status_code == 403


async def test_restart_request_offline_gives_manual_fallback(client, container, make_agent, db):
    """No live daemon → self_heal False + the exact manual command; intent still recorded."""
    human = await make_agent("op", "operator", kind="human")
    r = await client.post(f"/api/containers/{container['id']}/notifier/restart-request",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["self_heal"] is False
    assert body["manual_command"] == "orcha notifier --restart"
    rows = db.execute("SELECT restart_requested_at, restart_requested_by "
                      "FROM notifier_health WHERE container_id=%s", (container["id"],))
    assert rows[0]["restart_requested_at"] is not None
    assert str(rows[0]["restart_requested_by"]) == human["agent_id"]


async def test_restart_request_live_daemon_self_heals(client, container, make_agent):
    """A running daemon → self_heal True (it will pick the request up on its next heartbeat)."""
    human = await make_agent("op", "operator", kind="human")
    await _hb(client, container["id"], pid=1, started_at=time.time())
    r = await client.post(f"/api/containers/{container['id']}/notifier/restart-request",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.json()["self_heal"] is True


# ------------------------------------------------- heartbeat piggyback: pending → re-exec → ack

async def test_heartbeat_reports_pending_then_ack_clears_it(client, container, make_agent):
    """The daemon learns of a restart via its heartbeat reply; a boot AFTER the request clears it."""
    human = await make_agent("op", "operator", kind="human")
    # a live (old) daemon is up, then a human requests a restart
    await _hb(client, container["id"], pid=1, started_at=time.time() - 3600)
    await client.post(f"/api/containers/{container['id']}/notifier/restart-request",
                      json={"actor_agent_id": human["agent_id"]})
    # the OLD daemon's next heartbeat (started_at pre-dates the request) still sees it pending
    r = await _hb(client, container["id"], pid=1, started_at=time.time() - 3600)
    assert r.json()["restart_pending"] is True
    # the re-exec'd daemon boots AFTER the request → its heartbeat acks it and won't loop
    r = await _hb(client, container["id"], pid=2, started_at=time.time() + 3600)
    assert r.json()["restart_pending"] is False
    # and it's no longer pending in the snapshot either
    snap = (await client.get(f"/api/containers/{container['id']}")).json()
    assert snap["container"]["notifier"]["restart_pending"] is False
