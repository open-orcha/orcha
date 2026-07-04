"""#247 B2 — unified-lease spawn guard (orphan double-embodiment fix).

SPEC-WAKE-BOOT §3/§8 (Kedar-locked): "NO ephemeral spawned on a clock-wake while ANYTHING is
live; the guard is is-anything-live?, not is-resident-due?". The lease alone is NOT authoritative:

  orcha-upgrade kills the owning daemon → its resident child survives 'running' → the lease LAPSES
  with no renewer → wake-scan `lease_active` is lease-only so should_wake flips TRUE, and wake-claim
  only checks wake_lease_until → an ephemeral spawns ALONGSIDE the live orphan = TWO embodiments
  (finding-orcha-update-midflight-orphans-workers). Neither gate consulted worker_runs.status='running'
  — the one signal the live orphan still carries.

The fix makes that signal AUTHORITATIVE in BOTH gates (pure logic, zero migration, zero OpenAPI delta):
  * wake-scan: new `embodiment_running` = EXISTS(running worker_run) folded into should_wake.
  * wake-claim: an atomic `AND NOT EXISTS(running worker_run)` belt in the single-flight conditional.

Teeth: orphan suppresses the scan, orphan blocks the claim, a clean handoff (no running run) still
wakes/claims (no regression to #266), an active lease still blocks (existing single-flight intact),
and a DEAD orphan already reconciled to 'orphaned' no longer suppresses (the reaper self-heals).
"""
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))


async def _scan(client, cid, aid, *, cooldown=0.0, min_idle=0.0):
    r = await client.get(f"/api/containers/{cid}/wake-scan",
                         params={"cooldown": cooldown, "min_idle": min_idle})
    assert r.status_code == 200, r.text
    cand = next((c for c in r.json()["candidates"] if c["agent_id"] == aid), None)
    assert cand is not None
    return cand


def _arm_clock_wake(db, aid):
    """Give the agent real has_work via #266 auto-wake (interval set, never woken ⇒ due now), so
    should_wake is gated SOLELY on the live-embodiment guards under test — not on missing work."""
    db.execute("UPDATE agents SET auto_wake_interval_secs=60 WHERE id=%s", (aid,))


def _lapsed_lease(db, aid, kind="resident"):
    """Seed a lease that has already EXPIRED (the orphan path: no renewer after the daemon died).
    lease_kind survives expiry by design, so the row still reports a stale embodiment label."""
    db.execute(
        "INSERT INTO agent_wake_state (agent_id, wake_lease_until, last_woken_at, lease_kind) "
        "VALUES (%s, now() - interval '120 seconds', now() - interval '300 seconds', %s) "
        "ON CONFLICT (agent_id) DO UPDATE SET wake_lease_until=EXCLUDED.wake_lease_until, "
        "last_woken_at=EXCLUDED.last_woken_at, lease_kind=EXCLUDED.lease_kind",
        (aid, kind),
    )


def _null_lease(db, aid, kind="resident"):
    """Seed a row whose lease was RELEASED (wake_lease_until=NULL) — the OTHER orphan shape: the
    lease was explicitly cleared (main.py release / yield sets wake_lease_until=NULL) but a
    worker_run is still 'running'. Distinct from _lapsed_lease (a non-null PAST lease): only this
    NULL branch of the claim's `(wake_lease_until IS NULL OR wake_lease_until < now())` predicate
    exercises the parenthesization the NOT-EXISTS belt depends on."""
    db.execute(
        "INSERT INTO agent_wake_state (agent_id, wake_lease_until, last_woken_at, lease_kind) "
        "VALUES (%s, NULL, now() - interval '300 seconds', %s) "
        "ON CONFLICT (agent_id) DO UPDATE SET wake_lease_until=NULL, "
        "last_woken_at=EXCLUDED.last_woken_at, lease_kind=EXCLUDED.lease_kind",
        (aid, kind),
    )


def _running_run(db, aid):
    db.execute("INSERT INTO worker_runs (agent_id, status) VALUES (%s, 'running')", (aid,))


# ---------- tooth 1: orphan suppresses the wake-scan ----------

@pytest.mark.asyncio
async def test_lapsed_lease_orphan_suppresses_wake_scan(client, container, make_agent, db):
    """A LAPSED lease + a still-'running' worker_run is a daemon-kill orphan. lease_active is FALSE
    (the lease-only signal that USED to flip should_wake TRUE), but the new embodiment_running guard
    must keep should_wake FALSE so no ephemeral spawns alongside the live orphan."""
    cid = container["id"]
    aid = (await make_agent("Orphan"))["agent_id"]
    _arm_clock_wake(db, aid)

    # Sanity: with NO running run and a lapsed lease, the clock-wake DOES fire (proves has_work).
    _lapsed_lease(db, aid)
    cand = await _scan(client, cid, aid)
    assert cand["lease_active"] is False
    assert cand["embodiment_running"] is False
    assert cand["should_wake"] is True            # nothing live → the orphan guard is what changes it

    # Now strand a live orphan: the lease is still lapsed, but a worker_run is 'running'.
    _running_run(db, aid)
    cand = await _scan(client, cid, aid)
    assert cand["lease_active"] is False           # lease-only gate would (wrongly) wake here
    assert cand["embodiment_running"] is True
    assert cand["should_wake"] is False            # B2: anything-live? suppresses it
    assert "still running" in cand["reason"]


# ---------- tooth 2: orphan blocks the wake-claim ----------

