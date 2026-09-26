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
    # GH #91/#90 (PR R3): each row surfaces its lane so the host sweep can ack the dead run's OWN
    # lane (the wake-ack release/reconcile are lane-scoped server-side). Default insert lane='work'.
    assert by_id[eph]["lane"] == "work" and by_id[res]["lane"] == "work"

    # a finished run drops out of the running set (teeth: status='running' filter actually bites)
    await client.post(f"/api/runs/{eph}/finish", json={"status": "exited", "exit_code": 0})
    runs2 = (await client.get(f"/api/containers/{cid}/running-runs")).json()["runs"]
    assert [r["run_id"] for r in runs2] == [res]


async def test_container_running_runs_carries_sandbox_fields(client, make_agent):
    """Task 5: the sweep reconciles a SANDBOX row by container liveness — the read must
    surface sandbox_container_id (which container) plus worktree/base_cwd (whose
    SandboxConfig sets the max-runtime deadline; where the per-run api-config lives)."""
    a = await make_agent("Sbx")
    aid = a["agent_id"]
    cid = a["container_id"]
    await client.post(f"/api/agents/{aid}/runs",
                      json={"wake_kind": "sandbox", "pid": 111,
                            "sandbox_container_id": "orcha-run-abc123def456",
                            "base_cwd": "/repo", "worktree": "/repo/.worktrees/t1",
                            "log_path": "/repo/.claude/.orcha-wakes/w1.log"})
    await client.post(f"/api/agents/{aid}/runs",
                      json={"wake_kind": "ephemeral", "pid": 222})

    runs = (await client.get(f"/api/containers/{cid}/running-runs")).json()["runs"]
    by_kind = {r["wake_kind"]: r for r in runs}
    sbx = by_kind["sandbox"]
    assert sbx["sandbox_container_id"] == "orcha-run-abc123def456"
    assert sbx["base_cwd"] == "/repo" and sbx["worktree"] == "/repo/.worktrees/t1"
    # pre-dogfood fix 1: log_path rides the row so the sweep's finish can CAPTURE an
    # adopted run's output (finishing output=NULL fails §5 criterion 3)
    assert sbx["log_path"] == "/repo/.claude/.orcha-wakes/w1.log"
    assert by_kind["ephemeral"]["sandbox_container_id"] is None   # host rows stay pid-swept


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


async def test_dead_pid_conversation_run_releases_conv_lane(client, make_agent, container):
    """REGRESSION (GH #91/#90 PR R3): a dead-pid CONVERSATION-lane run outside the active-conversation
    reconcile path must not wedge the conversation lane forever. The old sweep acked lane-less
    (server default 'work'): the work lease released but the conv row stayed 'running' and the conv
    lease stayed held — every future conversation claim refused. The fixed sweep acks the dead run's
    OWN lane; teeth below prove the lane-less ack does NOT unwedge it and the lane-scoped ack does."""
    cid = container["id"]
    a = await make_agent("ConvOrphan")
    aid = a["agent_id"]
    # a resident conversation claimed the CONVERSATION lane + recorded its running run, then its
    # daemon died (pid now dead) — exactly the stranded state the container sweep must reconcile
    claim = await client.post(f"/api/agents/{aid}/wake-claim",
                              json={"lease_ttl": 300, "kind": "resident", "lease_kind": "resident"})
    assert claim.json()["claimed"] is True
    await client.post(f"/api/agents/{aid}/runs",
                      json={"wake_kind": "resident", "wake_event": "conversation_turn",
                            "pid": _DEAD_PID, "lane": "conversation"})

    # the container read surfaces the lane — what the sweep keys its ack on
    runs = (await client.get(f"/api/containers/{cid}/running-runs")).json()["runs"]
    assert [r["lane"] for r in runs] == ["conversation"]

    # the OLD sweep's lane-less ack (server resolves 'work') must NOT unwedge the conversation lane
    await client.post(f"/api/agents/{aid}/wake-ack",
                      json={"kind": "orphan_run_sweep", "release_lease": True})
    still = await client.post(f"/api/agents/{aid}/wake-claim",
                              json={"lease_ttl": 300, "kind": "resident", "lease_kind": "resident"})
    assert still.json()["claimed"] is False                  # conv lease + 'running' row both survive
    runs = (await client.get(f"/api/containers/{cid}/running-runs")).json()["runs"]
    assert [r["lane"] for r in runs] == ["conversation"]

    # the FIXED sweep acks the dead run's own lane → row orphaned + conv lease freed
    await client.post(f"/api/agents/{aid}/wake-ack",
                      json={"kind": "orphan_run_sweep", "release_lease": True,
                            "lane": "conversation"})
    assert (await client.get(f"/api/containers/{cid}/running-runs")).json()["runs"] == []
    allruns = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"]
    assert allruns and allruns[0]["status"] == "orphaned"
    reclaim = await client.post(f"/api/agents/{aid}/wake-claim",
                                json={"lease_ttl": 300, "kind": "resident", "lease_kind": "resident"})
    assert reclaim.json()["claimed"] is True                 # conversation lane re-claimable


