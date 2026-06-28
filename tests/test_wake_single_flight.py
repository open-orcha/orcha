"""R2.4 — single-flight wake guard + global kill-switch.

Regression cover for the wake-daemon runaway (one idle agent spawned ~12 stuck
headless workers because nothing bounded concurrency and there was no off-switch).
The fix has three server-side pieces, all tested here:

  * POST /api/agents/{aid}/wake-claim — an atomic, TTL-bounded, per-agent lease.
    Exactly one concurrent claim wins; the rest get {claimed: false} and must not spawn.
  * wake-scan skips an agent whose lease is live (a worker is already running) and
    honors the global kill-switch.
  * POST /api/containers/{cid}/wakes — flip wakes_enabled to halt ALL waking at once.

Plus the notifier's one-shot tick: when the claim is lost it skips spawning.
"""
import json
import signal
import time

import pytest

from orcha_cli import notifier  # noqa: E402  (notifier lives in the CLI package)


class FakeProc:
    """Stands in for a subprocess.Popen. poll() returns None while 'alive', else the
    exit code — mirroring how the daemon detects (and reaps) an exited worker.
    Records kill()/wait() so the ISS-15 watchdog can be asserted."""
    def __init__(self, pid=4321, exited=False):
        self.pid = pid
        self.returncode = 0 if exited else None
        self.killed = False
    def poll(self):
        return self.returncode
    def kill(self):
        self.killed = True
        self.returncode = -9
    def wait(self, timeout=None):
        return self.returncode


# ---------- the atomic claim ----------

@pytest.mark.asyncio
async def test_claim_is_exclusive_single_flight(client, make_agent):
    a = await make_agent("A")
    aid = a["agent_id"]
    r1 = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})
    assert r1.status_code == 200, r1.text
    assert r1.json()["claimed"] is True
    assert r1.json()["wake_lease_until"]                       # lease handed out

    # A second claim while the lease is live loses — no second worker spawns.
    r2 = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})
    assert r2.status_code == 200, r2.text
    assert r2.json()["claimed"] is False
    assert "live" in r2.json()["reason"]


@pytest.mark.asyncio
async def test_expired_lease_can_be_reclaimed(client, make_agent, db):
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})).json()["claimed"]
    # Force the lease into the past (crash-safe TTL expiry, without a real sleep).
    db.execute("UPDATE agent_wake_state SET wake_lease_until = now() - interval '1 second' "
               "WHERE agent_id = %s", (aid,))
    r = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})
    assert r.json()["claimed"] is True                          # expiry frees the agent


@pytest.mark.asyncio
async def test_wake_renew_extends_live_lease(client, make_agent):
    """Wake-latency: the daemon claims a SHORT lease and renews it each tick while the worker is
    alive. Renewing a LIVE lease keeps single-flight (a competing claim still loses)."""
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 60})).json()["claimed"]
    r = await client.post(f"/api/agents/{aid}/wake-renew", json={"lease_ttl": 300})
    assert r.status_code == 200 and r.json()["renewed"] is True
    c = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})
    assert c.json()["claimed"] is False          # still single — lease live


@pytest.mark.asyncio
async def test_wake_renew_does_not_revive_expired_lease(client, make_agent, db):
    """P2: a renew that races lease EXPIRY must NOT revive it — else it re-blocks wakes for an
    agent no worker owns, defeating the fast-expiry behaviour."""
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 1})).json()["claimed"]
    db.execute("UPDATE agent_wake_state SET wake_lease_until = now() - interval '1 second' "
               "WHERE agent_id = %s", (aid,))
    r = await client.post(f"/api/agents/{aid}/wake-renew", json={"lease_ttl": 300})
    assert r.status_code == 200 and r.json()["renewed"] is False     # not revived
    # the expired lease is reclaimable (renew didn't squat it)
    c = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})
    assert c.json()["claimed"] is True


@pytest.mark.asyncio
async def test_wake_renew_does_not_revive_released_lease(client, make_agent):
    """P2: after a clean worker exit (wake-ack release → wake_lease_until NULL) the row remains;
    a stale/direct renew must NOT re-arm a lease no worker owns."""
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})).json()["claimed"]
    # worker finished + released its lease (NULL), leaving the row in place
    await client.post(f"/api/agents/{aid}/wake-ack", json={"kind": "released", "release_lease": True})
    r = await client.post(f"/api/agents/{aid}/wake-renew", json={"lease_ttl": 300})
    assert r.status_code == 200 and r.json()["renewed"] is False     # released ⇒ nothing to renew
    c = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})
    assert c.json()["claimed"] is True           # agent is wakeable again


@pytest.mark.asyncio
async def test_wake_renew_noop_without_lease(client, make_agent):
    """No wake_state row (no live worker) ⇒ nothing to renew (never creates a phantom lease)."""
    a = await make_agent("A")
    r = await client.post(f"/api/agents/{a['agent_id']}/wake-renew", json={"lease_ttl": 300})
    assert r.status_code == 200 and r.json()["renewed"] is False


@pytest.mark.asyncio
async def test_wake_renew_unknown_agent_404(client, make_agent):
    import uuid
    await make_agent("A")   # ensure a container exists
    r = await client.post(f"/api/agents/{uuid.uuid4()}/wake-renew", json={"lease_ttl": 300})
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_release_via_wake_ack_frees_the_lease(client, make_agent):
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})).json()["claimed"]
    # The daemon's normal cursor-advance ack must NOT release the lease.
    await client.post(f"/api/agents/{aid}/wake-ack", json={"kind": "ephemeral"})
    assert (await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})).json()["claimed"] is False
    # A finished one-shot worker releases it explicitly → next claim wins.
    ack = await client.post(f"/api/agents/{aid}/wake-ack",
                            json={"kind": "ephemeral", "release_lease": True})
    assert ack.status_code == 200, ack.text
    assert ack.json()["wake_lease_until"] is None
    assert (await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})).json()["claimed"] is True


# ---------- the lease feeds the scan ----------

async def _scan(client, cid, aid):
    r = await client.get(f"/api/containers/{cid}/wake-scan", params={"min_idle": 0})
    assert r.status_code == 200, r.text
    body = r.json()
    return body, next((c for c in body["candidates"] if c["agent_id"] == aid), None)


@pytest.mark.asyncio
async def test_live_lease_suppresses_should_wake(client, container, make_agent, make_request):
    a = await make_agent("A")
    b = await make_agent("B")
    await make_request(a["agent_id"], "need input", target_alias="B")
    # Baseline: B has pending work + is idle → should wake.
    _, cand = await _scan(client, container["id"], b["agent_id"])
    assert cand["should_wake"] is True
    # Claim a lease (a worker is now live) → the scan must skip B.
    await client.post(f"/api/agents/{b['agent_id']}/wake-claim", json={"lease_ttl": 300})
    _, cand = await _scan(client, container["id"], b["agent_id"])
    assert cand["lease_active"] is True
    assert cand["should_wake"] is False
    assert "already live" in cand["reason"]


# ---------- E1: embodiment lease kind (ephemeral|resident) + single-embodiment ----------

@pytest.mark.asyncio
async def test_claim_defaults_ephemeral_resident_explicit(client, make_agent):
    """E1: a claim records the embodiment kind — default ephemeral; resident when asked."""
    a = await make_agent("A")
    r = await client.post(f"/api/agents/{a['agent_id']}/wake-claim", json={"lease_ttl": 300})
    assert r.status_code == 200 and r.json()["claimed"] is True
    assert r.json()["lease_kind"] == "ephemeral"          # default

    b = await make_agent("B")
    r = await client.post(f"/api/agents/{b['agent_id']}/wake-claim",
                          json={"lease_ttl": 300, "lease_kind": "resident"})
    assert r.json()["claimed"] is True and r.json()["lease_kind"] == "resident"


@pytest.mark.asyncio
async def test_resident_lease_blocks_ephemeral_and_vice_versa(client, make_agent):
    """E1 single-embodiment: a live RESIDENT lease blocks an ephemeral claim (with the
    single-embodiment reason), and a live EPHEMERAL lease blocks a resident claim."""
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await client.post(f"/api/agents/{aid}/wake-claim",
                              json={"lease_ttl": 300, "lease_kind": "resident"})).json()["claimed"] is True
    # an ephemeral wake can't spawn while the resident session holds the embodiment
    r = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})
    assert r.json()["claimed"] is False
    assert r.json()["lease_kind"] == "resident"
    assert "single-embodiment" in r.json()["reason"]

    # symmetric: a live ephemeral lease blocks a resident claim
    b = await make_agent("B")
    bid = b["agent_id"]
    assert (await client.post(f"/api/agents/{bid}/wake-claim", json={"lease_ttl": 300})).json()["claimed"] is True
    r = await client.post(f"/api/agents/{bid}/wake-claim", json={"lease_ttl": 300, "lease_kind": "resident"})
    assert r.json()["claimed"] is False and r.json()["lease_kind"] == "ephemeral"


@pytest.mark.asyncio
async def test_live_lease_claim_and_mutual_exclusion(client, make_agent):
    """§3b: lease_kind='live' (an embedded-terminal embodiment) is a first-class single-flight
    lease — it claims, and it excludes ephemeral/resident both ways (one embodiment per agent)."""
    a = await make_agent("A")
    aid = a["agent_id"]
    r = await client.post(f"/api/agents/{aid}/wake-claim",
                          json={"lease_ttl": 300, "lease_kind": "live"})
    assert r.json()["claimed"] is True and r.json()["lease_kind"] == "live"
    # an ephemeral wake can't spawn while a live terminal holds the embodiment
    r = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})
    assert r.json()["claimed"] is False and r.json()["lease_kind"] == "live"
    assert "single-embodiment" in r.json()["reason"]

    # symmetric: a live resident lease blocks a 'live' terminal claim
    b = await make_agent("B")
    bid = b["agent_id"]
    assert (await client.post(f"/api/agents/{bid}/wake-claim",
                              json={"lease_ttl": 300, "lease_kind": "resident"})).json()["claimed"] is True
    r = await client.post(f"/api/agents/{bid}/wake-claim", json={"lease_ttl": 300, "lease_kind": "live"})
    assert r.json()["claimed"] is False and r.json()["lease_kind"] == "resident"


