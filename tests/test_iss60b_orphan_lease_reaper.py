"""ISS-60(B) — heartbeat-keyed orphan-lease reaper (defense-in-depth for ISS-60).

ISS-60 = an orphan single-flight lease blocks ALL wakes for an agent. The short lease TTL the
daemon renews each tick self-heals a worker the daemon still TRACKS, but NOT a lease that outlives
its embodiment (daemon restart / externally-spawned resident whose lease survived an in-memory
live_residents reset). This adds a TTL-independent backstop:

  * POST /api/containers/{cid}/reap-orphan-leases — force-release any LIVE lease whose agent hasn't
    produced a liveness heartbeat in `orphan_secs` (default 1260s > the 1200s watchdog hard-cap).
  * wake-renew now bumps agents.last_heartbeat_at on a SUCCESSFUL renew (the liveness ping) — the
    prereq that makes the reaper safe: an alive-but-quiet resident keeps a fresh heartbeat and is
    never false-orphaned.

The teeth here cover BOTH halves and their interlock (the reaper is unsafe WITHOUT the ping).
"""
import pytest

from orcha_cli import notifier  # noqa: E402  (notifier lives in the CLI package)


# ---------- the liveness ping: wake-renew bumps last_heartbeat_at ----------

@pytest.mark.asyncio
async def test_wake_renew_bumps_heartbeat(client, make_agent, db):
    """A SUCCESSFUL renew is proof-of-life → it must refresh last_heartbeat_at so the reaper
    never orphans an alive-but-quiet embodiment whose only signal is this keep-alive."""
    a = await make_agent("Quiet")
    aid = a["agent_id"]
    # Hold a live lease, then backdate the heartbeat as if the resident has been silent for an hour.
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})
    db.execute("UPDATE agents SET last_heartbeat_at = now() - interval '1 hour' WHERE id=%s", (aid,))

    r = await client.post(f"/api/agents/{aid}/wake-renew", json={"lease_ttl": 180})
    assert r.json()["renewed"] is True

    idle = db.execute(
        "SELECT EXTRACT(EPOCH FROM (now() - last_heartbeat_at)) AS s FROM agents WHERE id=%s",
        (aid,))[0]["s"]
    assert idle < 30, f"renew should have bumped the heartbeat, idle={idle}s"


@pytest.mark.asyncio
async def test_failed_renew_does_not_bump_heartbeat(client, make_agent, db):
    """A renew that finds no LIVE lease is a no-op (renewed:False) and must NOT bump the heartbeat —
    otherwise a released/expired agent would look alive forever."""
    a = await make_agent("NoLease")
    aid = a["agent_id"]
    db.execute("UPDATE agents SET last_heartbeat_at = now() - interval '1 hour' WHERE id=%s", (aid,))

    r = await client.post(f"/api/agents/{aid}/wake-renew", json={"lease_ttl": 180})
    assert r.json()["renewed"] is False  # never claimed → nothing to renew

    idle = db.execute(
        "SELECT EXTRACT(EPOCH FROM (now() - last_heartbeat_at)) AS s FROM agents WHERE id=%s",
        (aid,))[0]["s"]
    assert idle > 3000, f"a failed renew must NOT bump the heartbeat, idle={idle}s"


# ---------- the reaper ----------

@pytest.mark.asyncio
async def test_reaps_stale_heartbeat_lease(client, make_agent, container, db):
    """The core path: a LIVE lease whose agent went heartbeat-silent past the threshold is an
    orphan → released (lease NULLed, embodiment cleared) and the agent becomes wakeable again."""
    cid = container["id"]
    a = await make_agent("Orphan")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})
    db.execute("UPDATE agents SET last_heartbeat_at = now() - interval '2000 seconds' WHERE id=%s", (aid,))

    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert r.status_code == 200, r.text
    reaped = r.json()["reaped"]
    assert [x["agent_id"] for x in reaped] == [aid]
    assert reaped[0]["lease_kind"] == "resident"          # pre-release kind captured for the audit
    assert reaped[0]["idle_seconds"] >= 2000

    # DB: the lease + embodiment are gone.
    row = db.execute(
        "SELECT wake_lease_until, lease_kind FROM agent_wake_state WHERE agent_id=%s", (aid,))[0]
    assert row["wake_lease_until"] is None and row["lease_kind"] is None

    # An audit row was written for portal visibility.
    evs = db.execute(
        "SELECT 1 FROM events WHERE entity_id=%s AND event_type='orphan_lease_reaped'", (aid,))
    assert len(evs) == 1