# ======================== notifier: the container-wide sweep helper ========================

def _patch_io(monkeypatch, runs):
    """Mock the sweep's two HTTP seams: GET container/running-runs returns `runs`; record POSTs.
    Task 5: also stub the sandbox orphan pass's docker read to 'no managed containers' so these
    pid-path tests never shell out to a real docker (hermetic; _fake_sandbox overrides it)."""
    posts = []
    monkeypatch.setattr(notifier, "_get_json", lambda u, **k: {"runs": list(runs)})
    monkeypatch.setattr(notifier, "_post_json", lambda u, b=None, **k: posts.append((u, b)) or {})
    monkeypatch.setattr(notifier._sandbox, "managed_containers", lambda cid: [])
    monkeypatch.setattr(notifier._sandbox, "daemon_reachable", lambda: True)
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


def test_sweep_acks_conversation_lane(monkeypatch):
    """TEETH (GH #91/#90 PR R3): a dead CONVERSATION-lane run with no live sibling → the release
    ack must carry lane='conversation' so the server frees the CONV lease + orphans the conv row.
    A lane-less ack resolves to 'work' server-side and leaves the conversation lane wedged."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "R", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "resident",
         "lane": "conversation"}])

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 1
    assert any("/agents/A1/wake-ack" in u and (b or {}).get("release_lease")
               and (b or {}).get("lane") == "conversation" for u, b in posts)


def test_sweep_lanes_release_independently(monkeypatch):
    """TEETH (GH #91/#90 PR R3): same agent, one dead CONVERSATION run + one LIVE WORK worker. The
    sweep groups per (agent, lane): the live WORK sibling renews only the WORK lease and must NOT
    shield the dead conversation lane — its lease is released (not per-run finished). The old
    per-agent grouping saw 'a live sibling' and kept the conv lane wedged."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "C-DEAD", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "resident",
         "lane": "conversation"},
        {"run_id": "W-LIVE", "agent_id": "A1", "pid": os.getpid(), "wake_kind": "ephemeral",
         "lane": "work"}])

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 1
    assert any("wake-ack" in u and (b or {}).get("release_lease")
               and (b or {}).get("lane") == "conversation" for u, b in posts)
    assert not any("/finish" in u for u, _ in posts)         # lane released, not sibling-finished
    assert not any("wake-ack" in u and (b or {}).get("lane") == "work"
                   for u, b in posts)                        # live WORK lane untouched