@pytest.mark.asyncio
async def test_live_lease_suppresses_wake_scan_with_queue_reason(client, container, make_agent, make_request):
    """§3b: while a 'live' terminal lease is held, ephemeral wakes are suppressed and events QUEUE."""
    a = await make_agent("A")
    b = await make_agent("B")
    await make_request(a["agent_id"], "need input", target_alias="B")     # B has pending work
    await client.post(f"/api/agents/{b['agent_id']}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "live"})
    _, cand = await _scan(client, container["id"], b["agent_id"])
    assert cand["lease_active"] is True and cand["lease_kind"] == "live"
    assert cand["should_wake"] is False
    assert "live terminal session is held" in cand["reason"] and "queue" in cand["reason"]


@pytest.mark.asyncio
async def test_invalid_lease_kind_rejected(client, make_agent):
    """The lease_kind enum is closed: ephemeral|resident|live only."""
    a = await make_agent("A")
    r = await client.post(f"/api/agents/{a['agent_id']}/wake-claim",
                          json={"lease_ttl": 300, "lease_kind": "bogus"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_resident_lease_suppresses_wake_scan_with_reason(client, container, make_agent, make_request):
    """E1: wake-scan excludes an agent holding a live resident lease, and says why."""
    a = await make_agent("A")
    b = await make_agent("B")
    await make_request(a["agent_id"], "need input", target_alias="B")     # B has pending work
    await client.post(f"/api/agents/{b['agent_id']}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})
    _, cand = await _scan(client, container["id"], b["agent_id"])
    assert cand["lease_active"] is True
    assert cand["lease_kind"] == "resident"
    assert cand["should_wake"] is False
    assert "resident session is live (single-embodiment)" in cand["reason"]


@pytest.mark.asyncio
async def test_wake_scan_hides_lease_kind_once_lease_expired(client, container, make_agent, make_request, db):
    """E1 review (P2): expiry is the crash/orphan recovery path and does NOT clear the row, so a
    raw projection would surface a stale 'resident' embodiment after the lease lapsed. wake-scan
    must report lease_kind=NULL (no embodiment) the moment the lease is observed expired —
    consistent with lease_active=false / should_wake=true — or future resident orchestration
    misreads a dead session as live."""
    a = await make_agent("A")
    b = await make_agent("B")
    await make_request(a["agent_id"], "need input", target_alias="B")   # B has pending work
    await client.post(f"/api/agents/{b['agent_id']}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})
    # While live: scan exposes the resident embodiment and suppresses the wake.
    _, cand = await _scan(client, container["id"], b["agent_id"])
    assert cand["lease_active"] is True and cand["lease_kind"] == "resident"
    # Force the lease into the past (crash-safe TTL expiry, row left intact — no release).
    db.execute("UPDATE agent_wake_state SET wake_lease_until = now() - interval '1 second' "
               "WHERE agent_id = %s", (b["agent_id"],))
    # cooldown=0 isolates the lease behaviour from the post-claim debounce window.
    r = await client.get(f"/api/containers/{container['id']}/wake-scan",
                         params={"min_idle": 0, "cooldown": 0})
    cand = next(c for c in r.json()["candidates"] if c["agent_id"] == b["agent_id"])
    assert cand["lease_active"] is False            # lease lapsed
    assert cand["should_wake"] is True              # B is wakeable again
    assert cand["lease_kind"] is None               # ...and shows NO stale embodiment


@pytest.mark.asyncio
async def test_release_clears_lease_kind(client, make_agent, db):
    """E1: releasing the lease (wake-ack release_lease) clears the embodiment label to NULL —
    a released agent shows no embodiment, not a stale kind."""
    a = await make_agent("A")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300, "lease_kind": "resident"})
    assert db.execute("SELECT lease_kind FROM agent_wake_state WHERE agent_id=%s", (aid,))[0]["lease_kind"] == "resident"
    ack = await client.post(f"/api/agents/{aid}/wake-ack", json={"kind": "resident", "release_lease": True})
    assert ack.status_code == 200
    row = db.execute("SELECT wake_lease_until, lease_kind FROM agent_wake_state WHERE agent_id=%s", (aid,))[0]
    assert row["wake_lease_until"] is None and row["lease_kind"] is None


# ---------- ISS-69(b): terminal-preempts-an-idle-resident yield request ----------

async def _claim(client, aid, **body):
    return (await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300, **body})).json()


@pytest.mark.asyncio
async def test_preempt_records_yield_request_against_idle_resident(client, make_agent, db):
    """A live-terminal claim with preempt=1, blocked by a RESIDENT, does NOT just refuse: it records
    a yield request on the held row (reason 'yield_pending') so the daemon can hand off the idle
    resident. The lease is NOT taken here — single-flight still holds until the resident releases."""
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await _claim(client, aid, lease_kind="resident"))["claimed"] is True
    r = await _claim(client, aid, lease_kind="live", preempt=True)
    assert r["claimed"] is False
    assert r["reason"] == "yield_pending"
    assert r["preempt_requested"] is True
    assert r["lease_kind"] == "resident"                      # holder unchanged (no steal)
    row = db.execute("SELECT lease_kind, preempt_requested_at, preempt_for "
                     "FROM agent_wake_state WHERE agent_id=%s", (aid,))[0]
    assert row["lease_kind"] == "resident"                    # resident STILL holds the lease
    assert row["preempt_requested_at"] is not None            # ...but a yield is now requested
    assert row["preempt_for"] == "live"


@pytest.mark.asyncio
async def test_preempt_has_no_effect_on_ephemeral_holder(client, make_agent, db):
    """Only a resident yields. An ephemeral wake worker is doing task work — preempt must NOT flag it;
    the terminal stays a hard refusal (single-embodiment), no yield request recorded."""
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await _claim(client, aid))["claimed"] is True     # ephemeral (default)
    r = await _claim(client, aid, lease_kind="live", preempt=True)
    assert r["claimed"] is False
    assert r["reason"] != "yield_pending" and "single" in r["reason"]
    row = db.execute("SELECT preempt_requested_at FROM agent_wake_state WHERE agent_id=%s", (aid,))[0]
    assert row["preempt_requested_at"] is None                # ephemeral holder never gets a yield flag


@pytest.mark.asyncio
async def test_ephemeral_claim_with_preempt_cannot_evict_resident(client, make_agent, db):
    """[review blocking] ISS-69(b) is scoped to the HUMAN terminal 'Pair anyway' path. An autonomous
    EPHEMERAL wake that sets preempt=true while a resident holds the lease must NOT yield the warm
    resident — it gets the normal single-embodiment denial, with NO yield request recorded. The
    preempt branch is gated on the REQUESTING kind being 'live', not just on preempt=true."""
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await _claim(client, aid, lease_kind="resident"))["claimed"] is True
    r = await _claim(client, aid, lease_kind="ephemeral", preempt=True)   # ephemeral, NOT live
    assert r["claimed"] is False
    assert r["reason"] != "yield_pending" and "single-embodiment" in r["reason"]
    assert r.get("preempt_requested") is not True
    row = db.execute("SELECT preempt_requested_at, preempt_for FROM agent_wake_state WHERE agent_id=%s", (aid,))[0]
    assert row["preempt_requested_at"] is None and row["preempt_for"] is None   # resident not flagged to yield


@pytest.mark.asyncio
async def test_preempt_has_no_effect_on_another_live_terminal(client, make_agent, db):
    """A second live terminal does not preempt the first — two humans don't auto-evict each other."""
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await _claim(client, aid, lease_kind="live"))["claimed"] is True
    r = await _claim(client, aid, lease_kind="live", preempt=True)
    assert r["claimed"] is False and r["reason"] != "yield_pending"
    row = db.execute("SELECT preempt_requested_at FROM agent_wake_state WHERE agent_id=%s", (aid,))[0]
    assert row["preempt_requested_at"] is None


@pytest.mark.asyncio
async def test_no_preempt_flag_without_the_flag(client, make_agent, db):
    """Default (preempt omitted/false): a resident-blocked claim is the unchanged single-embodiment
    refusal — no yield request. Mutation guard: the flag must be OPT-IN."""
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await _claim(client, aid, lease_kind="resident"))["claimed"] is True
    r = await _claim(client, aid, lease_kind="live")          # no preempt
    assert r["claimed"] is False
    assert r["reason"] != "yield_pending" and r.get("preempt_requested") is not True
    row = db.execute("SELECT preempt_requested_at FROM agent_wake_state WHERE agent_id=%s", (aid,))[0]
    assert row["preempt_requested_at"] is None


@pytest.mark.asyncio
async def test_wake_renew_surfaces_preempt_requested(client, make_agent):
    """The daemon reads the yield request back on the heartbeat it already sends each tick:
    wake-renew returns preempt_requested True once a yield is pending, False otherwise."""
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await _claim(client, aid, lease_kind="resident"))["claimed"] is True
    # before any preempt: heartbeat says no yield pending
    r0 = await client.post(f"/api/agents/{aid}/wake-renew", json={"lease_ttl": 300})
    assert r0.json()["renewed"] is True and r0.json()["preempt_requested"] is False
    # a terminal preempts → heartbeat now flags it
    assert (await _claim(client, aid, lease_kind="live", preempt=True))["reason"] == "yield_pending"
    r1 = await client.post(f"/api/agents/{aid}/wake-renew", json={"lease_ttl": 300})
    assert r1.json()["renewed"] is True and r1.json()["preempt_requested"] is True


@pytest.mark.asyncio
async def test_release_clears_preempt_flag(client, make_agent, db):
    """When the idle resident yields (wake-ack release), the pending yield request is cleared — the
    next embodiment never inherits a stale flag."""
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await _claim(client, aid, lease_kind="resident"))["claimed"] is True
    assert (await _claim(client, aid, lease_kind="live", preempt=True))["reason"] == "yield_pending"
    await client.post(f"/api/agents/{aid}/wake-ack", json={"kind": "resident_preempted", "release_lease": True})
    row = db.execute("SELECT wake_lease_until, lease_kind, preempt_requested_at, preempt_for "
                     "FROM agent_wake_state WHERE agent_id=%s", (aid,))[0]
    assert row["wake_lease_until"] is None and row["lease_kind"] is None
    assert row["preempt_requested_at"] is None and row["preempt_for"] is None


@pytest.mark.asyncio
async def test_fresh_claim_clears_stale_preempt_flag(client, make_agent, db):
    """After the resident yields and the terminal claims 'live', the new holder's row carries NO
    stale yield request (a fresh claim clears it)."""
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await _claim(client, aid, lease_kind="resident"))["claimed"] is True
    assert (await _claim(client, aid, lease_kind="live", preempt=True))["reason"] == "yield_pending"
    # resident yields (release), then the terminal wins the lease
    await client.post(f"/api/agents/{aid}/wake-ack", json={"kind": "resident_preempted", "release_lease": True})
    assert (await _claim(client, aid, lease_kind="live"))["claimed"] is True
    row = db.execute("SELECT lease_kind, preempt_requested_at FROM agent_wake_state WHERE agent_id=%s", (aid,))[0]
    assert row["lease_kind"] == "live" and row["preempt_requested_at"] is None


# ---------- the global kill-switch ----------

@pytest.mark.asyncio
async def test_kill_switch_blocks_scan_and_claim(client, container, make_agent, make_request):
    a = await make_agent("A")
    b = await make_agent("B")
    await make_request(a["agent_id"], "need input", target_alias="B")

    off = await client.post(f"/api/containers/{container['id']}/wakes", json={"enabled": False})
    assert off.status_code == 200, off.text
    assert off.json()["wakes_enabled"] is False

    body, cand = await _scan(client, container["id"], b["agent_id"])
    assert body["wakes_enabled"] is False
    assert cand["should_wake"] is False
    assert "kill-switch" in cand["reason"]

    # The claim is refused at the enforcement point, so no worker spawns.
    claim = await client.post(f"/api/agents/{b['agent_id']}/wake-claim", json={"lease_ttl": 300})
    assert claim.json()["claimed"] is False
    assert "kill-switch" in claim.json()["reason"]

    # Re-enable → waking resumes turnkey.
    on = await client.post(f"/api/containers/{container['id']}/wakes", json={"enabled": True})
    assert on.json()["wakes_enabled"] is True
    assert (await client.post(f"/api/agents/{b['agent_id']}/wake-claim", json={"lease_ttl": 300})).json()["claimed"] is True


