"""ISS-stranded (task e4b77f3f) — reconcile stranded resident worker_runs rows.

Repro: a resident POSTs a worker_run (status='running') BEFORE the turn is confirmed on its
stdin. If the send fails (broken pipe = dead resident) the row stays 'running' forever — the
daemon's death-branch only finishes a run whose run_id reached current_run_id, which a failed
send never sets. Net: the DB believes a resident is alive, the wake-lease is held, and ALL
event wakes for that agent are suppressed (the Page stall).

Two-part fix, both covered here with mutation-checked teeth:
  * Part 1 (notifier send-first): for resident conversation turns, send the turn FIRST and only
    POST the run once the send succeeds — a failed send creates NO row, so no orphan.
    ISS-78 later removed the warm-session inbox-drain run entirely: queued inbox work now makes
    an idle resident yield/release so an ephemeral worker drains it in a separate session.
  * Part 2 (server reconcile): a lease release (wake-ack release_lease=True, and the ISS-60-B
    orphan-lease reaper) reconciles any still-'running' worker_runs for that agent to 'orphaned'
    — a durable backstop for orphans the reorder can't cover (daemon turnover / crash mid-POST).
"""
import io

import pytest

from orcha_cli import notifier


# ======================== Part 1 — notifier send-first reorder ========================

class _BrokenProc:
    """A resident whose stdin pipe is gone — _send_user_turn returns False (dead resident)."""
    def __init__(self):
        self.pid = 4321
        self.returncode = None          # proc.poll() is None: alive but pipe-broken (the orphan vector)

        class _Stdin:
            def __init__(self):
                self.closed = False
            def write(self, _b):
                raise BrokenPipeError()
            def flush(self):
                pass
            def close(self):
                self.closed = True
        self.stdin = _Stdin()

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.returncode = 0
        return 0

    def kill(self):
        self.returncode = -9


def _wire(monkeypatch, *, active, turns=None):
    """Route notifier's HTTP helpers for a service_residents tick. Returns the posts log."""
    import re
    posts = []

    def _get(url, **k):
        if "active-conversations" in url:
            return {"conversations": active}
        if "/turns" in url:
            m = re.search(r"after_seq=(\d+)", url)
            after = int(m.group(1)) if m else 0
            return {"turns": [t for t in (turns or []) if t.get("seq", 0) > after]}
        if "/conversation" in url:
            return {"conversation": {"id": "C1"}, "turns": turns or []}
        return None

    def _post(url, body, **k):
        posts.append((url, body))
        if "wake-claim" in url:
            return {"claimed": True, "reason": None, "lease_kind": "resident"}
        if url.endswith("/runs"):
            return {"run_id": "RUN-1", "status": "running"}
        if "wake-renew" in url:
            return {"renewed": True, "lease_kind": "resident", "preempt_requested": False}
        return {}

    monkeypatch.setattr(notifier, "_get_json", _get)
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: "PERSONA")
    monkeypatch.setattr(notifier, "_pump_one", lambda *a, **k: None)
    return posts


def test_conversation_turn_send_first_no_orphan_run(monkeypatch, tmp_path):
    """TEETH (Part 1, conversation-turn): a broken pipe must NOT open a worker_run. The old
    POST-then-send order created a 'running' row then hit `continue` without setting
    current_run_id — stranding it forever. Send-first: no successful send → no row."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": None, "pending_human": True, "last_turn_seq": 1}
    posts = _wire(monkeypatch, active=[conv],
                  turns=[{"seq": 1, "role": "human", "content": "hello"}])
    proc = _BrokenProc()
    monkeypatch.setattr(notifier, "spawn_resident", lambda *a, **k: (True, "repr", proc))
    live = {}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    # The mutation-check: revert the reorder and a /runs POST appears here → orphan 'running' row.
    assert not any(u.endswith("/runs") for u, _ in posts), \
        "a failed send must NOT POST a worker_run (else it strands a 'running' orphan)"
    r = live.get("C1")
    assert r is not None and r.get("current_run_id") is None and not r.get("awaiting_result")


def test_conversation_turn_send_ok_still_opens_run(monkeypatch, tmp_path):
    """Regression (Part 1): the reorder must not break the happy path — a successful send still
    opens the run and records current_run_id so _pump_one/finish work on later ticks."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": None, "pending_human": True, "last_turn_seq": 1}
    posts = _wire(monkeypatch, active=[conv],
                  turns=[{"seq": 1, "role": "human", "content": "hello"}])

    class _LiveProc(_BrokenProc):
        def __init__(self):
            super().__init__()
            self.stdin = io.BytesIO()      # a real, writable pipe → send succeeds
    proc = _LiveProc()
    monkeypatch.setattr(notifier, "spawn_resident", lambda *a, **k: (True, "repr", proc))
    live = {}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert any(u.endswith("/runs") for u, _ in posts)             # run opened AFTER the send
    assert live["C1"]["current_run_id"] == "RUN-1" and live["C1"]["awaiting_result"] is True
    proc.stdin.seek(0)
    assert b"hello" in proc.stdin.read()                          # the turn really went to stdin