def test_sweep_missing_lane_defaults_to_work(monkeypatch):
    """Backward compat: a running-runs row with NO lane field (pre-030 server mid-upgrade) is
    treated as the historical WORK lane — the same slot the lane-less ack always acted on."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "R", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "ephemeral"}])

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 1
    assert any("wake-ack" in u and (b or {}).get("lane") == "work" for u, b in posts)


def test_sweep_empty_is_noop(monkeypatch):
    posts = _patch_io(monkeypatch, [])
    assert notifier.reap_orphaned_runs("http://x", "C1") == 0
    assert posts == []


# ======================== Task 5: the sweep's SANDBOX branch (container liveness) ========================
# A row with sandbox_container_id is reconciled by docker inspect, never host pid — the
# docker-run client pid dies with a daemon restart while the detached container keeps
# working (adoption, spec §3.3c). Fakes ride notifier._sandbox (module-object attribute
# lookup at call time), mirroring the pid-path harness above.

import datetime as _dt


def _state(*, running, exit_code=None, oom=False, started_at=None):
    return notifier._sandbox.SandboxState(
        running=running, exit_code=exit_code, oom_killed=oom,
        started_at=started_at or _dt.datetime.now(_dt.timezone.utc).isoformat())


def _ago(seconds):
    """ISO timestamp `seconds` in the past — for aging containers/rows against
    the M7 ORPHAN_BOOT_GRACE_SECS boot grace."""
    return (_dt.datetime.now(_dt.timezone.utc)
            - _dt.timedelta(seconds=seconds)).isoformat()


def _fake_sandbox(monkeypatch, *, states=None, managed=(), daemon_ok=True):
    """Recording fakes for the sweep's docker seams. `states` maps container name →
    SandboxState (missing name → probe None, i.e. vanished). `daemon_ok=False`
    simulates a docker-daemon outage (the C2 gate). `managed_cids` records the cid
    each orphan-pass listing was scoped to (C1)."""
    calls = {"probe": [], "stop": [], "remove": [], "remove_api_config": [],
             "managed_cids": []}
    monkeypatch.setattr(notifier._sandbox, "daemon_reachable", lambda: daemon_ok)
    monkeypatch.setattr(notifier._sandbox, "probe",
                        lambda n: calls["probe"].append(n) or (states or {}).get(n))
    monkeypatch.setattr(notifier._sandbox, "stop", lambda n: calls["stop"].append(n))
    monkeypatch.setattr(notifier._sandbox, "remove",
                        lambda n, force=False: calls["remove"].append(n))
    monkeypatch.setattr(notifier._sandbox, "remove_api_config",
                        lambda cwd, n: calls["remove_api_config"].append((str(cwd), n)))
    monkeypatch.setattr(notifier._sandbox, "managed_containers",
                        lambda cid: calls["managed_cids"].append(cid) or list(managed))
    return calls


def test_sandbox_live_container_is_adopted_not_finished(monkeypatch):
    """ADOPTION (spec §3.3c): the run's docker-run client pid is DEAD (daemon restarted)
    but the container is alive within deadline → the run is NOT finished, NOT stopped,
    and its lease is NOT ripped — the container-backed run simply continues."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "S", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "sandbox",
         "sandbox_container_id": "orcha-run-live"}])
    calls = _fake_sandbox(monkeypatch, states={"orcha-run-live": _state(running=True)})

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 0
    assert posts == []                                   # no finish, no wake-ack
    assert calls["stop"] == [] and calls["remove"] == []
    assert calls["probe"] == ["orcha-run-live"]          # container, not pid, was the truth


def test_sandbox_vanished_container_finishes_run(monkeypatch):
    posts = _patch_io(monkeypatch, [
        {"run_id": "S", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "sandbox",
         "sandbox_container_id": "orcha-run-gone"}])
    _fake_sandbox(monkeypatch, states={})                # probe → None

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 1
    fin = [(u, b) for u, b in posts if "/runs/S/finish" in u]
    assert fin and fin[0][1]["status"] == "killed"
    assert "sandbox container vanished" in (fin[0][1].get("kill_reason") or "")


