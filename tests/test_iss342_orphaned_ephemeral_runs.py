"""#342 — reap orphaned EPHEMERAL worker_runs stuck at status='running' forever.

Repro: a daemon spawns an EPHEMERAL wake-worker (request_answered / checkpoint_respawn /
conversation_turn), records its worker_run (status='running', pid=<host pid>), and reaps it on exit
by poll()ing the in-memory Popen handle in reap_workers(). When the daemon RESTARTS it loses that
handle — nothing finishes the run. The per-agent resident reaper (_reap_dead_pid_resident_runs) is
resident-scoped AND only runs for agents with an active conversation; the heartbeat reap-orphan-leases
only acts on a still-LIVE lease. So an ephemeral orphan whose lease already expired falls through BOTH
and squats 'running' forever, misreporting the agent as busy (blocks re-wake, compounds #340).

Fix (teeth below):
  * server: GET /api/containers/{cid}/running-runs lists every status='running' run across the
    container's live agents (ALL wake_kinds) with its host pid.
  * notifier: reap_orphaned_runs() sweeps that list each tick, host-checks os.kill(pid,0), and
    reconciles dead-pid runs — release the lease (the server orphans all the agent's running rows)
    when nothing is alive, or finish only the dead orphan when a live sibling still renews the lease.
"""
import os
import uuid

from orcha_cli import notifier


_DEAD_PID = 2_000_000        # > macOS max pid (99998) → os.kill always ProcessLookupError


# ======================== server: GET /containers/{cid}/running-runs ========================

async def test_container_running_runs_lists_all_wake_kinds(client, make_agent):
    """919050a5's /resident-runs is resident-scoped; #342's container read spans ALL wake_kinds so a
    stranded EPHEMERAL run is visible to the host reaper. Each row carries agent_id, pid and wake_kind."""
    a = await make_agent("Eph")
    aid = a["agent_id"]
    cid = a["container_id"]
    eph = (await client.post(f"/api/agents/{aid}/runs",
                             json={"wake_kind": "ephemeral", "wake_event": "request_answered",
                                   "pid": 111})).json()["run_id"]
    res = (await client.post(f"/api/agents/{aid}/runs",
                             json={"wake_kind": "resident", "pid": 222})).json()["run_id"]

    runs = (await client.get(f"/api/containers/{cid}/running-runs")).json()["runs"]
    by_id = {r["run_id"]: r for r in runs}
    assert set(by_id) == {eph, res}                          # BOTH kinds, not just resident
    assert by_id[eph]["wake_kind"] == "ephemeral" and by_id[eph]["pid"] == 111
    assert by_id[eph]["agent_id"] == aid
    assert by_id[res]["wake_kind"] == "resident" and by_id[res]["pid"] == 222

    # a finished run drops out of the running set (teeth: status='running' filter actually bites)
    await client.post(f"/api/runs/{eph}/finish", json={"status": "exited", "exit_code": 0})
    runs2 = (await client.get(f"/api/containers/{cid}/running-runs")).json()["runs"]
    assert [r["run_id"] for r in runs2] == [res]


async def test_container_running_runs_unknown_container_404(client):
    r = await client.get(f"/api/containers/{uuid.uuid4()}/running-runs")
    assert r.status_code == 404


async def test_container_running_runs_excludes_terminated_agent(client, make_agent, db):
    """A terminated agent's leftover running row is not the live board's concern (the agent is gone) —
    keep the sweep's working set to LIVE agents so it never resurrects/acts on a retired embodiment."""
    a = await make_agent("Gone")
    aid = a["agent_id"]
    cid = a["container_id"]
    await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral", "pid": 333})
    db.execute("UPDATE agents SET terminated_at=now() WHERE id=%s", (aid,))
    runs = (await client.get(f"/api/containers/{cid}/running-runs")).json()["runs"]
    assert runs == []