def test_inbox_drain_yield_opens_no_in_session_run(monkeypatch, tmp_path):
    """TEETH (Part 1 / ISS-78 → GH #91/#90 default): a warm resident with queued NON-conversation
    inbox work opens NO in-session resident run — the original ISS-stranded orphan (a POST /runs on the
    warm session) never happens. Under the lane split (RESIDENT_WORK_TEARDOWN_ENABLED=False, the default)
    the resident also does NOT yield/tear down its CONVERSATION lease for that work: the WORK lane drains
    the backlog independently via its own work lease + work worker_run, so the two lanes coexist. The
    resident just stays warm and renews. Mutation tooth: reintroduce a warm-session inbox-drain run and a
    /runs POST appears here → RED (the stranded-orphan vector this file guards is back)."""
    import time
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2,
            "pending_inbox": 3, "inbox_ack_ts": 100, "inbox_messages": []}
    posts = _wire(monkeypatch, active=[conv])
    sigs = []
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    monkeypatch.setattr(notifier, "_RESIDENT_DRAIN_YIELD", {})
    proc = _BrokenProc()
    live = {"C1": {"proc": proc, "agent_id": "A1", "conversation_id": "C1", "alias": "Vox",
                   "log_path": tmp_path / "c.ndjson", "session_id": "sess-9",
                   "session_pinned": True, "cold": False, "serviced_seq": 2,
                   "current_run_id": None, "run_id": None, "awaiting_result": False,
                   "turn_scan_offset": 0, "lines_offset": 0, "lines_buf": b"", "lines_seq": 1,
                   "last_activity_ts": time.time()}}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    assert not any(u.endswith("/runs") for u, _ in posts), \
        "an inbox-drain must NOT POST a resident worker_run (else it strands a 'running' orphan)"
    # GH #91/#90 default (flag OFF): no work-yield/teardown — the CONVERSATION resident stays warm.
    assert "C1" in live                                         # warm resident kept (not torn down)
    assert not sigs                                             # not graceful-killed/yielded
    assert not any(u.endswith("/wake-ack") for u, _ in posts)   # lease NOT released (no work teardown)
    assert "C1" not in notifier._RESIDENT_DRAIN_YIELD           # never entered the yield/drain branch


# ======================== Part 2 — server reconcile on lease release ========================

async def test_wake_ack_release_reconciles_running_run(client, make_agent, db):
    """TEETH (Part 2, wake-ack): releasing the lease reconciles a still-'running' orphan run to
    'orphaned' + stamps ended_at, enforcing 'lease released => no running runs for this agent'."""
    a = await make_agent("Strand")
    aid = a["agent_id"]
    rid = (await client.post(f"/api/agents/{aid}/runs",
                             json={"wake_kind": "resident"})).json()["run_id"]

    r = await client.post(f"/api/agents/{aid}/wake-ack",
                          json={"kind": "resident_exited", "release_lease": True})
    assert r.status_code == 200, r.text

    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["run_id"] == rid
    assert run["status"] == "orphaned" and run["ended_at"] is not None
    # audit row for portal visibility
    evs = db.execute(
        "SELECT detail FROM events WHERE entity_id=%s AND event_type='worker_runs_reconciled'",
        (aid,))
    assert len(evs) == 1 and rid in evs[0]["detail"]["reconciled"]


async def test_wake_ack_no_release_leaves_running(client, make_agent):
    """TEETH (Part 2, negative): a wake-ack that does NOT release the lease (a warm inbox-drain
    keeps the embodiment) must leave the running run untouched — only a release reconciles."""
    a = await make_agent("Keep")
    aid = a["agent_id"]
    rid = (await client.post(f"/api/agents/{aid}/runs",
                             json={"wake_kind": "resident"})).json()["run_id"]

    await client.post(f"/api/agents/{aid}/wake-ack",
                      json={"kind": "resident_inbox_drain", "release_lease": False})

    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["run_id"] == rid and run["status"] == "running"