def test_sandbox_exited_container_finishes_then_removes(monkeypatch, tmp_path):
    """Clean exit: stamp the row (exited/0) FIRST, then rm the container and reap its
    per-run api-config — and never touch volumes (remove fake stands in for docker rm)."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "S", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "sandbox",
         "sandbox_container_id": "orcha-run-done", "worktree": str(tmp_path)}])
    calls = _fake_sandbox(monkeypatch,
                          states={"orcha-run-done": _state(running=False, exit_code=0)})
    # ordering teeth: at rm time the finish must already be posted (rm AFTER stamping)
    posted_at_rm = []
    monkeypatch.setattr(notifier._sandbox, "remove",
                        lambda n: (calls["remove"].append(n), posted_at_rm.append(len(posts))))

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 1
    fin = [(u, b) for u, b in posts if "/runs/S/finish" in u]
    assert fin and fin[0][1]["status"] == "exited" and fin[0][1]["exit_code"] == 0
    assert calls["remove"] == ["orcha-run-done"]
    assert posted_at_rm == [1]                           # stamped BEFORE rm
    assert calls["remove_api_config"] == [(str(tmp_path), "orcha-run-done")]


def test_adopted_exited_run_finish_captures_its_log_output(monkeypatch, tmp_path):
    """Pre-dogfood fix 1 (§5 criterion 3): an ADOPTED run (daemon restarted, Popen
    handle gone) that exits is finished BY THE SWEEP — its stream-json log sits on
    the workspace at the row's log_path all along, so the finish must capture it
    into worker_runs.output, exactly like the normal reap path. Before the fix the
    sweep passed log_path=None and every adopted run finished output=NULL."""
    log = tmp_path / "wake.log"
    log.write_text('{"type":"system","subtype":"init"}\n'
                   '{"type":"assistant","message":"ADOPTEDRUNOUTPUT"}\n')
    posts = _patch_io(monkeypatch, [
        {"run_id": "S", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "sandbox",
         "sandbox_container_id": "orcha-run-done", "worktree": str(tmp_path),
         "log_path": str(log)}])
    _fake_sandbox(monkeypatch,
                  states={"orcha-run-done": _state(running=False, exit_code=0)})

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 1
    fin = [(u, b) for u, b in posts if "/runs/S/finish" in u]
    assert fin and fin[0][1]["status"] == "exited"
    assert "ADOPTEDRUNOUTPUT" in (fin[0][1].get("output") or "")   # captured, not NULL


def test_sandbox_oom_exit_finishes_killed_with_memory_reason(monkeypatch, tmp_path):
    posts = _patch_io(monkeypatch, [
        {"run_id": "S", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "sandbox",
         "sandbox_container_id": "orcha-run-oom", "base_cwd": str(tmp_path)}])
    calls = _fake_sandbox(monkeypatch, states={
        "orcha-run-oom": _state(running=False, exit_code=137, oom=True)})

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 1
    fin = [(u, b) for u, b in posts if "/runs/S/finish" in u]
    assert fin and fin[0][1]["status"] == "killed" and fin[0][1]["exit_code"] == 137
    assert "out of memory — raise sandbox.memory" in (fin[0][1].get("kill_reason") or "")
    assert calls["remove"] == ["orcha-run-oom"]          # reaped after stamping, like any exit


def test_sandbox_past_deadline_gets_stop_but_no_finish_this_sweep(monkeypatch):
    """Runaway (spec §3.5): stop the container NOW; the row is stamped from the observed
    exit state NEXT sweep (never a guessed exit code). No worktree/base_cwd on the row →
    the DEFAULT_MAX_RUNTIME_SECS deadline applies; started_at is ancient → past it."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "S", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "sandbox",
         "sandbox_container_id": "orcha-run-runaway"}])
    calls = _fake_sandbox(monkeypatch, states={
        "orcha-run-runaway": _state(running=True, started_at="2020-01-01T00:00:00+00:00")})

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 0
    assert calls["stop"] == ["orcha-run-runaway"]
    assert not any("/finish" in u for u, _ in posts)     # stamped next sweep, from real exit
    assert calls["remove"] == []                         # container still needed for the stamp


def test_sandbox_deadline_reads_workspace_config(monkeypatch, tmp_path):
    """The deadline is the RUN's workspace config (worktree-resolved), not a global:
    a 60s max_runtime_secs makes a minutes-old container a runaway."""
    import json as _json
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text(_json.dumps(
        {"sandbox": {"enabled": True, "max_runtime_secs": 60}}))
    started = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(seconds=600)).isoformat()
    _patch_io(monkeypatch, [
        {"run_id": "S", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "sandbox",
         "sandbox_container_id": "orcha-run-slow", "worktree": str(tmp_path)}])
    calls = _fake_sandbox(monkeypatch, states={
        "orcha-run-slow": _state(running=True, started_at=started)})

    notifier.reap_orphaned_runs("http://x", "C1")
    assert calls["stop"] == ["orcha-run-slow"]           # 600s old > the workspace's 60s cap