@pytest.mark.asyncio
async def test_lapsed_lease_orphan_blocks_wake_claim(client, container, make_agent, db):
    """The claim is the actual spawn gate. With the lease lapsed it would normally be claimable;
    the atomic NOT-EXISTS belt must refuse it while a worker_run is still 'running'."""
    cid = container["id"]
    aid = (await make_agent("Orphan2"))["agent_id"]
    _lapsed_lease(db, aid)
    _running_run(db, aid)

    r = await client.post(f"/api/agents/{aid}/wake-claim",
                          json={"lease_ttl": 300, "lease_kind": "ephemeral"})
    assert r.status_code == 200, r.text
    assert r.json()["claimed"] is False           # B2 belt: the live orphan blocks the second spawn


# ---------- tooth 2b: a NULL (released) lease + running run also blocks the claim — belt guards BOTH OR branches ----------

@pytest.mark.asyncio
async def test_null_lease_orphan_blocks_wake_claim(client, container, make_agent, db):
    """P1 GAP TOOTH (Gate 2nd-pass). Tooth 2 only drives the LAPSED-lease branch
    (wake_lease_until < now()), which keeps the NOT-EXISTS belt even if the OR is unparenthesized —
    so it can't catch a regression there. This drives the OTHER branch: wake_lease_until IS NULL
    (a released/yielded lease) + a still-'running' worker_run.

    Parenthesized `(IS NULL OR < now()) AND NOT EXISTS(running)`, the belt guards BOTH OR branches
    and refuses the claim. Drop the parens to `IS NULL OR (< now() AND NOT EXISTS(running))` and the
    IS NULL branch short-circuits the WHERE true, bypassing the belt — the orphan double-spawns.
    Mutation-verified RED on exactly that `(A OR B) AND C` → `A OR (B AND C)` reassociation."""
    cid = container["id"]
    aid = (await make_agent("OrphanNull"))["agent_id"]
    _null_lease(db, aid)
    _running_run(db, aid)

    r = await client.post(f"/api/agents/{aid}/wake-claim",
                          json={"lease_ttl": 300, "lease_kind": "ephemeral"})
    assert r.status_code == 200, r.text
    assert r.json()["claimed"] is False           # B2 belt guards the NULL-lease branch too


# ---------- tooth 3: a clean handoff (no running run) still wakes + claims — #266 not regressed ----------

@pytest.mark.asyncio
async def test_clean_handoff_no_running_run_still_wakes_and_claims(client, container, make_agent, db):
    """The normal path is ALREADY safe: _close_resident finishes the run BEFORE releasing the lease,
    so at clock-wake time there is NO 'running' run. The guard must NOT touch that path — a lapsed
    lease with no live run stays wakeable AND claimable (otherwise B2 would wedge every auto-wake)."""
    cid = container["id"]
    aid = (await make_agent("Clean"))["agent_id"]
    _arm_clock_wake(db, aid)
    _lapsed_lease(db, aid)
    # The orphan's run was properly finished — model it as a terminal (non-'running') row.
    db.execute("INSERT INTO worker_runs (agent_id, status, ended_at) VALUES (%s,'exited',now())", (aid,))

    cand = await _scan(client, cid, aid)
    assert cand["embodiment_running"] is False
    assert cand["should_wake"] is True

    r = await client.post(f"/api/agents/{aid}/wake-claim",
                          json={"lease_ttl": 300, "lease_kind": "ephemeral"})
    assert r.json()["claimed"] is True            # no live embodiment → the claim wins


# ---------- tooth 4: an ACTIVE lease still blocks — existing single-flight intact ----------

@pytest.mark.asyncio
async def test_active_lease_still_blocks(client, container, make_agent, db):
    """Regression guard: B2 is ADDITIVE. An unexpired lease must still suppress the scan and refuse
    the claim exactly as R2.4 single-flight always did, independent of worker_runs."""
    cid = container["id"]
    aid = (await make_agent("Live"))["agent_id"]
    _arm_clock_wake(db, aid)

    # GH #91/#90: WORK single-flight is what suppresses a WORK wake, so hold a WORK-lane lease
    # (ephemeral). A 'resident' claim now lands in the CONVERSATION lane and would NOT block a work
    # wake/claim (the lanes are independent) — the lane-correct regression guard uses a work lease.
    r = await client.post(f"/api/agents/{aid}/wake-claim",
                          json={"lease_ttl": 300, "lease_kind": "ephemeral"})
    assert r.json()["claimed"] is True            # first claim wins the lease

    cand = await _scan(client, cid, aid)
    assert cand["lease_active"] is True
    assert cand["should_wake"] is False           # live WORK lease suppresses regardless of B2

    r2 = await client.post(f"/api/agents/{aid}/wake-claim",
                           json={"lease_ttl": 300, "lease_kind": "ephemeral"})
    assert r2.json()["claimed"] is False          # single-flight: second WORK claim refused


# ---------- tooth 5: a DEAD orphan (status='orphaned') no longer suppresses — reaper self-heals ----------

@pytest.mark.asyncio
async def test_reconciled_orphaned_run_does_not_suppress(client, container, make_agent, db):
    """The guard keys STRICTLY on status='running'. Once the dead-PID reaper / wake-ack reconciles a
    stranded run to 'orphaned', it must stop suppressing — otherwise a crashed orphan would wedge the
    agent forever (the very ISS-60 symptom B2 must not reintroduce)."""
    cid = container["id"]
    aid = (await make_agent("Reaped"))["agent_id"]
    _arm_clock_wake(db, aid)
    _lapsed_lease(db, aid)
    db.execute("INSERT INTO worker_runs (agent_id, status, ended_at) VALUES (%s,'orphaned',now())", (aid,))

    cand = await _scan(client, cid, aid)
    assert cand["embodiment_running"] is False     # 'orphaned' != 'running' → no longer live
    assert cand["should_wake"] is True

    r = await client.post(f"/api/agents/{aid}/wake-claim",
                          json={"lease_ttl": 300, "lease_kind": "ephemeral"})
    assert r.json()["claimed"] is True