async def test_wake_ack_release_does_not_touch_finished_run(client, make_agent):
    """TEETH (Part 2): the reconcile is scoped to status='running' — an already-finished run
    (the happy path finishes it BEFORE the ack) is never rewritten to 'orphaned'."""
    a = await make_agent("Done")
    aid = a["agent_id"]
    rid = (await client.post(f"/api/agents/{aid}/runs",
                             json={"wake_kind": "resident"})).json()["run_id"]
    await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0})

    await client.post(f"/api/agents/{aid}/wake-ack",
                      json={"kind": "resident_exited", "release_lease": True})

    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["status"] == "exited"          # left as-is, not clobbered to 'orphaned'


async def test_orphan_lease_reaper_reconciles_running_run(client, make_agent, container, db):
    """TEETH (Part 2, reaper fold-in): a lease that OUTLIVED its embodiment (daemon turnover) is
    force-released by the ISS-60-B reaper, which now ALSO reconciles the agent's stranded
    'running' runs to 'orphaned' — covering orphans the in-process release path never sees.

    GH #91/#90: the reaper is lane-scoped. A resident is a CONVERSATION-lane embodiment — its claim
    lands on the conv_* lease slot and its run is lane='conversation'. The conversation reaper branch
    keys idle STRICTLY on conv_last_heartbeat_at (no pre-030 legacy fallback), so we stale that column
    (NOT agents.last_heartbeat_at, which the WORK branch reads) and tag the run lane='conversation' so
    the conversation branch reconciles it."""
    cid = container["id"]
    a = await make_agent("Ghost")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})   # -> CONVERSATION lease slot
    rid = (await client.post(f"/api/agents/{aid}/runs",
                             json={"wake_kind": "resident", "lane": "conversation"})).json()["run_id"]
    # conversation branch keys on conv_last_heartbeat_at; stale IT (a once-alive-now-gone conv lease).
    db.execute("UPDATE agent_wake_state SET conv_last_heartbeat_at = now() - interval '2000 seconds' "
               "WHERE agent_id=%s", (aid,))

    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert [x["agent_id"] for x in r.json()["reaped"]] == [aid]

    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["run_id"] == rid and run["status"] == "orphaned" and run["ended_at"] is not None
    # the reaper's audit event carries the reconciled run id
    ev = db.execute(
        "SELECT detail FROM events WHERE entity_id=%s AND event_type='orphan_lease_reaped'",
        (aid,))[0]
    assert rid in ev["detail"]["reconciled_runs"]


async def test_reaper_leaves_fresh_lease_runs_running(client, make_agent, container, db):
    """TEETH (Part 2, reaper negative): an agent with a FRESH heartbeat is not reaped, so its
    running run is left alone — the run-reconcile is keyed to the leases actually released."""
    cid = container["id"]
    a = await make_agent("Busy")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})
    rid = (await client.post(f"/api/agents/{aid}/runs",
                             json={"wake_kind": "resident"})).json()["run_id"]
    db.execute("UPDATE agents SET last_heartbeat_at = now() WHERE id=%s", (aid,))

    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert r.json()["reaped"] == []

    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["run_id"] == rid and run["status"] == "running"


# ============== 919050a5 — pid persistence + dead-pid single-flight / liveness ==============

import os                                                                  # noqa: E402

_DEAD_PID = 2_000_000        # > macOS max pid (99998) → os.kill always ProcessLookupError


# ---------- server: pid persistence + GET /resident-runs ----------

async def test_pid_persisted_and_surfaced(client, make_agent):
    """919050a5 (a): the spawn pid is stored on the run and surfaced by GET /resident-runs so the
    host can liveness-check it. (The new field/route is reflected in Swagger /openapi.json.)"""
    a = await make_agent("Pidly")
    aid = a["agent_id"]
    r = await client.post(f"/api/agents/{aid}/runs",
                          json={"wake_kind": "resident", "wake_event": "conversation_turn",
                                "pid": 54321})
    rid = r.json()["run_id"]

    runs = (await client.get(f"/api/agents/{aid}/resident-runs?status=running")).json()["runs"]
    assert len(runs) == 1
    assert runs[0]["run_id"] == rid and runs[0]["pid"] == 54321 and runs[0]["status"] == "running"