def test_resident_sandbox_row_never_deadline_stopped(monkeypatch):
    """Resident lane (un-deferral): a warm resident session is long-lived BY DESIGN —
    a RUNNING resident-kind container is ALWAYS the adoption case, even when it is
    ancient (way past the one-shot max-runtime deadline). No stop, no finish."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "R", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "resident",
         "lane": "conversation", "sandbox_container_id": "orcha-run-warm"}])
    calls = _fake_sandbox(monkeypatch, states={
        "orcha-run-warm": _state(running=True, started_at="2020-01-01T00:00:00+00:00")})

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 0
    assert calls["stop"] == [] and calls["remove"] == []     # NOT a runaway
    assert posts == []                                       # no finish, no wake-ack
    assert calls["probe"] == ["orcha-run-warm"]


def test_resident_sandbox_vanished_and_exited_still_reconciled(monkeypatch, tmp_path):
    """The deadline skip is surgical: a resident row whose container VANISHED is
    finished killed, and an EXITED one is stamped from its real exit code then
    removed — exactly like any other sandbox row."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "GONE", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "resident",
         "lane": "conversation", "sandbox_container_id": "orcha-run-gone"},
        {"run_id": "DONE", "agent_id": "A2", "pid": _DEAD_PID, "wake_kind": "resident",
         "lane": "conversation", "sandbox_container_id": "orcha-run-done",
         "base_cwd": str(tmp_path)}])
    calls = _fake_sandbox(monkeypatch, states={
        "orcha-run-done": _state(running=False, exit_code=0)})

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 2
    gone = [(u, b) for u, b in posts if "/runs/GONE/finish" in u]
    assert gone and gone[0][1]["status"] == "killed"
    assert "sandbox container vanished" in (gone[0][1].get("kill_reason") or "")
    done = [(u, b) for u, b in posts if "/runs/DONE/finish" in u]
    assert done and done[0][1]["status"] == "exited" and done[0][1]["exit_code"] == 0
    assert calls["remove"] == ["orcha-run-done"]
    assert calls["remove_api_config"] == [(str(tmp_path), "orcha-run-done")]


def test_live_resident_container_shielded_from_orphan_pass(monkeypatch):
    """Resident lane: between turns a warm sandboxed resident owns NO open run row
    (rows are per-turn), so the orphan pass would read its live container as an
    orphan and stop it mid-conversation. The daemon passes its in-memory residents'
    container names as `live_sandbox` — those are never stopped; a genuinely
    unreferenced container still is."""
    _patch_io(monkeypatch, [])
    calls = _fake_sandbox(monkeypatch,
                          states={"orcha-run-orphan":
                                  _state(running=True, started_at=_ago(600))},
                          managed=["orcha-run-warm", "orcha-run-orphan"])

    n = notifier.reap_orphaned_runs("http://x", "C1",
                                    live_sandbox=frozenset({"orcha-run-warm"}))
    assert n == 0
    assert calls["stop"] == ["orcha-run-orphan"]     # shielded resident untouched
    assert "orcha-run-warm" not in calls["probe"]    # shield short-circuits BEFORE the
                                                     # per-candidate grace inspect