@pytest.mark.asyncio
async def test_reaped_agent_is_wakeable_again(client, make_agent, container, db):
    """End-to-end intent: before the reap the orphan lease suppresses wakes (lease_active); after the
    reap wake-scan no longer reports a held lease for that agent (the ISS-60 symptom is cleared)."""
    cid = container["id"]
    a = await make_agent("Stuck")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})
    db.execute("UPDATE agents SET last_heartbeat_at = now() - interval '2000 seconds' WHERE id=%s", (aid,))

    scan = await client.get(f"/api/containers/{cid}/wake-scan?cooldown=0&min_idle=0")
    me = [c for c in scan.json()["candidates"] if c["agent_id"] == aid][0]
    assert me["lease_active"] is True                       # orphan lease blocks wakes (ISS-60)

    await client.post(f"/api/containers/{cid}/reap-orphan-leases")

    scan2 = await client.get(f"/api/containers/{cid}/wake-scan?cooldown=0&min_idle=0")
    me2 = [c for c in scan2.json()["candidates"] if c["agent_id"] == aid][0]
    assert me2["lease_active"] is False                     # reaped → wakeable again


@pytest.mark.asyncio
async def test_does_not_reap_fresh_heartbeat(client, make_agent, container, db):
    """Teeth: a live lease with a RECENT heartbeat (a genuinely-active worker) is left alone —
    the reaper keys on heartbeat staleness, not blanket lease release."""
    cid = container["id"]
    a = await make_agent("Busy")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})
    db.execute("UPDATE agents SET last_heartbeat_at = now() WHERE id=%s", (aid,))

    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert r.json()["reaped"] == []
    row = db.execute(
        "SELECT wake_lease_until, lease_kind FROM agent_wake_state WHERE agent_id=%s", (aid,))[0]
    assert row["wake_lease_until"] is not None and row["lease_kind"] == "resident"


@pytest.mark.asyncio
async def test_does_not_reap_null_heartbeat(client, make_agent, container, db):
    """Teeth: a never-beat agent (NULL heartbeat) is NOT an orphan — it has no live embodiment to
    orphan and a just-claimed lease must not be ripped out. Its own short TTL handles it."""
    cid = container["id"]
    a = await make_agent("NeverBeat")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})
    db.execute("UPDATE agents SET last_heartbeat_at = NULL WHERE id=%s", (aid,))

    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases?orphan_secs=0")
    assert r.json()["reaped"] == []                         # NULL is never stale, even at 0s
    row = db.execute(
        "SELECT wake_lease_until FROM agent_wake_state WHERE agent_id=%s", (aid,))[0]
    assert row["wake_lease_until"] is not None


@pytest.mark.asyncio
async def test_does_not_reap_expired_lease(client, make_agent, container, db):
    """Teeth: an already-EXPIRED lease isn't wake-blocking (wake-scan projects lease_active=false),
    so it's out of scope — the reaper only touches a LIVE lease. Expiry self-heals on its own."""
    cid = container["id"]
    a = await make_agent("Expired")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})
    # Force the lease into the past AND backdate the heartbeat.
    db.execute("UPDATE agent_wake_state SET wake_lease_until = now() - interval '60 seconds' "
               "WHERE agent_id=%s", (aid,))
    db.execute("UPDATE agents SET last_heartbeat_at = now() - interval '2000 seconds' WHERE id=%s", (aid,))

    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases?orphan_secs=0")
    assert r.json()["reaped"] == []                         # not LIVE → not in scope