# ---------- the notifier obeys the claim ----------

def test_tick_skips_spawn_when_claim_lost(monkeypatch):
    """When wake-claim returns claimed=false, tick must NOT spawn a headless worker."""
    cand = {"agent_id": "00000000-0000-0000-0000-000000000001", "alias": "B",
            "should_wake": True, "headless_cwd": "/proj", "tmux_target": None,
            "pending_events": 1, "auto_start_task_ids": [], "reason": "wake",
            "latest_event": "request_created", "max_event_ts": 5.0, "headless_flags": None}
    monkeypatch.setattr(notifier, "_get_json",
                        lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: posts.append((url, body)) or {"claimed": False, "reason": "a worker is already live"})
    spawned = []
    monkeypatch.setattr(notifier, "spawn_headless",
                        lambda *a, **k: spawned.append(a) or (True, "cmd", 999))

    out = notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True)

    assert spawned == []                                   # claim lost → never spawned
    assert out["woke"] == []
    assert any("wake-claim" in url for url, _ in posts)     # but it did try to claim


# ---------- portal-first reachability backfill (portal-created agents are wakeable turnkey) ----------

def _portal_cand(**over):
    """A portal-created agent: wake_enabled + has work, but NO reachability (no cwd, no pane)."""
    c = {"agent_id": "00000000-0000-0000-0000-000000000009", "alias": "Portal",
         "should_wake": True, "headless_cwd": None, "tmux_target": None, "wake_enabled": True,
         "pending_events": 1, "auto_start_task_ids": [], "reason": "wake",
         "latest_event": "task_message", "max_event_ts": 5.0, "headless_flags": None}
    c.update(over)
    return c


def test_tick_backfills_reachability_for_portal_agent(monkeypatch):
    """A portal-created agent has no agent_reachability row → the daemon has nowhere to spawn it
    and it can't be woken by anything. tick() auto-records headless_cwd = its project dir, so the
    agent becomes spawnable THIS tick (no extra-tick latency) and is woken."""
    cand = _portal_cand()
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    posts = []

    def _post(url, body, **k):
        posts.append((url, body))
        if url.endswith("/reachability"):
            return {"agent_id": cand["agent_id"], "headless_cwd": body["headless_cwd"], "wake_enabled": True}
        if "wake-claim" in url:
            return {"claimed": True, "wake_lease_until": "x"}
        if url.endswith("/runs"):
            return {"run_id": "RUN-1", "status": "running"}
        return {}
    monkeypatch.setattr(notifier, "_post_json", _post)
    proc = FakeProc(pid=4321)
    spawned = []
    monkeypatch.setattr(notifier, "spawn_headless",
                        lambda *a, **k: spawned.append((a, k)) or (True, "cmd", proc))
    live = {}

    # NOTE: select_transport is the REAL one — after the backfill sets headless_cwd it returns
    # 'ephemeral', proving the in-memory backfill makes the agent spawnable in the same tick.
    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True,
                  live_workers=live, base_cwd="/proj")

    reach = next(b for u, b in posts if u.endswith("/reachability"))
    assert reach == {"headless_cwd": "/proj"}              # only headless_cwd → wake_enabled untouched
    assert cand["headless_cwd"] == "/proj"                 # backfilled in-memory → spawnable now
    assert len(spawned) == 1                               # and it actually woke this tick
    assert cand["agent_id"] in live


def test_tick_backfill_is_trigger_agnostic(monkeypatch):
    """The backfill sits at the TRANSPORT layer (below should_wake), so the one fix makes a
    portal-created agent wakeable for EVERY trigger that sets should_wake — task-thread messages,
    info/task REQUESTS, decisions/approvals, and prompts (Tim addendum 0d8f4981). Here the trigger
    is a request event; the backfill + spawn path is identical regardless of the event type."""
    cand = _portal_cand(latest_event="request_created")     # an info/task request, not a task message
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    posts = []

    def _post(url, body, **k):
        posts.append((url, body))
        if url.endswith("/reachability"):
            return {"agent_id": cand["agent_id"], "headless_cwd": body["headless_cwd"], "wake_enabled": True}
        if "wake-claim" in url:
            return {"claimed": True, "wake_lease_until": "x"}
        if url.endswith("/runs"):
            return {"run_id": "RUN-1"}
        return {}
    monkeypatch.setattr(notifier, "_post_json", _post)
    spawned = []
    monkeypatch.setattr(notifier, "spawn_headless",
                        lambda *a, **k: spawned.append((a, k)) or (True, "cmd", FakeProc(pid=4321)))

    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True,
                  live_workers={}, base_cwd="/proj")

    assert any(u.endswith("/reachability") for u, _ in posts)   # backfilled regardless of trigger
    assert len(spawned) == 1                                    # request trigger wakes it too


def test_tick_no_reachability_backfill_when_already_reachable(monkeypatch):
    """A CLI-registered agent already has a headless_cwd — never re-recorded."""
    cand = _portal_cand(headless_cwd="/existing")
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    posts = []

    def _post(url, body, **k):
        posts.append((url, body))
        return {"claimed": True} if "wake-claim" in url else ({"run_id": "R"} if url.endswith("/runs") else {})
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier, "spawn_headless", lambda *a, **k: (True, "cmd", FakeProc()))

    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True,
                  live_workers={}, base_cwd="/proj")

    assert not any(u.endswith("/reachability") for u, _ in posts)   # already reachable → no backfill


def test_tick_backfill_respects_wake_disabled_optout(monkeypatch):
    """A human opt-out (wake_enabled=false) is never auto-recorded reachable — we don't drag a
    deliberately-disabled agent back into the wakeable pool."""
    cand = _portal_cand(wake_enabled=False, should_wake=False)
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": [cand]})
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)) or {})
    spawned = []
    monkeypatch.setattr(notifier, "spawn_headless", lambda *a, **k: spawned.append(a) or (True, "c", FakeProc()))

    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True,
                  live_workers={}, base_cwd="/proj")

    assert not any(u.endswith("/reachability") for u, _ in posts)
    assert spawned == []


def test_tick_spawns_when_claim_won(monkeypatch):
    cand = {"agent_id": "00000000-0000-0000-0000-000000000001", "alias": "B",
            "should_wake": True, "headless_cwd": "/proj", "tmux_target": None,
            "pending_events": 1, "auto_start_task_ids": [], "reason": "wake",
            "latest_event": "request_created", "max_event_ts": 5.0, "headless_flags": None}
    monkeypatch.setattr(notifier, "_get_json",
                        lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    def _post(url, body, **k):
        if "wake-claim" in url:
            return {"claimed": True, "wake_lease_until": "x"}
        if url.endswith("/runs"):
            return {"run_id": "RUN-1", "status": "running"}   # A2: start-run record
        return {}
    monkeypatch.setattr(notifier, "_post_json", _post)
    spawned = []
    proc = FakeProc(pid=4321)
    monkeypatch.setattr(notifier, "spawn_headless",
                        lambda *a, **k: spawned.append((a, k)) or (True, "cmd", proc))
    live = {}

    out = notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0,
                        quiet=True, live_workers=live)

    assert len(spawned) == 1                                # claim won → spawned once
    assert spawned[0][1].get("log_path") is not None        # per-wake log routed
    assert out["woke"][0]["sent"] is True
    w = live["00000000-0000-0000-0000-000000000001"]
    assert w["proc"] is proc and w["hard_deadline"] > time.time()  # dict record (ISS-31 hard-cap backstop)
    assert "last_progress_ts" in w                                  # ISS-31 stall tracking
    assert w["run_id"] == "RUN-1" and w["log_path"] is not None  # A2: run tracked for /finish


def test_tick_isolates_task_message_wake_in_worktree(monkeypatch):
    """PR #132 review [P1]: a task_message wake is actionable (ISS-55 — worker reads the thread
    and may edit code, e.g. 'rebase onto main'). With no auto-start task it must STILL provision
    an isolated worktree (keyed off wake_task_id) and run there, NOT in the shared headless_cwd —
    else it bypasses ISS-8 and collides with other workers."""
    cand = {"agent_id": "00000000-0000-0000-0000-000000000001", "alias": "B",
            "should_wake": True, "headless_cwd": "/proj", "tmux_target": None,
            "pending_events": 1, "auto_start_task_ids": [], "wake_task_id": "TASK-77",
            "reason": "wake", "latest_event": "task_message", "max_event_ts": 5.0,
            "headless_flags": None}
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    prov = []
    monkeypatch.setattr(notifier, "_provision_worktree",
                        lambda base, alias: prov.append((base, alias)) or ("/wt/B", "wake/B"))
    spawned_cwd = []
    monkeypatch.setattr(notifier, "spawn_headless",
                        lambda cwd, *a, **k: spawned_cwd.append(cwd) or (True, "cmd", FakeProc(pid=7)))
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: {"claimed": True} if "wake-claim" in url
                        else ({"run_id": "R"} if url.endswith("/runs") else {}))
    live = {}
    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True, live_workers=live)
    assert prov == [("/proj", "B")]                  # worktree provisioned off the base checkout
    assert spawned_cwd == ["/wt/B"]                  # worker runs IN the worktree, not /proj
    assert live["00000000-0000-0000-0000-000000000001"]["worktree"] == "/wt/B"


def test_tick_attributes_event_wake_run_to_task_via_wake_task_id(monkeypatch):
    """ISS-56: an event-wake with NO auto-start task (e.g. a `task_message` poke) records the
    worker_run against the TRIGGERING event's task (cand.wake_task_id) instead of task_id=NULL,
    so the run shows up in that task's worker feed."""
    cand = {"agent_id": "00000000-0000-0000-0000-000000000001", "alias": "B",
            "should_wake": True, "headless_cwd": "/proj", "tmux_target": None,
            "pending_events": 1, "auto_start_task_ids": [], "wake_task_id": "TASK-77",
            "reason": "wake", "latest_event": "task_message", "max_event_ts": 5.0,
            "headless_flags": None}
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_provision_worktree", lambda b, a: (None, None))
    monkeypatch.setattr(notifier, "spawn_headless", lambda *a, **k: (True, "cmd", FakeProc(pid=7)))
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: posts.append((url, body)) or
                        ({"claimed": True} if "wake-claim" in url else {"run_id": "R"} if url.endswith("/runs") else {}))
    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True,
                  live_workers={})
    run = next(b for u, b in posts if u.endswith("/runs"))
    assert run["task_id"] == "TASK-77"           # ISS-56: attributed, not None