def test_orphan_container_with_no_open_run_row_is_stopped(monkeypatch):
    """Orphan pass (spec §3.5): a live managed container that NO open run row references
    is stopped — while a container an open row DOES reference is left alone. Runs even
    when the running-runs list is empty (the daemon-restart orphan case)."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "S", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "sandbox",
         "sandbox_container_id": "orcha-run-owned"}])
    calls = _fake_sandbox(monkeypatch,
                          states={"orcha-run-owned": _state(running=True),
                                  "orcha-run-orphan":
                                  _state(running=True, started_at=_ago(600))},
                          managed=["orcha-run-owned", "orcha-run-orphan"])

    notifier.reap_orphaned_runs("http://x", "C1")
    assert calls["stop"] == ["orcha-run-orphan"]         # orphan stopped, owned one untouched
    assert not any("/finish" in u for u, _ in posts)


def test_orphan_pass_runs_even_with_zero_open_runs(monkeypatch):
    _patch_io(monkeypatch, [])
    calls = _fake_sandbox(monkeypatch,
                          states={"orcha-run-zombie":
                                  _state(running=True, started_at=_ago(600))},
                          managed=["orcha-run-zombie"])
    assert notifier.reap_orphaned_runs("http://x", "C1") == 0
    assert calls["stop"] == ["orcha-run-zombie"]


def test_orphan_pass_grace_shields_young_rowless_container(monkeypatch):
    """M7 boot grace (field bug: first chat message dies as 'vanished'): a row-less
    managed container whose StartedAt is only ~30s ago is a BOOTING wake whose
    run-row POST hasn't landed yet — the orphan pass must NOT stop it this sweep.
    An old row-less sibling in the same sweep is still stopped as before."""
    _patch_io(monkeypatch, [])
    calls = _fake_sandbox(monkeypatch,
                          states={"orcha-run-booting":
                                  _state(running=True, started_at=_ago(30)),
                                  "orcha-run-stale":
                                  _state(running=True, started_at=_ago(600))},
                          managed=["orcha-run-booting", "orcha-run-stale"])

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 0
    assert calls["stop"] == ["orcha-run-stale"]          # young one deferred, old one stopped
    assert set(calls["probe"]) == {"orcha-run-booting", "orcha-run-stale"}  # one inspect each


def test_orphan_pass_probe_failure_is_fail_safe_no_stop(monkeypatch):
    """M7 fail-safe: the grace check needs the container's StartedAt; if probe
    fails (docker hiccup, or the container is mid-`docker create` and not
    inspectable yet) its age is UNKNOWN — never stop what we cannot age. The
    candidate is simply retried next sweep."""
    _patch_io(monkeypatch, [])
    calls = _fake_sandbox(monkeypatch, states={},        # probe → None
                          managed=["orcha-run-mystery"])

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 0
    assert calls["probe"] == ["orcha-run-mystery"]       # it TRIED to age it
    assert calls["stop"] == []                           # ...and refused to stop blind


def test_orphan_pass_unparseable_started_at_is_fail_safe(monkeypatch):
    """A probe that answers with a garbled StartedAt also reads as UNKNOWN age —
    same fail-safe skip as a probe failure."""
    _patch_io(monkeypatch, [])
    calls = _fake_sandbox(monkeypatch,
                          states={"orcha-run-garbled":
                                  _state(running=True, started_at="not-a-time")},
                          managed=["orcha-run-garbled"])

    assert notifier.reap_orphaned_runs("http://x", "C1") == 0
    assert calls["stop"] == []


def test_vanished_verdict_deferred_for_young_row(monkeypatch):
    """M7, the observed field failure (dogfood 2026-07-30: 15s between the run
    row's POST landing and the container's network join): a run row whose
    container is not probeable is only VANISHED once the row outlives the boot
    grace. A young row (started_at now-30s) + probe None → defer: no finish, no
    kill — the next sweep re-evaluates."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "S", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "sandbox",
         "sandbox_container_id": "orcha-run-midboot", "started_at": _ago(30)}])
    calls = _fake_sandbox(monkeypatch, states={})        # probe → None (not born yet)

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 0
    assert not any("/finish" in u for u, _ in posts)     # verdict deferred, row stays open
    assert calls["stop"] == [] and calls["remove"] == []


def test_vanished_verdict_deferred_for_young_resident_first_turn(monkeypatch):
    """The resident boot-window case behind the user-visible bug: the FIRST
    conversation turn's row lands while `docker run` is still creating the warm
    session's container — probe None on that young row must NOT stamp the turn
    'sandbox container vanished' (the retry-a-minute-later symptom)."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "T1", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "resident",
         "lane": "conversation", "sandbox_container_id": "orcha-run-coldboot",
         "started_at": _ago(30)}])
    _fake_sandbox(monkeypatch, states={})

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 0
    assert not any("/finish" in u for u, _ in posts)
    # the lane lease is shielded too (unknown ≠ dead): no release ack
    assert not any("wake-ack" in u and (b or {}).get("release_lease")
                   for u, b in posts)


def test_vanished_verdict_still_stamped_after_grace(monkeypatch):
    """Grace is a deferral, not an exemption (#342's 'busy forever' stays
    bounded): the same probe-less row PAST the grace is finished killed with the
    vanished reason exactly as before."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "S", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "sandbox",
         "sandbox_container_id": "orcha-run-gone", "started_at": _ago(600)}])
    _fake_sandbox(monkeypatch, states={})

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 1
    fin = [(u, b) for u, b in posts if "/runs/S/finish" in u]
    assert fin and fin[0][1]["status"] == "killed"
    assert "sandbox container vanished" in (fin[0][1].get("kill_reason") or "")