async def test_resident_runs_excludes_ephemeral_and_filters_status(client, make_agent):
    """TEETH (919050a5): /resident-runs is scoped to wake_kind='resident' and honours ?status —
    an ephemeral run never appears, and a finished resident run drops out of ?status=running."""
    a = await make_agent("Mix")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral", "pid": 111})
    rid = (await client.post(f"/api/agents/{aid}/runs",
                             json={"wake_kind": "resident", "pid": 222})).json()["run_id"]

    running = (await client.get(f"/api/agents/{aid}/resident-runs?status=running")).json()["runs"]
    assert [r["run_id"] for r in running] == [rid]          # ephemeral excluded

    await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0})
    assert (await client.get(f"/api/agents/{aid}/resident-runs?status=running")).json()["runs"] == []
    allres = (await client.get(f"/api/agents/{aid}/resident-runs")).json()["runs"]
    assert [r["run_id"] for r in allres] == [rid] and allres[0]["status"] == "exited"


async def test_resident_runs_unknown_agent_404(client):
    import uuid
    r = await client.get(f"/api/agents/{uuid.uuid4()}/resident-runs")
    assert r.status_code == 404


async def test_dead_pid_release_unsuppresses_event_wake(client, make_agent, container, db):
    """TEETH (919050a5 c, server seam): the plan's headline invariant — a dead-pid resident lease
    must NOT keep pinning its embodiment. Seed a resident lease + a running resident run; the host's
    dead-pid reap (wake-ack release_lease) clears the lease AND the e4b77f3f reconcile orphans the
    stranded run.

    GH #91/#90: a resident is a CONVERSATION-lane embodiment — its claim lands on the conv_* lease slot
    and its run is lane='conversation'. So the seeded state shows up as conv_lease_active /
    conv_embodiment_running (NOT the work-lane lease_active — the two lanes are independent now, and a
    live conversation resident deliberately does NOT suppress work wakes). The dead-pid release is
    therefore a lane='conversation' ack, which clears the conv lease and reconciles the conv run."""
    cid = container["id"]
    a = await make_agent("Stall")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})   # -> CONVERSATION lease slot
    await client.post(f"/api/agents/{aid}/runs",
                      json={"wake_kind": "resident", "lane": "conversation", "pid": _DEAD_PID})

    scan = await client.get(f"/api/containers/{cid}/wake-scan?cooldown=0&min_idle=0")
    me = [c for c in scan.json()["candidates"] if c["agent_id"] == aid][0]
    assert me["conv_lease_active"] is True                  # the resident holds the CONVERSATION lease
    assert me["conv_embodiment_running"] is True            # its running conv run is live
    assert me["lease_active"] is False                      # lane split: work lane is untouched/free

    # the host detects the dead pid and reaps it = release the CONVERSATION-lane resident lease
    await client.post(f"/api/agents/{aid}/wake-ack",
                      json={"kind": "resident_dead_pid", "release_lease": True,
                            "lane": "conversation"})

    scan2 = await client.get(f"/api/containers/{cid}/wake-scan?cooldown=0&min_idle=0")
    me2 = [c for c in scan2.json()["candidates"] if c["agent_id"] == aid][0]
    assert me2["conv_lease_active"] is False                # conv lease released
    assert me2["conv_embodiment_running"] is False          # run reconciled → no live conv embodiment
    run = (await client.get(f"/api/agents/{aid}/resident-runs")).json()["runs"][0]
    assert run["status"] == "orphaned"


# ---------- notifier: the dead-pid liveness helper ----------

def test_pid_alive_true_false_none():
    assert notifier._run_pid_alive(os.getpid()) is True        # this very process
    assert notifier._run_pid_alive(_DEAD_PID) is False
    assert notifier._run_pid_alive(None) is False and notifier._run_pid_alive(0) is False


def test_reap_dead_pid_releases_lease_when_no_live(monkeypatch):
    """TEETH (919050a5 b/c): a running resident run with a dead pid and NO live sibling → the helper
    releases the resident lease (the server reconciles the run to 'orphaned'); it does NOT per-run
    /finish (the release path owns the status), so there's a single source of truth."""
    posts = []
    monkeypatch.setattr(notifier, "_get_json",
                        lambda u, **k: {"runs": [{"run_id": "R", "pid": _DEAD_PID, "status": "running"}]})
    monkeypatch.setattr(notifier, "_post_json", lambda u, b=None, **k: posts.append((u, b)) or {})

    n = notifier._reap_dead_pid_resident_runs("http://x", "A1")
    assert n == 1
    assert any("wake-ack" in u and b.get("release_lease") for u, b in posts)
    assert not any("/finish" in u for u, _ in posts)