def test_tick_auto_start_task_takes_precedence_over_wake_task_id(monkeypatch):
    """When BOTH an auto-start target and a triggering-event task exist, the auto-start task wins
    (it's the work the worker will actually claim+begin)."""
    cand = {"agent_id": "00000000-0000-0000-0000-000000000001", "alias": "B",
            "should_wake": True, "headless_cwd": "/proj", "tmux_target": None,
            "pending_events": 1, "auto_start_task_ids": ["TASK-AUTO"], "wake_task_id": "TASK-77",
            "reason": "wake", "latest_event": "task_message", "max_event_ts": 5.0,
            "headless_flags": None}
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_provision_worktree", lambda b, a: (None, None))
    monkeypatch.setattr(notifier, "spawn_headless", lambda *a, **k: (True, "cmd", FakeProc(pid=7)))
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: posts.append((url, body)) or
                        ({"claimed": True} if "wake-claim" in url else {"run_id": "R"} if url.endswith("/runs") else {}))
    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True,
                  live_workers={})
    run = next(b for u, b in posts if u.endswith("/runs"))
    assert run["task_id"] == "TASK-AUTO"


def test_tick_persona_and_run_keyed_off_context_task_not_wake_task_id(monkeypatch):
    """GH #58 (R2 fix): when the server says the run-context is task B (context_task_id) while a
    DIFFERENT in_progress task A is the directed wake_task_id, the worker must boot under B's protocol
    and the run must be attributed to B — NOT A. Keying persona/attribution off wake_task_id alone
    (the bug) booted B's worker under A's protocol and logged the run on A's thread."""
    cand = {"agent_id": "00000000-0000-0000-0000-000000000001", "alias": "B",
            "should_wake": True, "headless_cwd": "/proj", "tmux_target": None,
            "pending_events": 1, "auto_start_task_ids": ["TASK-B"],
            "wake_task_id": "TASK-A", "context_task_id": "TASK-B",
            "reason": "wake", "latest_event": "task_assigned", "max_event_ts": 5.0,
            "headless_flags": None}
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    persona_task_ids = []
    monkeypatch.setattr(notifier, "_build_persona",
                        lambda *a, **k: persona_task_ids.append(k.get("task_id")) or None)
    monkeypatch.setattr(notifier, "_provision_worktree", lambda b, a: (None, None))
    monkeypatch.setattr(notifier, "spawn_headless", lambda *a, **k: (True, "cmd", FakeProc(pid=7)))
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: posts.append((url, body)) or
                        ({"claimed": True} if "wake-claim" in url else {"run_id": "R"} if url.endswith("/runs") else {}))
    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True,
                  live_workers={})
    assert persona_task_ids == ["TASK-B"]        # protocol keyed off the context task, not wake_task_id
    run = next(b for u, b in posts if u.endswith("/runs"))
    assert run["task_id"] == "TASK-B"            # run attributed to the context task


def test_hardcap_floored_independent_of_small_lease_ttl(monkeypatch):
    """ISS-31 + wake-latency: a small lease_ttl (e.g. a stale 300s daemon launch) must NOT lower
    the worker hard cap — `hard_deadline` is floored at HARD_CAP_MIN_SECS so a still-progressing
    worker is never SIGKILLed at 300s. AND the single-flight claim lease is now the SHORT
    renewable WAKE_LEASE_TTL_SECS (decoupled from the cap), so a crashed worker's lease can't
    starve a fresh event for the full 1200s."""
    cand = {"agent_id": "00000000-0000-0000-0000-000000000001", "alias": "B",
            "should_wake": True, "headless_cwd": "/proj", "tmux_target": None,
            "pending_events": 1, "auto_start_task_ids": [], "reason": "wake",
            "latest_event": "task_assigned", "max_event_ts": 5.0, "headless_flags": None}
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_provision_worktree", lambda b, a: (None, None))
    monkeypatch.setattr(notifier, "spawn_headless", lambda *a, **k: (True, "cmd", FakeProc(pid=7)))
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: posts.append((url, body)) or
                        ({"claimed": True} if "wake-claim" in url else {"run_id": "R"} if url.endswith("/runs") else {}))
    live = {}
    # STALE small lease_ttl=300 (the live-failure scenario)
    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True,
                  lease_ttl=300.0, live_workers=live)

    claim = next(b for u, b in posts if "wake-claim" in u)
    assert claim["lease_ttl"] == notifier.WAKE_LEASE_TTL_SECS  # SHORT renewable lease, decoupled from cap
    w = live["00000000-0000-0000-0000-000000000001"]
    assert w["hard_deadline"] > time.time() + 1000            # ~1200s cap, NOT ~300 → no premature kill
    assert w["worktree"] is None                              # ISS-8: no auto_start task -> no worktree


def test_tick_releases_lease_when_headless_spawn_fails(monkeypatch):
    """Claim won but the headless spawn failed (no claude / bad cwd / Popen error):
    no worker exists, so the wake-ack must release the lease (release_lease=true) —
    otherwise the agent is suppressed for the whole TTL for nothing."""
    cand = {"agent_id": "00000000-0000-0000-0000-000000000001", "alias": "B",
            "should_wake": True, "headless_cwd": "/proj", "tmux_target": None,
            "pending_events": 1, "auto_start_task_ids": [], "reason": "wake",
            "latest_event": "request_created", "max_event_ts": 5.0, "headless_flags": None}
    monkeypatch.setattr(notifier, "_get_json",
                        lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: posts.append((url, body)) or (
                            {"claimed": True, "wake_lease_until": "x"} if "wake-claim" in url else {}))
    # spawn fails (e.g. claude missing) → (False, repr, None)
    monkeypatch.setattr(notifier, "spawn_headless", lambda *a, **k: (False, "cmd", None))
    live = {}

    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0,
                  quiet=True, live_workers=live)

    assert live == {}                                        # nothing tracked (no worker)
    ack = next(b for url, b in posts if url.endswith("/wake-ack"))
    assert ack["release_lease"] is True                      # lease we won is released
    assert ack["kind"] == "ephemeral_failed"


# ---------- the reaper releases leases on worker exit (P1) ----------

def test_reap_releases_lease_for_exited_worker(monkeypatch):
    """A finished worker's lease must be released immediately, not held for the TTL.

    Uses proc.poll() (returns the exit code) — NOT os.kill(pid,0), which would report
    the just-exited child as a zombie 'alive' and never release."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: posts.append((url, body)))
    live = {"agent-X": {"proc": FakeProc(exited=True), "deadline": time.time() + 100,
                         "run_id": None, "log_path": None, "worktree": None}}   # exited, no run tracked

    notifier.reap_workers("http://x", live, quiet=True)

    assert live == {}                                        # stopped tracking it
    # GH #58: a CLEAN exit (rc 0) first acks the run's handled-set (empty here — no ids tracked),
    # then releases the lease via wake-ack. Two posts in that order.
    ack_handled = next(b for url, b in posts if url.endswith("/events/ack-handled"))
    assert ack_handled["event_ids"] == []                    # nothing to ack, but the seam still fires
    ack = next(b for url, b in posts if url.endswith("/wake-ack"))
    assert ack["release_lease"] is True                      # lease released, not TTL-held
    assert ack["kind"] == "released"                         # clean exit, not a kill


def test_reap_finishes_run_with_captured_output(monkeypatch, tmp_path):
    """A2: on reap, the worker_runs row is finished via /finish carrying the captured
    stream-json output read from the per-wake log, in addition to releasing the lease."""
    log = tmp_path / "w.log"
    log.write_text('{"type":"system","subtype":"init"}\n{"type":"assistant","message":"done"}\n')
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    live = {"agent-X": {"proc": FakeProc(exited=True), "deadline": time.time() + 100,
                         "run_id": "RUN-9", "log_path": str(log), "worktree": None}}

    notifier.reap_workers("http://x", live, quiet=True)

    finish = next(b for u, b in posts if u.endswith("/runs/RUN-9/finish"))
    assert finish["status"] == "exited"
    assert '"assistant"' in finish["output"]                 # captured the live log text
    assert any(u.endswith("/wake-ack") for u, _ in posts)    # lease still released
    assert live == {}


def test_reap_keeps_lease_for_live_worker(monkeypatch):
    """A still-running worker keeps its lease (single-flight holds) AND the daemon RENEWS it each
    tick (wake-latency fix) so the short lease doesn't lapse mid-run."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    proc = FakeProc(exited=False)                            # poll() -> None (alive)
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 100,
                         "last_size": 0, "last_progress_ts": time.time(),
                         "run_id": None, "log_path": None, "worktree": None}}   # alive, recent progress

    notifier.reap_workers("http://x", live, quiet=True)

    assert "agent-X" in live and live["agent-X"]["proc"] is proc  # still tracked
    assert proc.killed is False                              # not killed (within stall window + cap)
    # the only post is a lease renewal (no release/finish for a live, progressing worker)
    renew = [(u, b) for u, b in posts if u.endswith("/wake-renew")]
    assert renew == [("http://x/api/agents/agent-X/wake-renew",
                      {"lease_ttl": notifier.WAKE_LEASE_TTL_SECS})]
    assert not [u for u, _ in posts if u.endswith("/wake-ack") or u.endswith("/finish")]


# ---------- FT-ENGINE: workers observable (A1/ISS-17) + watchdog (ISS-15) ----------

def test_spawn_uses_stream_json_for_live_logs(monkeypatch, tmp_path):
    """A1/ISS-17: a woken worker is launched with --output-format stream-json --verbose
    so its per-wake log fills with live NDJSON events (not a single end-of-run blob)."""
    captured = {}

    class P:
        def __init__(self, argv, **kw):
            captured["argv"] = argv
            self.pid = 1
    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(notifier.subprocess, "Popen", P)
    sent, _, _ = notifier.spawn_headless(str(tmp_path), "wake!", None, dry_run=False, alias="B")
    argv = captured["argv"]
    assert sent is True
    assert "--output-format" in argv and argv[argv.index("--output-format") + 1] == "stream-json"
    assert "--verbose" in argv


def test_watchdog_kills_process_group_at_hard_cap(monkeypatch):
    """ISS-15/ISS-45: a worker past the hard-cap backstop is KILLED, hitting the whole process
    GROUP (workers run with start_new_session → claude's tool subprocesses share its group; a
    bare proc.kill() would orphan them). ISS-45: even the hard-cap kill is GRACEFUL — SIGTERM
    to the group first so SessionEnd (the C1 digest) can run before SIGKILL."""
    posts = []
    killed = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)   # start_new_session => pgid == pid
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: killed.append((pgid, sig)))
    proc = FakeProc(pid=4321, exited=False)                  # still 'running', exits on SIGTERM
    # recent progress (not stalled) but PAST the hard-cap backstop → killed on the cap
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() - 1,
                         "last_size": 0, "last_progress_ts": time.time(),
                         "run_id": None, "log_path": None, "worktree": None}}

    notifier.reap_workers("http://x", live, quiet=True)

    assert killed and killed[0] == (4321, signal.SIGTERM)    # the GROUP got SIGTERM first (graceful)
    assert live == {}                                        # no orphan left tracked
    # a renew may precede the kill (live worker); the terminal post is the kill wake-ack
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "worker_timeout_killed"            # hard-cap kill
    assert ack["release_lease"] is True


# ---------- ISS-31: progress-aware watchdog ----------