def test_live_sandbox_shield_unions_workers_and_residents():
    """The daemon's orphan-pass shield must cover BOTH in-memory maps: a one-shot
    sandbox worker's container is spawned BEFORE its run-row POST (a transient
    POST failure leaves it row-less while alive), and a warm resident owns a row
    only per-turn. Before the fix only residents were shielded — a row-less
    one-shot was stopped by the next sweep (~2s later)."""
    live_workers = {
        "A1": {"proc": object(), "sandbox_container_id": "orcha-run-oneshot"},
        "A2": {"proc": object(), "sandbox_container_id": None},   # host-mode worker
    }
    live_residents = {
        "conv1": {"proc": object(), "sandbox_container_id": "orcha-run-warm"},
        "conv2": {"proc": object()},                              # host-mode resident
    }
    assert notifier.live_sandbox_shield(live_workers, live_residents) == frozenset(
        {"orcha-run-oneshot", "orcha-run-warm"})
    assert notifier.live_sandbox_shield({}, {}) == frozenset()


def test_orphan_pass_skipped_when_api_unreachable(monkeypatch):
    """A dead API returns an EMPTY world view — that must never read as 'every
    container is an orphan' (it would stop all in-flight sandbox work)."""
    monkeypatch.setattr(notifier, "_get_json", lambda u, **k: None)
    monkeypatch.setattr(notifier, "_post_json", lambda u, b=None, **k: {})
    calls = _fake_sandbox(monkeypatch, managed=["orcha-run-live1"])
    assert notifier.reap_orphaned_runs("http://x", "C1") == 0
    assert calls["stop"] == [] and calls["probe"] == []


def test_sandbox_probe_error_does_not_abort_sweep_for_others(monkeypatch):
    """Per-run isolation: one row's docker interaction blowing up must not stop the
    sweep from reconciling the other rows (probe/stop/remove never raise in prod;
    this is the belt-and-braces guard)."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "BAD", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "sandbox",
         "sandbox_container_id": "orcha-run-bad"},
        {"run_id": "GONE", "agent_id": "A2", "pid": _DEAD_PID, "wake_kind": "sandbox",
         "sandbox_container_id": "orcha-run-gone"}])
    _fake_sandbox(monkeypatch, states={})
    real_probe = notifier._sandbox.probe
    def _explosive(n):
        if n == "orcha-run-bad":
            raise RuntimeError("docker went sideways")
        return real_probe(n)
    monkeypatch.setattr(notifier._sandbox, "probe", _explosive)

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 1                                        # GONE still reconciled
    assert any("/runs/GONE/finish" in u for u, _ in posts)


def test_orphan_pass_is_scoped_to_this_daemons_cid(monkeypatch):
    """C1: the orphan listing must be filtered to THIS daemon's project (orcha.cid
    label) — a host running two orcha stacks must never let one daemon's sweep see,
    let alone stop, the other project's containers."""
    _patch_io(monkeypatch, [])
    calls = _fake_sandbox(monkeypatch, managed=[])
    notifier.reap_orphaned_runs("http://x", "C1")
    assert calls["managed_cids"] == ["C1"]                   # scoped listing, once per sweep