def test_reap_dead_pid_keeps_lease_with_live_sibling(monkeypatch):
    """TEETH (919050a5 b): a true double-spawn (one dead row, one LIVE sibling) → finish ONLY the
    dead orphan, KEEP the lease the live resident still renews. Never rip out a live embodiment."""
    posts = []
    monkeypatch.setattr(notifier, "_get_json", lambda u, **k: {"runs": [
        {"run_id": "DEAD", "pid": _DEAD_PID, "status": "running"},
        {"run_id": "LIVE", "pid": os.getpid(), "status": "running"}]})
    monkeypatch.setattr(notifier, "_post_json", lambda u, b=None, **k: posts.append((u, b)) or {})
    monkeypatch.setattr(notifier, "_capture_run_output", lambda p: "")

    n = notifier._reap_dead_pid_resident_runs("http://x", "A1")
    assert n == 1
    assert any("/runs/DEAD/finish" in u for u, _ in posts)                  # dead row finished
    assert not any("wake-ack" in u and (b or {}).get("release_lease") for u, b in posts)  # lease kept


def test_reap_dead_pid_shields_live_pids(monkeypatch):
    """TEETH (919050a5): a pid THIS daemon knows is live (live_pids) is never reaped, even if
    os.kill would call it dead (e.g. racing just-spawned resident). _run_pid_alive is patched to
    always return False so live_pids is the ONLY thing that saves it — confirms the shield is wired."""
    posts = []
    monkeypatch.setattr(notifier, "_get_json",
                        lambda u, **k: {"runs": [{"run_id": "R", "pid": 777, "status": "running"}]})
    monkeypatch.setattr(notifier, "_post_json", lambda u, b=None, **k: posts.append((u, b)) or {})
    monkeypatch.setattr(notifier, "_run_pid_alive", lambda _pid: False)  # os.kill says dead

    n = notifier._reap_dead_pid_resident_runs("http://x", "A1", live_pids=frozenset({777}))
    assert n == 0 and posts == []


# ---------- notifier: reap-prior wired into the resident boot (no two running rows) ----------

def _wire_with_resident_runs(monkeypatch, *, active, turns=None, resident_runs=None):
    import re
    posts = []

    def _get(url, **k):
        if "active-conversations" in url:
            return {"conversations": active}
        if "resident-runs" in url:
            return {"runs": list(resident_runs or [])}
        if "/turns" in url:
            m = re.search(r"after_seq=(\d+)", url)
            after = int(m.group(1)) if m else 0
            return {"turns": [t for t in (turns or []) if t.get("seq", 0) > after]}
        if "/conversation" in url:
            return {"conversation": {"id": "C1"}, "turns": turns or []}
        return None

    def _post(url, body, **k):
        posts.append((url, body))
        if "wake-claim" in url:
            return {"claimed": True, "reason": None, "lease_kind": "resident"}
        if url.endswith("/runs"):
            return {"run_id": "RUN-NEW", "status": "running"}
        if "wake-renew" in url:
            return {"renewed": True, "lease_kind": "resident", "preempt_requested": False}
        return {}

    monkeypatch.setattr(notifier, "_get_json", _get)
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: "PERSONA")
    monkeypatch.setattr(notifier, "_pump_one", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_capture_run_output", lambda p: "")
    return posts


def test_reap_prior_dead_pid_before_resident_boot(monkeypatch, tmp_path):
    """TEETH (919050a5 b): the headline 'two running resident rows for one agent cannot coexist'.
    A prior resident run with a DEAD pid is reaped (lease released) BEFORE the new wake-claim, so the
    boot never stacks a second resident on the orphan."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": None, "pending_human": True, "last_turn_seq": 1}
    posts = _wire_with_resident_runs(
        monkeypatch, active=[conv], turns=[{"seq": 1, "role": "human", "content": "hi"}],
        resident_runs=[{"run_id": "OLD", "pid": _DEAD_PID, "status": "running"}])

    class _LiveProc(_BrokenProc):
        def __init__(self):
            super().__init__()
            self.stdin = io.BytesIO()
    monkeypatch.setattr(notifier, "spawn_resident", lambda *a, **k: (True, "repr", _LiveProc()))
    live = {}

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path))

    urls = [u for u, _ in posts]
    rel_idx = next((i for i, (u, b) in enumerate(posts)
                    if "wake-ack" in u and b.get("release_lease")), None)
    claim_idx = next((i for i, u in enumerate(urls) if "wake-claim" in u), None)
    assert rel_idx is not None, "a dead-pid prior resident run must be reaped (wake-ack release)"
    assert claim_idx is not None and rel_idx < claim_idx, \
        "the reap must release the stale lease BEFORE the new resident is claimed"