def test_progressing_worker_survives_past_old_deadline(monkeypatch, tmp_path):
    """ISS-31: a slow-but-PROGRESSING worker (log growing) is NOT killed even well past the
    old 300s lease — only stall kills it."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    log = tmp_path / "w.log"
    log.write_text('{"type":"assistant"}\n')                 # log has content (grew from 0)
    proc = FakeProc(exited=False)
    # been alive ~6 min (well past old 300s) but last_size=0 so this tick SEES growth → progress
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 1200,
                         "last_size": 0, "last_progress_ts": time.time() - 360,
                         "run_id": None, "log_path": str(log), "worktree": None}}

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert "agent-X" in live and not proc.killed              # progressing → survives past 300s
    # only a lease renewal — no release/finish for a healthy progressing worker
    assert [u for u, _ in posts] == ["http://x/api/agents/agent-X/wake-renew"]
    assert live["agent-X"]["last_progress_ts"] > time.time() - 5   # progress timestamp refreshed


def test_stalled_worker_killed_and_marked_failed(monkeypatch, tmp_path):
    """ISS-31/ISS-45: a worker whose log hasn't grown for > stall_secs AND shows no liveness
    signal (no in-flight tool / rate-limit) is killed + marked failed — GRACEFULLY (SIGTERM to
    the group first, so SessionEnd/C1 can run, then SIGKILL)."""
    posts, sigs = [], []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    log = tmp_path / "w.log"
    log.write_text("x" * 50)                                 # opaque bytes: no tool_use / rate-limit
    proc = FakeProc(exited=False)
    # last_size already == current size (no growth) and last progress was 200s ago → stalled
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 1200,
                         "last_size": log.stat().st_size, "last_progress_ts": time.time() - 200,
                         "run_id": "R", "log_path": str(log), "worktree": None}}

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert sigs and sigs[0] == (4321, signal.SIGTERM) and live == {}   # graceful kill, released
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "worker_stalled_killed" and ack["release_lease"] is True
    assert any(u.endswith("/runs/R/finish") for u, _ in posts)   # run marked killed


# ---------- #270: watchdog kill diagnostics + worktree preservation ----------

def test_stall_kill_records_structured_kill_reason(monkeypatch, tmp_path):
    """#270 AC1/AC2: a stall-killed worker's /finish carries a STRUCTURED kill_reason (JSON) with
    the diagnostic fields that explain why _worker_is_live returned false — cause, how long it was
    log-silent, the threshold, over_cap, the liveness verdict, and the last stream-json event type."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: None)
    log = tmp_path / "w.log"
    # last event is an assistant TEXT block (no tool_use) → _worker_is_live() == False, so the
    # worker is genuinely stall-killable, and last_event_type resolves to 'assistant'.
    log.write_text('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n')
    proc = FakeProc(exited=False)
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 1200,
                        "last_size": log.stat().st_size, "last_progress_ts": time.time() - 200,
                        "run_id": "R", "log_path": str(log), "worktree": None}}

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    fin = next(b for u, b in posts if u.endswith("/runs/R/finish"))
    assert fin["status"] == "killed"
    assert fin["kill_reason"] is not None                          # the new structured field is set
    diag = json.loads(fin["kill_reason"])                          # it is valid JSON
    assert diag["cause"] == "stalled" and diag["over_cap"] is False
    assert diag["worker_is_live"] is False                         # this is WHY it was killed
    assert diag["last_event_type"] == "assistant"                  # what it was doing when silent
    assert diag["stall_threshold"] == 120 and diag["stall_secs"] >= 120
    assert diag["run_id"] == "R" and diag["agent_id"] == "agent-X"


def test_watchdog_kill_preserves_dirty_worktree(monkeypatch, tmp_path):
    """#270 AC3: a killed worker whose worktree has uncommitted work is PRESERVED — the in-progress
    diff is the only record of what it was doing, so it must NOT be force-removed (pre-#270 the
    reaper called _teardown_worktree unconditionally and discarded it)."""
    posts, torn = [], []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: None)
    monkeypatch.setattr(notifier, "_worktree_is_dirty", lambda wt: True)      # has uncommitted work
    monkeypatch.setattr(notifier, "_teardown_worktree", lambda *a, **k: torn.append(a))
    monkeypatch.setattr(notifier, "_capture_diff", lambda wt, **k: "diff")
    log = tmp_path / "w.log"
    log.write_text("x" * 50)                                        # opaque → not live → stall-kill
    proc = FakeProc(exited=False)
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 1200,
                        "last_size": log.stat().st_size, "last_progress_ts": time.time() - 200,
                        "run_id": "R", "log_path": str(log),
                        "worktree": "/wt", "branch": "b", "base_cwd": "/base"}}

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert torn == []                                              # dirty worktree NOT torn down
    assert live == {}                                             # worker still killed + released
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "worker_stalled_killed" and ack["release_lease"] is True


def test_watchdog_kill_removes_clean_worktree(monkeypatch, tmp_path):
    """#270 AC3 complement: a killed worker with a CLEAN worktree is still torn down (no leak), and
    a hard-cap kill records cause='hard_cap' with the liveness verdict + last event type."""
    posts, torn = [], []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: None)
    monkeypatch.setattr(notifier, "_worktree_is_dirty", lambda wt: False)     # nothing to preserve
    monkeypatch.setattr(notifier, "_teardown_worktree", lambda *a, **k: torn.append(a))
    monkeypatch.setattr(notifier, "_capture_diff", lambda wt, **k: None)
    log = tmp_path / "w.log"
    # an in-flight tool_use → _worker_is_live True, but OVER CAP so the exemption is bypassed.
    log.write_text('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1"}]}}\n')
    proc = FakeProc(exited=False)
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() - 1,        # past the hard cap
                        "last_size": log.stat().st_size, "last_progress_ts": time.time(),  # not stalled
                        "run_id": "R", "log_path": str(log),
                        "worktree": "/wt", "branch": "b", "base_cwd": "/base"}}

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert torn and torn[0] == ("/base", "/wt", "b")              # clean worktree torn down
    assert live == {}
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "worker_timeout_killed"
    diag = json.loads(next(b for u, b in posts if u.endswith("/runs/R/finish"))["kill_reason"])
    assert diag["cause"] == "hard_cap" and diag["over_cap"] is True
    assert diag["worker_is_live"] is True and diag["last_event_type"] == "assistant"


# ---------- ISS-39: daemon streams stream-json lines into the DB ----------

def test_pump_one_posts_complete_lines_buffers_partial(monkeypatch, tmp_path):
    """ISS-39: _pump_one POSTs only COMPLETE NDJSON lines (correct start_seq), buffers the
    unterminated tail across calls, and advances the per-worker cursor."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: (posts.append((url, body)) or {"accepted": len(body["lines"])}))
    log = tmp_path / "w.log"
    log.write_bytes(b'{"a":1}\n{"b":2}\n{"par')          # 2 complete + a partial
    w = {"run_id": "R", "log_path": str(log), "lines_offset": 0, "lines_seq": 1, "lines_buf": b""}

    notifier._pump_one("http://x", "agent-X", w)
    assert posts == [("http://x/api/runs/R/lines", {"start_seq": 1, "lines": ['{"a":1}', '{"b":2}']})]
    assert w["lines_seq"] == 3 and w["lines_buf"] == b'{"par'      # tail buffered, seq advanced

    # append the rest of the partial line + one more complete line
    with open(log, "ab") as f:
        f.write(b'tial":3}\n{"c":4}\n')
    notifier._pump_one("http://x", "agent-X", w)
    assert posts[-1] == ("http://x/api/runs/R/lines", {"start_seq": 3, "lines": ['{"partial":3}', '{"c":4}']})
    assert w["lines_seq"] == 5 and w["lines_buf"] == b""


def test_pump_one_retries_same_bytes_on_failed_post(monkeypatch, tmp_path):
    """ISS-39: a failed POST must NOT advance the cursor — the same bytes are retried next
    tick (safe because the insert is idempotent on (run_id, seq))."""
    outcomes = [None, {"accepted": 2}]                  # first POST fails, second succeeds
    posts = []
    def _fake_post(url, body, **k):
        posts.append(body)
        return outcomes.pop(0)
    monkeypatch.setattr(notifier, "_post_json", _fake_post)
    log = tmp_path / "w.log"
    log.write_bytes(b'{"a":1}\n{"b":2}\n')
    w = {"run_id": "R", "log_path": str(log), "lines_offset": 0, "lines_seq": 1, "lines_buf": b""}

    notifier._pump_one("http://x", "agent-X", w)         # POST fails
    assert w["lines_offset"] == 0 and w["lines_seq"] == 1   # cursor NOT advanced
    notifier._pump_one("http://x", "agent-X", w)         # retry succeeds
    assert posts == [{"start_seq": 1, "lines": ['{"a":1}', '{"b":2}']}] * 2   # same batch re-sent
    assert w["lines_seq"] == 3 and w["lines_offset"] == 16


def test_pump_one_noop_without_run_or_log(monkeypatch):
    """ISS-39: nothing to stream when the worker has no run_id or no log_path."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda *a, **k: posts.append(a))
    notifier._pump_one("http://x", "a", {"run_id": None, "log_path": "/x"})
    notifier._pump_one("http://x", "a", {"run_id": "R", "log_path": None})
    assert posts == []


# ---------- ISS-29: a COMPLETED worker is never reaped as 'killed' ----------

def _completed_log(tmp_path, subtype="success"):
    log = tmp_path / "w.log"
    log.write_text('{"type":"assistant","message":{"content":[]}}\n'
                   f'{{"type":"result","subtype":"{subtype}","is_error":false,"duration_ms":356000}}\n')
    return log