def test_daemon_outage_freezes_sandbox_reconciliation(monkeypatch):
    """C2: docker daemon unreachable → probe results would be meaningless (None is
    UNKNOWN, not vanished). The sweep must reconcile NOTHING: no probes, no
    finishes, no stops, no orphan pass — and every sandbox row's lane is shielded
    so the pid path cannot rip a lease whose embodiment is merely unobservable."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "SBX", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "sandbox",
         "sandbox_container_id": "orcha-run-x", "lane": "work"},
        # dead HOST row in the SAME lane: without the outage shield its lane lease
        # would be released, server-orphaning the (unobservable) sandbox row too
        {"run_id": "HOST", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "ephemeral",
         "lane": "work"}])
    calls = _fake_sandbox(monkeypatch, daemon_ok=False,
                          states={"orcha-run-x": _state(running=True)},
                          managed=["orcha-run-orphan"])

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert calls["probe"] == []                              # nothing probed
    assert calls["stop"] == [] and calls["remove"] == []     # nothing stopped/removed
    assert calls["managed_cids"] == []                       # orphan pass skipped
    assert not any("/runs/SBX/finish" in u for u, _ in posts)
    assert not any("wake-ack" in u and (b or {}).get("release_lease")
                   for u, b in posts)                        # lane SHIELDED (unknown ≠ dead)
    assert any("/runs/HOST/finish" in u for u, _ in posts)   # host orphan still finished
    assert n == 1


def test_daemon_healthy_path_unchanged(monkeypatch):
    """C2 control: with a reachable daemon the vanished row is reconciled exactly
    as before the gate landed."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "S", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "sandbox",
         "sandbox_container_id": "orcha-run-gone"}])
    calls = _fake_sandbox(monkeypatch, daemon_ok=True, states={})
    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 1 and calls["probe"] == ["orcha-run-gone"]
    assert any("/runs/S/finish" in u for u, _ in posts)


def test_finish_post_failure_preserves_container_for_retry(monkeypatch, tmp_path):
    """I5: the exited container is the only evidence of the run's outcome. If the
    finish POST fails, docker rm must NOT run — the row stays 'running' and the
    next sweep re-observes the exited state and retries the stamp for free."""
    monkeypatch.setattr(notifier, "_get_json", lambda u, **k: {"runs": [
        {"run_id": "S", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "sandbox",
         "sandbox_container_id": "orcha-run-done", "worktree": str(tmp_path)}]})
    monkeypatch.setattr(notifier, "_post_json", lambda u, b=None, **k: None)   # POST fails
    calls = _fake_sandbox(monkeypatch,
                          states={"orcha-run-done": _state(running=False, exit_code=0)})

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 0                                            # not reaped — retried next sweep
    assert calls["remove"] == [] and calls["remove_api_config"] == []


def test_live_sandbox_run_shields_its_lane_from_lease_release(monkeypatch):
    """Same agent+lane, one live-container SANDBOX row + one dead-pid HOST row: the
    lane-scoped lease release would make the server orphan EVERY running row in the
    lane — ripping the ADOPTED sandbox run with it (its container then stopped as an
    orphan next sweep). The live sandbox embodiment must count as a live sibling:
    finish ONLY the dead host orphan, keep the lease, leave the sandbox run alone."""
    posts = _patch_io(monkeypatch, [
        {"run_id": "SBX", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "sandbox",
         "sandbox_container_id": "orcha-run-live", "lane": "work"},
        {"run_id": "HOST", "agent_id": "A1", "pid": _DEAD_PID, "wake_kind": "ephemeral",
         "lane": "work"}])
    _fake_sandbox(monkeypatch, states={"orcha-run-live": _state(running=True)})

    n = notifier.reap_orphaned_runs("http://x", "C1")
    assert n == 1                                        # the HOST orphan only
    assert any("/runs/HOST/finish" in u for u, _ in posts)
    assert not any("wake-ack" in u and (b or {}).get("release_lease")
                   for u, b in posts)                    # lease KEPT — adopted run owns the lane
    assert not any("/runs/SBX/finish" in u for u, _ in posts)


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

    def _fake_reap(api_base, cid, live_pids=frozenset(), live_sandbox=frozenset(),
                   quiet=True):
        order.append("reap")
        seen["args"] = (api_base, cid, live_pids)
        seen["live_sandbox"] = live_sandbox
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
    assert seen["live_sandbox"] == frozenset()  # resident-container shield wired too