async def test_dead_pid_ephemeral_run_reconciled_to_orphaned(client, make_agent, container, db):
    """HEADLINE invariant (#342): a dead-pid EPHEMERAL run must NEVER stay 'running'. The host's sweep
    posts wake-ack release_lease (its no-live branch); the server reconcile then orphans the ephemeral
    row AND frees the lease so the agent is idle + re-wakeable — same backstop the resident path uses,
    now exercised for an ephemeral orphan a restarted daemon stranded."""
    cid = container["id"]
    a = await make_agent("Restarted")
    aid = a["agent_id"]
    # an ephemeral worker claimed a lease + recorded a running run, then its daemon died (pid now dead)
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "kind": "ephemeral"})
    await client.post(f"/api/agents/{aid}/runs",
                      json={"wake_kind": "ephemeral", "wake_event": "request_answered",
                            "pid": _DEAD_PID})

    scan = await client.get(f"/api/containers/{cid}/wake-scan?cooldown=0&min_idle=0")
    me = [c for c in scan.json()["candidates"] if c["agent_id"] == aid][0]
    assert me["lease_active"] is True                        # stale lease blocks wakes (ISS-74)

    # the new daemon's sweep detects the dead pid (no live sibling) → release the lease
    await client.post(f"/api/agents/{aid}/wake-ack",
                      json={"kind": "orphan_run_sweep", "release_lease": True})

    scan2 = await client.get(f"/api/containers/{cid}/wake-scan?cooldown=0&min_idle=0")
    me2 = [c for c in scan2.json()["candidates"] if c["agent_id"] == aid][0]
    assert me2["lease_active"] is False                      # wake no longer suppressed
    assert (await client.get(f"/api/containers/{cid}/running-runs")).json()["runs"] == []  # nothing 'running'
    allruns = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"]
    assert allruns and allruns[0]["status"] == "orphaned"


# ======================== notifier: the container-wide sweep helper ========================

def _patch_io(monkeypatch, runs):
    """Mock the sweep's two HTTP seams: GET container/running-runs returns `runs`; record POSTs."""
    posts = []
    monkeypatch.setattr(notifier, "_get_json", lambda u, **k: {"runs": list(runs)})
    monkeypatch.setattr(notifier, "_post_json", lambda u, b=None, **k: posts.append((u, b)) or {})
    return posts


def test_sweep_releases_lease_when_no_live(monkeypatch):
    """TEETH (#342): an EPHEMERAL running run with a dead pid and NO live sibling → release the lease
    (the server orphans the row); it does NOT per-run /finish, so the release path is the single
    source of truth — mirrors the resident reaper's contract."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "R", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "ephemeral"}])

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 1
    assert any("/agents/A1/wake-ack" in u and (b or {}).get("release_lease") for u, b in posts)
    assert not any("/finish" in u for u, _ in posts)


def test_sweep_keeps_lease_with_live_sibling(monkeypatch):
    """TEETH (#342): a true double-spawn (one dead ephemeral row, one LIVE sibling) → finish ONLY the
    dead orphan, KEEP the lease the live worker still renews. Never rip a live embodiment's lease."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "DEAD", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "ephemeral"},
        {"run_id": "LIVE", "agent_id": "A1", "pid": os.getpid(), "wake_kind": "ephemeral"}])

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 1
    assert any("/runs/DEAD/finish" in u for u, _ in posts)                      # dead row finished
    assert not any("wake-ack" in u and (b or {}).get("release_lease") for u, b in posts)  # lease kept


def test_sweep_shields_live_pids(monkeypatch):
    """TEETH (#342): a pid THIS daemon knows is live (live_pids — its own just-spawned worker/resident)
    is never swept, even if os.kill would momentarily call it dead. _run_pid_alive is forced False so
    live_pids is the ONLY thing that saves it — confirms the shield is wired."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "R", "agent_id": "A1", "pid": 777, "wake_kind": "ephemeral"}])
    monkeypatch.setattr(notifier, "_run_pid_alive", lambda _pid: False)         # os.kill says dead

    n = notifier.reap_orphaned_runs("http://x", "C1", live_pids=frozenset({777}))
    assert n == 0 and posts == []


def test_sweep_handles_each_agent_independently(monkeypatch):
    """TEETH (#342, the container-wide value-add): one sweep, TWO agents — agent A is wholly dead
    (release its lease) while agent B has a live sibling (finish only its dead orphan). The per-agent
    resident reaper never sees agent A at all unless A has an active conversation; the container sweep
    reconciles both in a single pass, keyed only on dead host pids."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "A-DEAD", "agent_id": "A", "pid": _DEAD_PID, "wake_kind": "ephemeral"},
        {"run_id": "B-DEAD", "agent_id": "B", "pid": _DEAD_PID, "wake_kind": "ephemeral"},
        {"run_id": "B-LIVE", "agent_id": "B", "pid": os.getpid(), "wake_kind": "checkpoint_respawn"}])

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 2                                                               # A-DEAD + B-DEAD
    assert any("/agents/A/wake-ack" in u and (b or {}).get("release_lease") for u, b in posts)  # A: lease released
    assert any("/runs/B-DEAD/finish" in u for u, _ in posts)                    # B: dead orphan finished
    assert not any("/agents/B/wake-ack" in u and (b or {}).get("release_lease")
                   for u, b in posts)                                           # B: lease KEPT (live sibling)