def test_completed_worker_awaits_clean_exit_not_killed(monkeypatch, tmp_path):
    """ISS-29: a worker that emitted a terminal `result` has finished — the log stops growing
    so the stall timer trips, but it must NOT be killed. The first reap holds off (records
    result_seen_ts) and leaves it tracked so the next tick can reap a clean exit as 'exited'."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    log = _completed_log(tmp_path)
    proc = FakeProc(exited=False)                                # still 'running' (slow to exit)
    # stalled: no growth this tick (last_size == size) and last progress 200s ago
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 1200,
                        "last_size": log.stat().st_size, "last_progress_ts": time.time() - 200,
                        "run_id": "R", "log_path": str(log), "worktree": None}}

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert "agent-X" in live and not proc.killed                 # completed → not killed, still tracked
    # no wake-ack and no finish yet (ISS-39 line-pump POSTs to /lines, which is unrelated)
    assert not [u for u, _ in posts if u.endswith("/wake-ack") or u.endswith("/finish")]
    assert live["agent-X"]["result_seen_ts"] is not None         # graceful window armed


def test_completed_worker_reaped_as_exited_after_graceful_window(monkeypatch, tmp_path):
    """ISS-29: a completed worker that LINGERS past the graceful-exit window is forced down —
    SIGTERM first (so SessionEnd/C1 can run) — and recorded as `exited`, never `killed`."""
    posts, sigs = [], []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    log = _completed_log(tmp_path)
    proc = FakeProc(pid=4321, exited=False)
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 1200,
                        "last_size": log.stat().st_size, "last_progress_ts": time.time() - 200,
                        "run_id": "R", "log_path": str(log), "worktree": None,
                        "result_seen_ts": time.time() - (notifier.GRACEFUL_EXIT_SECS + 5)}}

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert sigs and sigs[0] == (4321, signal.SIGTERM)            # graceful: SIGTERM first
    assert live == {}                                           # released
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "worker_completed_reaped" and ack["release_lease"] is True
    fin = next((u, b) for u, b in posts if u.endswith("/runs/R/finish"))
    assert fin[1]["status"] == "exited"                         # COMPLETED → exited, not killed
    assert fin[1]["exit_code"] == 0                             # result subtype was 'success'


def test_stalled_worker_without_result_still_killed(monkeypatch, tmp_path):
    """ISS-29/ISS-45 guard: a worker stalled WITHOUT a terminal result and with no liveness
    signal (genuinely stuck mid-work) is still killed + marked failed — neither the completion
    path nor the liveness path may swallow a real stall."""
    posts, sigs = [], []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    log = tmp_path / "w.log"
    log.write_text('{"type":"assistant","message":{"content":[]}}\n')   # no result, no tool_use
    proc = FakeProc(exited=False)
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 1200,
                        "last_size": log.stat().st_size, "last_progress_ts": time.time() - 200,
                        "run_id": "R", "log_path": str(log), "worktree": None}}

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert sigs and sigs[0] == (4321, signal.SIGTERM) and live == {}
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "worker_stalled_killed"
    fin = next(b for u, b in posts if u.endswith("/runs/R/finish"))
    assert fin["status"] == "killed"


# ---------- ISS-45: liveness-aware stall + graceful watchdog kill ----------

class StubbornProc(FakeProc):
    """A worker that IGNORES SIGTERM: the first (graceful) wait() raises, so the kill must
    escalate to SIGKILL. The second wait() (post-SIGKILL reap) returns normally."""
    def __init__(self, pid=4321):
        super().__init__(pid=pid, exited=False)
        self._waited = False
    def wait(self, timeout=None):
        if not self._waited:
            self._waited = True
            raise TimeoutError("ignored SIGTERM")        # graceful window elapsed → SIGKILL
        return self.returncode


def _inflight_tool_log(tmp_path):
    """A stream-json tail ending on an assistant `tool_use` whose `tool_result` hasn't landed —
    a long tool call IN FLIGHT (the exact shape `claude -p` emits; cf. Invy run 5a9c7cbe)."""
    log = tmp_path / "w.log"
    log.write_text(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"running it"}]}}\n'
        '{"type":"assistant","message":{"content":['
        '{"type":"tool_use","id":"toolu_AAA","name":"Bash","input":{"command":"sleep 600"}}]}}\n')
    return log


def _resolved_tool_log(tmp_path):
    """Same tool_use, but its tool_result HAS landed — nothing is in flight any more."""
    log = tmp_path / "w.log"
    log.write_text(
        '{"type":"assistant","message":{"content":['
        '{"type":"tool_use","id":"toolu_AAA","name":"Bash","input":{}}]}}\n'
        '{"type":"user","message":{"content":['
        '{"type":"tool_result","tool_use_id":"toolu_AAA","content":"done"}]}}\n')
    return log


def _rate_limited_log(tmp_path):
    """A tail ending on a rate_limit_event — claude is sleeping off a 429 (alive, just quiet)."""
    log = tmp_path / "w.log"
    log.write_text(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n'
        '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour"}}\n')
    return log


# PR #75 review (P2): some real-shaped streams carry tool_use/tool_result with NO ids — the
# exact shape in tests/test_b1_run_feed.py. An id-only pairing misses an in-flight call here.
def _inflight_tool_log_no_id(tmp_path):
    """An in-flight tool call in the NO-ID stream shape (tool_use has `name`, no `id`)."""
    log = tmp_path / "w.log"
    log.write_text(
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working on it"}]}}\n'
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}\n')
    return log


def _resolved_tool_log_no_id(tmp_path):
    """The NO-ID shape with the tool_result present (no `tool_use_id`) — nothing in flight."""
    log = tmp_path / "w.log"
    log.write_text(
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}\n'
        '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}\n')
    return log


def test_worker_is_live_distinguishes_alive_from_stuck(tmp_path):
    """ISS-45 unit: _worker_is_live is True for an in-flight tool call or a rate-limit backoff,
    and False once the tool resolved / for opaque or missing logs."""
    assert notifier._worker_is_live(str(_inflight_tool_log(tmp_path))) is True
    assert notifier._worker_is_live(str(_rate_limited_log(tmp_path))) is True
    assert notifier._worker_is_live(str(_resolved_tool_log(tmp_path))) is False
    blank = tmp_path / "b.log"
    blank.write_text("xxxx\n{bad json\n")                 # non-JSON / partial → not a liveness signal
    assert notifier._worker_is_live(str(blank)) is False
    assert notifier._worker_is_live(None) is False


def test_worker_is_live_handles_no_id_tool_shape(tmp_path):
    """PR #75 review (P2): tool_use/tool_result without ids (the real-shaped sample in
    test_b1_run_feed.py) must still be paired — an in-flight no-id call is live, a resolved
    no-id call is not. An id-only pairing wrongly reported the in-flight one as stalled."""
    assert notifier._worker_is_live(str(_inflight_tool_log_no_id(tmp_path))) is True
    assert notifier._worker_is_live(str(_resolved_tool_log_no_id(tmp_path))) is False


def test_no_id_inflight_tool_worker_not_stall_killed(monkeypatch, tmp_path):
    """PR #75 review (P2) regression: a worker whose log ends on a NO-ID in-flight tool_use is
    ALIVE — it must NOT be SIGTERM'd / marked worker_stalled_killed (the precise failure the
    reviewer reproduced)."""
    posts, sigs = [], []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    log = _inflight_tool_log_no_id(tmp_path)
    proc = FakeProc(exited=False)
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 1200,
                        "last_size": log.stat().st_size, "last_progress_ts": time.time() - 200,
                        "run_id": "R", "log_path": str(log), "worktree": None}}

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert "agent-X" in live and not proc.killed and sigs == []      # not killed at all
    assert not [u for u, _ in posts if u.endswith("/wake-ack") or u.endswith("/finish")]


def test_worker_is_live_ignores_orphan_tool_result(tmp_path):
    """ISS-45 unit: a tool_result whose tool_use scrolled out of the tail must NOT fabricate a
    false in-flight (its id isn't among the tail's tool_use ids), and a fully-paired tail with a
    trailing resolved call is not 'live'."""
    log = tmp_path / "w.log"
    log.write_text(
        '{"type":"user","message":{"content":['
        '{"type":"tool_result","tool_use_id":"toolu_OLD","content":"x"}]}}\n'      # orphan result
        '{"type":"assistant","message":{"content":['
        '{"type":"tool_use","id":"toolu_BBB","name":"Bash","input":{}}]}}\n'
        '{"type":"user","message":{"content":['
        '{"type":"tool_result","tool_use_id":"toolu_BBB","content":"y"}]}}\n')     # BBB resolved
    assert notifier._worker_is_live(str(log)) is False


def test_inflight_tool_worker_not_stall_killed(monkeypatch, tmp_path):
    """ISS-45: a stalled-LOOKING worker waiting on an in-flight tool call is ALIVE — not killed.
    It stays tracked; when the tool returns the log grows and the stall timer resets naturally."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    log = _inflight_tool_log(tmp_path)
    proc = FakeProc(exited=False)
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 1200,
                        "last_size": log.stat().st_size, "last_progress_ts": time.time() - 200,
                        "run_id": "R", "log_path": str(log), "worktree": None}}

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert "agent-X" in live and not proc.killed             # alive → survives the stall window
    assert not [u for u, _ in posts if u.endswith("/wake-ack") or u.endswith("/finish")]


def test_rate_limited_worker_not_stall_killed(monkeypatch, tmp_path):
    """ISS-45: a worker mid rate-limit backoff (no output while it sleeps off a 429) is ALIVE —
    not stall-killed."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    log = _rate_limited_log(tmp_path)
    proc = FakeProc(exited=False)
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 1200,
                        "last_size": log.stat().st_size, "last_progress_ts": time.time() - 200,
                        "run_id": "R", "log_path": str(log), "worktree": None}}

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert "agent-X" in live and not proc.killed
    assert not [u for u, _ in posts if u.endswith("/wake-ack") or u.endswith("/finish")]


def test_resolved_tool_worker_still_stall_killed(monkeypatch, tmp_path):
    """ISS-45 guard: once the in-flight tool RESOLVED and the worker still produced nothing for
    stall_secs, it's genuinely stuck → killed (gracefully). Liveness must not mask a real stall."""
    posts, sigs = [], []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    log = _resolved_tool_log(tmp_path)
    proc = FakeProc(exited=False)
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 1200,
                        "last_size": log.stat().st_size, "last_progress_ts": time.time() - 200,
                        "run_id": "R", "log_path": str(log), "worktree": None}}

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert sigs and sigs[0] == (4321, signal.SIGTERM) and live == {}
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "worker_stalled_killed"


def test_inflight_tool_worker_killed_at_hard_cap(monkeypatch, tmp_path):
    """ISS-45: liveness only suppresses the STALL kill. A worker that LOOKS alive (in-flight
    tool) but overruns the 1200s hard cap is a genuine runaway and IS reaped — gracefully —
    under the timeout backstop."""
    posts, sigs = [], []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    log = _inflight_tool_log(tmp_path)
    proc = FakeProc(exited=False)
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() - 1,    # PAST the hard cap
                        "last_size": log.stat().st_size, "last_progress_ts": time.time() - 200,
                        "run_id": "R", "log_path": str(log), "worktree": None}}

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert sigs and sigs[0] == (4321, signal.SIGTERM) and live == {}
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "worker_timeout_killed"            # cap backstop, not stall


# ---------- ISS-76 (#194): liveness-aware hard cap + checkpoint-respawn ----------

def _respawn_entry(proc, log, *, respawns=0, cap=1200.0):
    """A live_workers entry for a worker PAST the soft cap but still PROGRESSING (last_size=0 +
    a non-empty log → this tick sees growth → not stalled), with the ISS-76 respawn context."""
    return {"agent-X": {"proc": proc, "hard_deadline": time.time() - 1,   # PAST the soft cap
                        "last_size": 0, "last_progress_ts": time.time(),
                        "run_id": "R1", "log_path": str(log), "worktree": "/wt", "branch": "b",
                        "base_cwd": None, "cap": cap, "respawns": respawns,
                        "respawn_ctx": {"prompt": "drain + continue", "flags": None,
                                        "alias": "Forge", "model": "claude-fable-5",
                                        "model_runtime": "claude",
                                        "task_id": "T1", "event": "task_message"}}}