@pytest.mark.asyncio
async def test_threshold_floor_protects_busy_worker(client, make_agent, container, db):
    """Teeth for the >hard-cap floor: a heartbeat 1210s old (between the 1200s watchdog hard-cap and
    the 1260s default) is NOT reaped at the default threshold — a legitimately busy worker that the
    watchdog itself would cap at 1200s is never false-orphaned first."""
    cid = container["id"]
    a = await make_agent("Long")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 1300, "lease_kind": "ephemeral"})
    db.execute("UPDATE agents SET last_heartbeat_at = now() - interval '1210 seconds' WHERE id=%s", (aid,))

    # Default orphan_secs (1260) → 1210s idle is under the bar → safe.
    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert r.json()["reaped"] == []
    # But a tighter (test-only) threshold below the idle DOES reap it — proves the gate is the number.
    r2 = await client.post(f"/api/containers/{cid}/reap-orphan-leases?orphan_secs=600")
    assert [x["agent_id"] for x in r2.json()["reaped"]] == [aid]


@pytest.mark.asyncio
async def test_reap_unknown_container_404s(client):
    """An unknown container id is a 404, not a silent empty reap (matches every sibling route)."""
    import uuid
    r = await client.post(f"/api/containers/{uuid.uuid4()}/reap-orphan-leases")
    assert r.status_code == 404


# ---------- the interlock: the ping is what makes the reaper SAFE ----------

@pytest.mark.asyncio
async def test_renew_rescues_quiet_resident_from_reaper(client, make_agent, container, db):
    """The blocking-prereq proof. A warm resident sitting idle (no turns) goes heartbeat-silent —
    WITHOUT the ping it would be false-orphaned. WITH it, the daemon's per-tick renew refreshes the
    heartbeat, so the reaper leaves it alone. Demonstrated as: stale → renew (ping) → NOT reaped;
    contrasted with stale → (no renew) → reaped."""
    cid = container["id"]
    a = await make_agent("Warm")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})

    # (1) The daemon keeps the resident alive: backdate heartbeat, then renew (the liveness ping).
    db.execute("UPDATE agents SET last_heartbeat_at = now() - interval '2000 seconds' WHERE id=%s", (aid,))
    await client.post(f"/api/agents/{aid}/wake-renew", json={"lease_ttl": 180})
    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert r.json()["reaped"] == [], "the ping should have rescued the quiet resident"

    # (2) Now the daemon is GONE (no renew): heartbeat goes stale and stays stale → reaped.
    db.execute("UPDATE agents SET last_heartbeat_at = now() - interval '2000 seconds' WHERE id=%s", (aid,))
    r2 = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert [x["agent_id"] for x in r2.json()["reaped"]] == [aid]


# ---------- the notifier wiring ----------

def test_notifier_reap_helper_posts_to_endpoint(monkeypatch):
    """The daemon helper is a thin transport call to the server-side reaper."""
    calls = {}

    def _fake_post(url, body=None, **k):
        calls["url"] = url
        return {"reaped": []}

    monkeypatch.setattr(notifier, "_post_json", _fake_post)
    notifier.reap_orphan_leases("http://api", "CID", quiet=True)
    assert calls["url"] == "http://api/api/containers/CID/reap-orphan-leases"


def test_notifier_reap_helper_announces_reaped(monkeypatch, capsys):
    """When the server reports a reaped lease, the (non-quiet) daemon logs it for the operator."""
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body=None, **k: {"reaped": [
                            {"alias": "Ghost", "lease_kind": "resident", "idle_seconds": 1800.0}]})
    notifier.reap_orphan_leases("http://api", "CID", quiet=False)
    out = capsys.readouterr().out
    assert "ORPHAN" in out and "Ghost" in out