def test_sweep_empty_is_noop(monkeypatch):
    posts = _patch_io(monkeypatch, [])
    assert notifier.reap_orphaned_runs("http://x", "C1") == 0
    assert posts == []


# ======================== integration: the daemon TICK actually calls the sweep ========================

def test_daemon_tick_invokes_reaper_before_tick(monkeypatch, tmp_path):
    """TEETH (Gate 2nd-pass blocker): every helper test above still passes if the daemon-loop call at
    notifier.py:reap_orphaned_runs(...) is replaced with `pass` — i.e. the fix could ship as DEAD CODE
    and the live orphan sweep would never run. This drives ONE iteration of cmd_notifier's daemon loop
    (every other seam mocked) and asserts the reaper IS invoked, with the right (api_base, cid) and the
    live-pid shield, AND that it runs BEFORE tick() — so a stranded 'running' run is reconciled before
    the wake scan that would otherwise see the agent as busy and suppress a legit wake."""
    import types

    order = []
    seen = {}

    def _fake_reap(api_base, cid, live_pids=frozenset(), quiet=True):
        order.append("reap")
        seen["args"] = (api_base, cid, live_pids)
        return 0

    def _fake_tick(*a, **k):
        order.append("tick")
        raise KeyboardInterrupt          # BaseException — not caught by the loop's `except Exception`

    # the daemon's per-tick neighbours + one-time setup → no-ops (we only care that the reaper fires)
    monkeypatch.setattr(notifier, "_api_and_cid", lambda *a, **k: ("http://x", "C1"))
    monkeypatch.setattr(notifier, "_probe_container", lambda *a, **k: "ok")
    monkeypatch.setattr(notifier, "_pid_path", lambda cwd: tmp_path / "daemon.pid")
    monkeypatch.setattr(notifier, "_global_pid_path", lambda cid: tmp_path / f"{cid}.pid")
    monkeypatch.setattr(notifier, "_write_global_pid", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "reconcile_codex_conversation_runs", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "reap_workers", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "reap_orphan_leases", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "service_residents", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "reap_orphaned_runs", _fake_reap)
    monkeypatch.setattr(notifier, "tick", _fake_tick)
    # #103: the daemon now beats a heartbeat to the portal at startup + each loop pass. Stub it
    # like every other per-tick seam above — otherwise it makes a real urlopen to the fake api_base,
    # and on macOS the getaddrinfo thread that spins up poisons a later subprocess fork (segfault).
    monkeypatch.setattr(notifier, "_report_heartbeat", lambda *a, **k: None)
    monkeypatch.setattr(notifier.signal, "signal", lambda *a, **k: None)

    args = types.SimpleNamespace(
        stop=False, restart=False, ensure=False, once=False, quiet=True,
        api_base=None, container=None, dry_run=False, cooldown=0, min_idle=0, interval=999,
    )

    try:
        notifier.cmd_notifier(args)
    except KeyboardInterrupt:
        pass                              # tick() raised to break the loop after exactly one pass

    assert order == ["reap", "tick"]      # reaper ran, and BEFORE the wake scan — not dead code
    assert seen["args"][:2] == ("http://x", "C1")
    assert seen["args"][2] == frozenset()  # live-pid shield wired (no live workers/residents this tick)