def test_tick_stores_model_in_respawn_ctx(monkeypatch):
    """[P2 #218] tick() must carry the agent's resolved model INTO respawn_ctx — without it a
    checkpoint-respawn silently reverts the replacement worker to claude's default model
    mid-task, breaking the per-agent model contract (#202)."""
    cand = {"agent_id": "00000000-0000-0000-0000-000000000001", "alias": "B",
            "should_wake": True, "headless_cwd": "/proj", "tmux_target": None,
            "pending_events": 1, "auto_start_task_ids": [], "reason": "wake",
            "latest_event": "request_created", "max_event_ts": 5.0, "headless_flags": None,
            "model": "claude-fable-5", "model_runtime": "claude"}
    monkeypatch.setattr(notifier, "_get_json",
                        lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: {"claimed": True} if "wake-claim" in url
                        else ({"run_id": "RUN-1"} if url.endswith("/runs") else {}))
    monkeypatch.setattr(notifier, "spawn_headless",
                        lambda *a, **k: (True, "cmd", FakeProc(pid=4321)))
    live = {}
    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0,
                  quiet=True, live_workers=live)
    ctx = live["00000000-0000-0000-0000-000000000001"]["respawn_ctx"]
    assert ctx["model"] == "claude-fable-5"
    assert ctx["model_runtime"] == "claude"


def test_progressing_worker_past_cap_is_checkpoint_respawned(monkeypatch, tmp_path):
    """ISS-76: a worker STILL GROWING when it crosses the 1200s soft cap is NOT killed — it is
    checkpoint-respawned: graceful SIGTERM (so SessionEnd/C1 digest runs), run finished as
    `exited` (not killed), worktree KEPT, a fresh worker spawned on it, respawns incremented."""
    posts, sigs, spawned, torn = [], [], [], []
    def _post(url, body, **k):
        posts.append((url, body))
        return {"run_id": "R2"} if url.endswith("/runs") else {}
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: "PERSONA+DIGEST")
    monkeypatch.setattr(notifier, "_capture_diff", lambda wt, **k: "DIFF")
    monkeypatch.setattr(notifier, "_teardown_worktree", lambda *a, **k: torn.append(a))
    newproc = FakeProc(pid=9999, exited=False)
    def _spawn(cwd, prompt, flags, dry_run, **kw):
        spawned.append({"cwd": cwd, "prompt": prompt, "alias": kw.get("alias"),
                        "system_prompt": kw.get("system_prompt"), "model": kw.get("model"),
                        "model_runtime": kw.get("runtime")})
        return True, "repr", newproc
    monkeypatch.setattr(notifier, "spawn_headless", _spawn)

    log = tmp_path / "w.log"
    log.write_text('{"type":"assistant","message":{"content":[{"type":"text","text":"still working"}]}}\n')
    proc = FakeProc(pid=4321, exited=False)
    live = _respawn_entry(proc, log)

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    # graceful checkpoint of the OLD worker (SIGTERM to its group), but NOT a SIGKILL teardown
    assert sigs and sigs[0] == (4321, signal.SIGTERM)
    assert torn == []                                            # worktree KEPT for continuity
    # old run finished as `exited` (work preserved), NOT `killed`
    fin = next(b for u, b in posts if u.endswith("/runs/R1/finish"))
    assert fin["status"] == "exited" and fin["diff"] == "DIFF"
    # respawned on the SAME worktree, AS the agent, with a freshly-rebuilt persona+digest
    assert spawned and spawned[0]["cwd"] == "/wt"
    assert spawned[0]["alias"] == "Forge" and spawned[0]["system_prompt"] == "PERSONA+DIGEST"
    # [P2 #218] ...and on the agent's RESOLVED model — not claude's default (#202 contract)
    assert spawned[0]["model"] == "claude-fable-5"
    assert spawned[0]["model_runtime"] == "claude"
    # a new worker_run recorded for the continuation, tagged checkpoint_respawn
    runpost = next(b for u, b in posts if u.endswith("/runs"))
    assert runpost["wake_event"] == "checkpoint_respawn" and runpost["task_id"] == "T1"
    # the agent is STILL tracked: new proc, respawns bumped, fresh cap, lease NOT released
    w = live["agent-X"]
    assert w["proc"] is newproc and w["respawns"] == 1 and w["run_id"] == "R2"
    assert w["hard_deadline"] > time.time() + 1000              # fresh ~1200s cap
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "worker_checkpoint_respawn" and ack["release_lease"] is False


def test_checkpoint_respawn_budget_exhausted_is_reaped_as_runaway(monkeypatch, tmp_path):
    """ISS-76 runaway backstop: a task still progressing after HARD_CAP_RESPAWN_MAX rollovers is
    no longer respawned — it's gracefully reaped as a timeout kill and its lease released."""
    posts, sigs, spawned, torn = [], [], [], []
    monkeypatch.setattr(notifier, "_post_json", lambda u, b, **k: posts.append((u, b)))
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    monkeypatch.setattr(notifier, "_capture_diff", lambda wt, **k: "DIFF")
    monkeypatch.setattr(notifier, "_teardown_worktree", lambda *a, **k: torn.append(a))
    monkeypatch.setattr(notifier, "spawn_headless",
                        lambda *a, **k: spawned.append(a) or (True, "r", FakeProc()))

    log = tmp_path / "w.log"
    log.write_text('{"type":"assistant","message":{"content":[{"type":"text","text":"still going"}]}}\n')
    proc = FakeProc(pid=4321, exited=False)
    live = _respawn_entry(proc, log, respawns=notifier.HARD_CAP_RESPAWN_MAX)

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert spawned == []                                        # NO respawn past the budget
    assert sigs and sigs[0] == (4321, signal.SIGTERM) and live == {}   # gracefully reaped + released
    assert torn                                                 # worktree torn down on the kill
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "worker_timeout_killed" and ack["release_lease"] is True


def test_checkpoint_respawn_spawn_failure_releases_lease(monkeypatch, tmp_path):
    """ISS-76: if the fresh worker fails to spawn, the agent is not stranded holding a worktree +
    lease forever — the worktree is torn down and the lease released so a later event can wake it."""
    posts, torn = [], []
    def _post(url, body, **k):
        posts.append((url, body))
        return {"run_id": "R2"} if url.endswith("/runs") else {}
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: None)
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: "P")
    monkeypatch.setattr(notifier, "_capture_diff", lambda wt, **k: "D")
    monkeypatch.setattr(notifier, "_teardown_worktree", lambda *a, **k: torn.append(a))
    monkeypatch.setattr(notifier, "spawn_headless", lambda *a, **k: (False, "r", None))

    log = tmp_path / "w.log"
    log.write_text('{"type":"assistant","message":{"content":[{"type":"text","text":"x"}]}}\n')
    live = _respawn_entry(FakeProc(pid=4321, exited=False), log)

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert torn and live == {}                                  # cleaned up, not stranded
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "worker_checkpoint_respawn_failed" and ack["release_lease"] is True


def test_checkpoint_respawn_is_the_mechanism(monkeypatch, tmp_path):
    """Mutation anchor: the ONLY thing sparing a progressing past-cap worker is the ISS-76
    respawn branch. With no respawn_ctx (pre-ISS-76 state) the SAME worker is killed at the cap —
    proving the new branch, not some unrelated guard, is what keeps long tasks alive."""
    posts, sigs = [], []
    monkeypatch.setattr(notifier, "_post_json", lambda u, b, **k: posts.append((u, b)))
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    monkeypatch.setattr(notifier, "_capture_diff", lambda wt, **k: "D")
    monkeypatch.setattr(notifier, "_teardown_worktree", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "spawn_headless", lambda *a, **k: (True, "r", FakeProc()))

    log = tmp_path / "w.log"
    log.write_text('{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}\n')
    live = _respawn_entry(FakeProc(pid=4321, exited=False), log)
    live["agent-X"].pop("respawn_ctx")                          # simulate the pre-ISS-76 entry

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert sigs and live == {}                                  # killed (no respawn possible)
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "worker_timeout_killed"


def test_watchdog_kill_escalates_to_sigkill_when_term_ignored(monkeypatch, tmp_path):
    """ISS-45: the graceful kill is not a free pass — a hung worker that ignores SIGTERM is
    still SIGKILLed after the grace window."""
    posts, sigs = [], []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    log = tmp_path / "w.log"
    log.write_text('{"type":"assistant","message":{"content":[]}}\n')   # no liveness signal
    proc = StubbornProc(pid=4321)
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 1200,
                        "last_size": log.stat().st_size, "last_progress_ts": time.time() - 200,
                        "run_id": "R", "log_path": str(log), "worktree": None}}

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert sigs == [(4321, signal.SIGTERM), (4321, signal.SIGKILL)]      # term first, then kill
    assert live == {}


# ---------- the claim honors the per-agent opt-out (P2) ----------

@pytest.mark.asyncio
async def test_claim_refused_when_agent_opted_out(client, make_agent):
    a = await make_agent("A")
    aid = a["agent_id"]
    # Opt this agent out of wakes (the scan-vs-claim window: disabled after a scan).
    await client.post(f"/api/agents/{aid}/reachability", json={"wake_enabled": False})
    r = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})
    assert r.json()["claimed"] is False
    assert "opt-out" in r.json()["reason"]


def test_once_caps_lease_ttl(monkeypatch):
    """ISS-31 P2: --once has no reaper to release the lease, so the 1200s daemon hard-cap
    would become a 20-min wake-suppression window. --once must cap the lease short."""
    import argparse
    captured = {}
    monkeypatch.setattr(notifier, "tick", lambda *a, **k: captured.update(k))
    args = argparse.Namespace(ensure=False, once=True, api_base="http://x", container="cid",
                              dry_run=False, cooldown=15.0, min_idle=30.0, quiet=True,
                              lease_ttl=1200.0)
    notifier.cmd_notifier(args)
    assert captured["lease_ttl"] == 300.0    # capped for --once, NOT the 1200 daemon default


def test_backfill_base_cwd_gated_on_matching_project_root(monkeypatch, tmp_path):
    """[review P1 x2] The reachability-backfill base_cwd is passed ONLY when cwd is the project
    root FOR THE RESOLVED TARGET — its .claude/orcha.json must name the same api_base + container
    being waked. (a) no config, (b) a config for a DIFFERENT project, and (c) a matching config:
    only (c) backfills. This blocks the run-from-anywhere mode (--api-base/--container) from
    backfilling an unrelated project's cwd, which would spawn a misconfigured worker and lose the
    wake (acked-as-delivered yet undrained)."""
    import argparse, json as _json
    captured = {}
    monkeypatch.setattr(notifier, "tick", lambda *a, **k: captured.update(k))
    monkeypatch.setattr(notifier.pathlib.Path, "cwd", classmethod(lambda cls: tmp_path))
    args = argparse.Namespace(ensure=False, once=True, api_base="http://x", container="cid",
                              dry_run=False, cooldown=15.0, min_idle=30.0, quiet=True,
                              lease_ttl=1200.0)
    cfg = tmp_path / ".claude" / "orcha.json"
    cfg.parent.mkdir()

    # (a) no config at all → backfill disabled
    notifier.cmd_notifier(args)
    assert captured["base_cwd"] is None

    # (b) a config, but for a DIFFERENT api/container → still disabled (the unrelated-project case)
    cfg.write_text(_json.dumps({"api_base_url": "http://OTHER", "current_container_id": "other-cid"}))
    captured.clear()
    notifier.cmd_notifier(args)
    assert captured["base_cwd"] is None

    # (c) a config that MATCHES the resolved target → backfill enabled with this project cwd
    cfg.write_text(_json.dumps({"api_base_url": "http://x", "current_container_id": "cid"}))
    captured.clear()
    notifier.cmd_notifier(args)
    assert captured["base_cwd"] == str(tmp_path)


@pytest.mark.asyncio
async def test_live_claim_returns_cold_signal(client, make_agent):
    """§3b R1: a kind=live claim carries {cold, session_id} so the PTY bridge + Vault know
    whether to cold-boot (inject persona+digest+history) or resume. R1 is cold-only."""
    a = await make_agent("Term")
    r = await client.post(f"/api/agents/{a['agent_id']}/wake-claim",
                          json={"lease_ttl": 180, "lease_kind": "live"})
    d = r.json()
    assert d["claimed"] is True and d["lease_kind"] == "live"
    assert d["cold"] is True and d["session_id"] is None


@pytest.mark.asyncio
async def test_non_live_claim_omits_cold_signal(client, make_agent):
    """ephemeral/resident claims don't carry the live cold-boot fields (additive, live-only)."""
    a = await make_agent("Eph")
    r = await client.post(f"/api/agents/{a['agent_id']}/wake-claim", json={"lease_ttl": 180})
    d = r.json()
    assert d["claimed"] is True
    assert "cold" not in d and "session_id" not in d


# ---------- ISS-#251: partial-message liveness heartbeat + DB-feed filter ----------

def test_is_stream_event_line_classifies_partials():
    """Only `stream_event` partial-delta lines are partials; complete events + garbled lines
    are NOT (fail-soft: a non-JSON line is kept by _pump_one, matching prior behavior)."""
    assert notifier._is_stream_event_line('{"type":"stream_event","event":{"type":"content_block_delta"}}') is True
    assert notifier._is_stream_event_line('{"type":"assistant","message":{"content":[]}}') is False
    assert notifier._is_stream_event_line('{"type":"result","subtype":"success"}') is False
    assert notifier._is_stream_event_line("{bad json") is False
    assert notifier._is_stream_event_line('"a bare string"') is False   # json ok, no .get → kept


def test_pump_one_drops_partials_but_advances_full_offset(monkeypatch, tmp_path):
    """ISS-#251: _pump_one persists complete events to the DB feed but NOT the high-volume
    `stream_event` token deltas — yet it advances the byte cursor past ALL of them (so they
    aren't re-read next tick) and bumps the seq only by the lines actually posted. The deltas
    still live in the host log, which is what the stall watchdog measures for growth."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: (posts.append((url, body)) or {"ok": True}))
    asst = '{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"}]}}'
    se1 = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"a"}}}'
    se2 = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"b"}}}'
    res = '{"type":"result","subtype":"success"}'
    content = "\n".join([asst, se1, se2, res]) + "\n"
    log = tmp_path / "w.log"
    log.write_text(content)
    w = {"log_path": str(log), "run_id": "R", "lines_offset": 0, "lines_seq": 1, "lines_buf": b""}

    notifier._pump_one("http://x", "agent-X", w)

    line_posts = [b for u, b in posts if u.endswith("/runs/R/lines")]
    assert len(line_posts) == 1
    posted = line_posts[0]["lines"]
    assert posted == [asst, res]                       # partials dropped, complete events kept
    assert all('"stream_event"' not in ln for ln in posted)
    assert line_posts[0]["start_seq"] == 1
    assert w["lines_seq"] == 3                          # advanced by the 2 lines posted, not 4 read
    assert w["lines_offset"] == len(content.encode())  # cursor past ALL bytes (partials included)


def test_generating_worker_with_partial_deltas_not_stall_killed(monkeypatch, tmp_path):
    """ISS-#251 regression: a worker mid-generation emits `stream_event` deltas, so its log GROWS
    past the watchdog's last_size → last_progress_ts resets → it is NOT stall-killed even though
    the previous progress mark is older than stall_secs. (The fix: --include-partial-messages
    makes the deltas exist; here we prove growth from them suppresses the false stall.)"""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: (posts.append((url, body)) or {"ok": True}))
    asst = '{"type":"assistant","message":{"content":[{"type":"text","text":"reasoning over a big tool_result"}]}}'
    deltas = "\n".join('{"type":"stream_event","event":{"type":"content_block_delta"}}' for _ in range(12))
    log = tmp_path / "w.log"
    log.write_text(asst + "\n" + deltas + "\n")
    proc = FakeProc(exited=False)
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 1200,
                        "last_size": len(asst) + 1,            # only the assistant line seen last tick
                        "last_progress_ts": time.time() - 300,  # last mark is WAY past stall_secs
                        "run_id": "R", "log_path": str(log), "worktree": None,
                        "lines_offset": 0, "lines_seq": 1, "lines_buf": b""}}

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert "agent-X" in live and not proc.killed          # log grew via deltas → survives
    assert not [u for u, _ in posts if u.endswith("/wake-ack") or u.endswith("/finish")]
    assert live["agent-X"]["last_progress_ts"] > time.time() - 5   # progress mark reset to now


def test_silent_worker_with_no_deltas_still_stall_killed(monkeypatch, tmp_path):
    """ISS-#251 teeth complement: a genuinely silent worker (no growth, no in-flight tool, no
    rate-limit, no deltas) IS still reaped at stall_secs — the fix must not blunt the watchdog."""
    posts, sigs = [], []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)))
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    # a plain assistant-text tail: no in-flight tool_use, no rate_limit, no result → not 'live'
    log = tmp_path / "w.log"
    log.write_text('{"type":"assistant","message":{"content":[{"type":"text","text":"quiet"}]}}\n')
    proc = FakeProc(exited=False)
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 1200,
                        "last_size": log.stat().st_size,        # NO growth since last tick
                        "last_progress_ts": time.time() - 200,
                        "run_id": "R", "log_path": str(log), "worktree": None}}

    notifier.reap_workers("http://x", live, quiet=True, stall_secs=120)

    assert sigs and sigs[0] == (4321, signal.SIGTERM) and live == {}
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "worker_stalled_killed"


# ---------- GH #58 (review fix): non-reaped deliveries ack the per-event handled-set ----------
#
# A reaped ephemeral worker (tracked in live_workers) defers its ack to reap_workers, which posts
# the handled-set to /events/ack-handled (contiguous floor) on a CLEAN exit. The non-reaped paths
# (`--once` with no reaper, and tmux sends) used to BLANKET high-water delivered_ts to ack_through_ts
# (|| max_event_ts) at spawn — skipping past rows wake_scan deliberately left UN-handled (a cross-task
# task_bound, a NEW_WORK / DIRECTIVE). That is the exact skipped-notification class GH #58 removes, so
# they now post the SAME handled-set to /events/ack-handled and never high-water the cursor at spawn.

def _drain_cand(**over):
    """A candidate carrying a backlog whose handled-set is a STRICT SUBSET of pending (the bug
    shape): 3 pending rows but only ids [11, 12] are run-handleable; the rest must re-surface."""
    c = {"agent_id": "00000000-0000-0000-0000-0000000000d1", "alias": "Drain",
         "should_wake": True, "headless_cwd": "/proj", "tmux_target": None,
         "pending_events": 3, "auto_start_task_ids": [], "reason": "wake",
         "latest_event": "request_answered", "max_event_ts": 9.0, "ack_through_ts": 9.0,
         "handled_event_ids": [11, 12], "headless_flags": None}
    c.update(over)
    return c


def test_tmux_delivery_acks_handled_set_not_high_water(monkeypatch):
    """A tmux send is non-reaped: it must post the per-event handled-set to /events/ack-handled and
    leave delivered_ts None — never blanket high-water past the unhandled rows."""
    cand = _drain_cand(tmux_target="sess:0.0")
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "select_transport", lambda c: "tmux")
    monkeypatch.setattr(notifier, "send_tmux", lambda target, prompt, dry: (True, "tmux cmd"))
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)) or {})

    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True)

    ack_handled = next(b for u, b in posts if u.endswith("/events/ack-handled"))
    assert ack_handled["event_ids"] == [11, 12]            # per-event handled-set, NOT a blanket jump
    wake_ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert wake_ack["delivered_ts"] is None                # cursor NOT high-watered at spawn
    assert wake_ack["kind"] == "tmux"
    # the regression: no wake-ack on this path may carry the old high-water (ack_through_ts / max_ts)
    assert all(b.get("delivered_ts") != 9.0 for u, b in posts if u.endswith("/wake-ack"))


def test_once_ephemeral_acks_handled_set_not_high_water(monkeypatch):
    """`orcha notifier --once` (live_workers is None → no reaper) is non-reaped: same contract as
    tmux — post the handled-set, never high-water delivered_ts."""
    cand = _drain_cand()
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    monkeypatch.setattr(notifier, "decide_wake_tier", lambda c, triage_fn=None: {"tier": "full"})
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    posts = []

    def _post(url, body, **k):
        posts.append((url, body))
        return {"claimed": True, "wake_lease_until": "x"} if "wake-claim" in url else {}
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier, "spawn_headless",
                        lambda *a, **k: (True, "cmd", FakeProc(pid=4321)))

    # live_workers omitted → None → the --once path (no reaper to /finish a run)
    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True)

    ack_handled = next(b for u, b in posts if u.endswith("/events/ack-handled"))
    assert ack_handled["event_ids"] == [11, 12]
    wake_ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert wake_ack["delivered_ts"] is None
    assert all(b.get("delivered_ts") != 9.0 for u, b in posts if u.endswith("/wake-ack"))


def test_daemon_ephemeral_defers_ack_to_reaper_not_at_spawn(monkeypatch):
    """The REAPED daemon path (live_workers tracks the spawned worker) must NOT ack at spawn — the
    reaper posts /events/ack-handled on the worker's clean exit, so a spawn-then-crash re-surfaces the
    backlog. At spawn it only stamps wake-ack with delivered_ts None (lease/cooldown), no high-water."""
    cand = _drain_cand(latest_event="request_answered", pending_events=1)   # single no-code → no worktree
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    monkeypatch.setattr(notifier, "decide_wake_tier", lambda c, triage_fn=None: {"tier": "full"})
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_provision_worktree", lambda *a, **k: (None, None))
    posts = []

    def _post(url, body, **k):
        posts.append((url, body))
        if "wake-claim" in url:
            return {"claimed": True, "wake_lease_until": "x"}
        if url.endswith("/runs"):
            return {"run_id": "RUN-1", "status": "running"}
        return {}
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier, "spawn_headless",
                        lambda *a, **k: (True, "cmd", FakeProc(pid=4321)))
    live = {}

    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True,
                  live_workers=live, base_cwd="/proj")

    # reaped path: the ack is deferred to reap_workers — NOTHING posted to ack-handled at spawn
    assert not any(u.endswith("/events/ack-handled") for u, _ in posts)
    wake_ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert wake_ack["delivered_ts"] is None                # no high-water; reaper advances the floor
    assert cand["agent_id"] in live                        # tracked so the reaper can finish + ack it
