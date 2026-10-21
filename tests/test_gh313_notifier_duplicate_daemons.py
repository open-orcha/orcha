"""GH #313 — duplicate notifier daemons made the portal say "Not running".

Field report (2026-10-21): four notifier daemons for ONE container were alive at
once — the pid-file owner, a sibling with its own launcher, and two orphans from
earlier sleep/wake restarts. All wrote the same `.claude/.orcha-notifier.hb`;
whenever an orphan stamped last, the owner's heartbeat "belonged to another pid",
the owner was judged dead and killed, and `--ensure` spawned yet another daemon.
`--ensure`/`--restart` only knew the pid-file daemon, so orphans were invisible
and had to be killed by hand.

Fix under test:
  D1  discovery — `_container_daemons(cid)` finds EVERY daemon loop for the
      container by process scan, including ones no pid file names; never
      another container's, never one-shot verbs or prompt text quoting the command.
  D2  reaping — `--ensure` keeps the healthy owner and stops the rest (one
      survivor); `--stop`/`--restart` stop them all; launcher + child of the
      survivor are one daemon, not a stray.
  D3  health — each daemon stamps its own per-pid heartbeat and only the owner
      writes the shared file, so a duplicate's stamp can no longer make the
      owner look dead.
  D4  no accumulation — a running daemon the pid file no longer names retires
      itself once the owner proves life (sleep/wake + supervisor respawn).
  D5  diagnosis — lifecycle lines carry a UTC timestamp even under --quiet.

Each test carries a mutation note: revert the named production line → RED.
"""
import signal
import time

from orcha_cli import notifier  # noqa: E402 (conftest puts orcha-cli on sys.path)

CID = "c0ffee00-0313-4000-8000-000000000313"  # fake: never a real container
OTHER = "70f1e5e3-0000-4000-8000-000000000000"
PY = "/Users/k/.local/share/uv/tools/orcha-cli/bin/python3"

# The field picture: owner 12342 (pid file) under launcher 97606, sibling pair
# 12332 under its own launcher 12330, orphans 93267 + 51385 re-parented to init,
# plus another container's daemon and assorted look-alikes that must be ignored.
PS_ROWS = [
    (97606, 1, "Ss", f"/opt/homebrew/bin/orcha notifier --quiet --container {CID}"),
    (12342, 97606, "S", f"{PY} -m orcha_cli notifier --quiet --container {CID}"),
    (12330, 1, "Ss", f"/opt/homebrew/bin/orcha notifier --quiet --container {CID}"),
    (12332, 12330, "S", f"{PY} -m orcha_cli notifier --quiet --container {CID}"),
    (93267, 1, "Ss", f"{PY} /Users/k/.local/bin/orcha notifier --quiet --container {CID}"),
    (51385, 1, "Ss", f"{PY} /Users/k/.local/bin/orcha notifier --quiet --container={CID}"),
    (10897, 1, "Ss", f"{PY} -m orcha_cli notifier --quiet --container {OTHER}"),
    (40001, 1, "Z", f"{PY} -m orcha_cli notifier --quiet --container {CID}"),
    (40002, 1, "S", f"{PY} /Users/k/.local/bin/orcha notifier --ensure --quiet --container {CID}"),
    (40003, 1, "S", f"claude -p orcha notifier --quiet --container {CID} please"),
    (40004, 1, "S", f"{PY} -m orcha_cli notifier --once --container {CID}"),
    (40005, 1, "S", "/usr/sbin/notifyd"),
]
STRAYS = {12330, 12332, 93267, 51385}


def _ws(tmp_path):
    (tmp_path / ".claude").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".claude" / "orcha.json").write_text(
        '{"current_container_id": "%s", "api_base_url": "http://127.0.0.1:1"}' % CID
    )
    return tmp_path


def _scan(monkeypatch, rows=PS_ROWS):
    monkeypatch.setattr(notifier, "_ps_table", lambda: list(rows))


def _record_kills(monkeypatch, dies_on_term=True):
    """Fake os.kill over the PS_ROWS world; returns the (pid, sig) log."""
    alive = {pid for pid, _pp, state, _c in PS_ROWS if state[0] != "Z"}
    sent = []

    def _kill(pid, sig):
        if sig == 0:
            if pid not in alive:
                raise ProcessLookupError
            return
        sent.append((pid, sig))
        if sig == signal.SIGKILL or dies_on_term:
            alive.discard(pid)

    def _ps_inspect(pid):
        for row in PS_ROWS:
            if row[0] == pid and pid in alive:
                return row[2], row[3]
        return None

    monkeypatch.setattr(notifier.os, "kill", _kill)
    monkeypatch.setattr(notifier, "_ps_inspect", _ps_inspect)
    monkeypatch.setattr(notifier.time, "sleep", lambda s: None)
    return sent, alive


# ---------- D1: discovery ----------

def test_scan_finds_every_daemon_of_this_container_including_orphans(monkeypatch):
    """Mutation: drop the `--container=<cid>` form, the zombie skip, the one-shot
    flag skip or the launcher-position check in is_container_daemon_command → RED."""
    _scan(monkeypatch)
    found = notifier._container_daemons(CID)
    assert set(found) == {97606, 12342} | STRAYS
    assert found[12342] == 97606 and found[12332] == 12330


def test_scan_never_matches_another_container():
    """Mutation: match `cid in command` instead of the exact `--container <cid>`
    pair → a prefix/other container's daemon matches → RED."""
    cmd = f"{PY} -m orcha_cli notifier --quiet --container {OTHER}"
    assert not notifier._is_container_daemon_command(cmd, CID)
    assert not notifier._is_container_daemon_command(cmd, OTHER[:8])
    assert not notifier._is_container_daemon_command(cmd, "")


def test_scan_ignores_prompt_text_quoting_the_command():
    """Mutation: drop the interpreter/flag check before the `orcha` token → a
    worker whose prompt quotes `orcha notifier --container <cid>` matches → RED."""
    assert not notifier._is_container_daemon_command(
        f"claude -p orcha notifier --quiet --container {CID}", CID)
    assert not notifier._is_container_daemon_command(
        f"/bin/zsh -c echo orcha notifier --container {CID}", CID)


def test_scan_unusable_ps_reaps_nothing(monkeypatch):
    """ps unusable → None → no reaping at all (never kill blind)."""
    monkeypatch.setattr(notifier, "_ps_table", lambda: None)
    killed = []
    monkeypatch.setattr(notifier, "_terminate_all_and_wait", lambda pids, cid, grace=8.0: killed.extend(pids))
    assert notifier._reap_strays(CID, 12342) == []
    assert killed == []


# ---------- D2: reaping ----------

def test_ensure_keeps_owner_and_reaps_all_orphans(monkeypatch, tmp_path):
    """THE incident: --ensure with a healthy owner used to return "already running"
    and leave three orphans. Mutation: delete the `_reap_strays(cid, keep, cwd)`
    call in ensure_daemon → no stray is signalled → RED."""
    ws = _ws(tmp_path)
    _scan(monkeypatch)
    sent, alive = _record_kills(monkeypatch)
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: 12342)
    spawned = []
    monkeypatch.setattr(notifier.subprocess, "Popen", lambda *a, **k: spawned.append(a))
    assert notifier.ensure_daemon(ws, quiet=True) is True
    assert {pid for pid, sig in sent if sig == signal.SIGTERM} == STRAYS
    assert alive & ({97606, 12342} | STRAYS) == {97606, 12342}, "exactly one daemon (owner + its launcher) survives"
    assert 10897 in alive, "another container's daemon is never touched"
    assert not spawned, "a healthy owner is kept, not replaced"


def test_ensure_without_healthy_owner_reaps_all_then_spawns_one(monkeypatch, tmp_path):
    """No healthy owner: every old daemon goes, ONE new one starts. Mutation: pass
    a keep pid when none is healthy → an orphan survives beside the new daemon → RED."""
    ws = _ws(tmp_path)
    _scan(monkeypatch)
    sent, alive = _record_kills(monkeypatch)
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: None)
    monkeypatch.setattr(notifier, "daemon_running_for_container", lambda cid: None)
    monkeypatch.setattr(notifier, "_probe_container", lambda api, cid: "ok")
    monkeypatch.setattr(notifier, "_claim_container", lambda cid: (True, None))
    monkeypatch.setattr(notifier, "_write_global_pid", lambda cid, pid, cwd: None)

    class _Proc:
        pid = 55555

    starts = []
    monkeypatch.setattr(notifier.subprocess, "Popen", lambda *a, **k: starts.append(a) or _Proc())
    assert notifier.ensure_daemon(ws, quiet=True) is True
    assert {97606, 12342} | STRAYS <= {pid for pid, _ in sent}
    assert not (alive & ({97606, 12342} | STRAYS))
    assert 10897 in alive
    assert len(starts) == 1
    assert notifier._pid_path(ws).read_text() == "55555"


def test_restart_stops_orphans_the_pid_file_never_named(monkeypatch, tmp_path):
    """The field `--restart` stopped only 12342 and left three orphans for kill -9.
    Mutation: delete the `_reap_strays` call in stop_daemon's live-pid branch → RED."""
    ws = _ws(tmp_path)
    notifier._pid_path(ws).write_text("12342")
    _scan(monkeypatch)
    sent, alive = _record_kills(monkeypatch)
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: 12342 if 12342 in alive else None)
    monkeypatch.setattr(notifier, "daemon_running_for_container", lambda cid: None)
    assert notifier.stop_daemon(ws, quiet=True) is True
    assert not (alive & ({12342} | STRAYS)), "--stop/--restart leaves no daemon of this container"
    assert 10897 in alive


def test_stop_reaps_strays_even_without_a_pid_file(monkeypatch, tmp_path):
    """Pid file already gone (owner died) but orphans run on. Mutation: delete the
    `_reap_strays(cid, None, cwd)` in stop_daemon's no-pid branch → RED."""
    ws = _ws(tmp_path)
    _scan(monkeypatch)
    sent, alive = _record_kills(monkeypatch)
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: None)
    monkeypatch.setattr(notifier, "daemon_running_for_container", lambda cid: None)
    assert notifier.stop_daemon(ws, quiet=True) is True
    assert not (alive & ({97606, 12342} | STRAYS))


def test_reap_escalates_to_sigkill_after_shared_grace(monkeypatch):
    """A stray that ignores SIGTERM is SIGKILLed after ONE shared grace period
    (SIGTERM-then-SIGKILL is kept). Mutation: drop the trailing
    `_terminate_and_wait(pid, cid, 0.0)` in terminate_all_and_wait → RED."""
    _scan(monkeypatch)
    sent, alive = _record_kills(monkeypatch, dies_on_term=False)
    clock = {"t": 0.0}

    def _time():
        clock["t"] += 1.0
        return clock["t"]

    monkeypatch.setattr(notifier.time, "time", _time)
    notifier._reap_strays(CID, 12342)
    assert {pid for pid, sig in sent if sig == signal.SIGKILL} == STRAYS
    assert not (alive & STRAYS)


def test_reap_never_signals_a_pid_that_fails_the_vet(monkeypatch):
    """Belt and braces: if the scan and the per-pid vet disagree (pid recycled to
    another container between the two), nothing is signalled. Mutation: drop the
    `_daemon_pid_live` vet in terminate_all_and_wait → RED."""
    _scan(monkeypatch)
    sent = []
    monkeypatch.setattr(notifier.os, "kill", lambda pid, sig: sent.append((pid, sig)))
    monkeypatch.setattr(notifier, "_daemon_pid_live", lambda pid, cid=None: False)
    notifier._reap_strays(CID, 12342)
    assert sent == []


# ---------- D3: no false "not running" ----------

def test_duplicate_stamp_no_longer_makes_owner_look_dead(monkeypatch, tmp_path):
    """THE symptom: owner 12342 is alive and stamping its own file, orphan 93267
    stamps the shared file last. The owner must stay healthy and must NOT be
    killed. Mutation: make heartbeat_verdict return False for a fresh foreign
    shared stamp (the old rule) and ignore the per-pid file → RED."""
    ws = _ws(tmp_path)
    notifier._pid_path(ws).write_text("12342")
    notifier._pid_hb_path(ws, 12342).parent.mkdir(parents=True, exist_ok=True)
    notifier._pid_hb_path(ws, 12342).write_text(f"12342 {time.time() - 1}")
    notifier._hb_path(ws).write_text(f"93267 {time.time()}")
    sent, alive = _record_kills(monkeypatch)
    assert notifier._heartbeat_verdict(ws, 12342) is True
    assert notifier.daemon_running(ws) == 12342
    assert sent == [], "the healthy owner must not be terminated"


def test_legacy_owner_with_foreign_fresh_shared_stamp_is_not_killed(monkeypatch, tmp_path):
    """Owner from an older build (no per-pid file) + a live duplicate's fresh shared
    stamp → no proof either way → ps identity decides, owner kept."""
    ws = _ws(tmp_path)
    notifier._pid_path(ws).write_text("12342")
    notifier._hb_path(ws).write_text(f"93267 {time.time()}")
    sent, alive = _record_kills(monkeypatch)
    assert notifier._heartbeat_verdict(ws, 12342) is None
    assert notifier.daemon_running(ws) == 12342
    assert sent == []


def test_wedged_owner_is_still_detected_by_its_own_stale_stamp(monkeypatch, tmp_path):
    """The fix must not hide a genuinely wedged owner: its own per-pid stamp is
    stale even though a duplicate keeps the shared file fresh. Mutation: prefer the
    shared file over the per-pid file → RED."""
    ws = _ws(tmp_path)
    notifier._pid_hb_path(ws, 12342).parent.mkdir(parents=True, exist_ok=True)
    notifier._pid_hb_path(ws, 12342).write_text(
        f"12342 {time.time() - notifier.HEARTBEAT_STALE_SECS - 5}")
    notifier._hb_path(ws).write_text(f"12342 {time.time()}")
    assert notifier._heartbeat_verdict(ws, 12342) is False


def test_only_the_pid_file_owner_writes_the_shared_heartbeat(monkeypatch, tmp_path):
    """A duplicate stamps its own per-pid file but leaves the shared file alone.
    Mutation: drop the `_owns_pid_file` guard in write_heartbeat → RED."""
    ws = _ws(tmp_path)
    me = notifier.os.getpid()
    notifier._pid_path(ws).write_text("12342")              # someone else owns it
    notifier._hb_path(ws).write_text(f"12342 {time.time() - 3}")
    before = notifier._hb_path(ws).read_text()
    notifier._write_heartbeat(ws)
    assert notifier._hb_path(ws).read_text() == before
    assert notifier._pid_hb_path(ws, me).read_text().split()[0] == str(me)
    notifier._pid_path(ws).write_text(str(me))              # now we own it
    notifier._write_heartbeat(ws)
    assert notifier._hb_path(ws).read_text().split()[0] == str(me)


# ---------- D4: no accumulation ----------

def test_duplicate_retires_once_owner_proves_life(monkeypatch, tmp_path):
    """Sleep/wake leftover: this daemon is not the pid-file owner and the owner
    has a fresh per-pid stamp → retire. Mutation: return None unconditionally
    from superseded_by → the duplicate lingers → RED."""
    ws = _ws(tmp_path)
    notifier._pid_path(ws).write_text("12342")
    notifier._pid_hb_path(ws, 12342).parent.mkdir(parents=True, exist_ok=True)
    notifier._pid_hb_path(ws, 12342).write_text(f"12342 {time.time() - 1}")
    _record_kills(monkeypatch)
    assert notifier._superseded_by(ws, CID) == 12342


def test_duplicate_does_not_retire_for_an_owner_without_proof(monkeypatch, tmp_path):
    """Owner has no fresh per-pid stamp (just started / older build / wedged) →
    stay; --ensure's health check decides who goes. Mutation: drop the stamp
    freshness check → RED."""
    ws = _ws(tmp_path)
    notifier._pid_path(ws).write_text("12342")
    _record_kills(monkeypatch)
    assert notifier._superseded_by(ws, CID) is None


def test_duplicate_reclaims_pid_file_when_owner_is_gone(monkeypatch, tmp_path):
    """Owner died: the surviving daemon takes over the pid file instead of retiring
    (so the slot is never left empty). Mutation: drop the re-claim write → RED."""
    ws = _ws(tmp_path)
    notifier._pid_path(ws).write_text("99999")              # dead pid
    _record_kills(monkeypatch)
    monkeypatch.setattr(notifier, "_global_pid_path", lambda cid: tmp_path / "g.pid")
    assert notifier._superseded_by(ws, CID) is None
    assert notifier._pid_path(ws).read_text() == str(notifier.os.getpid())


def test_leftover_never_steals_another_worktrees_container_claim(monkeypatch, tmp_path):
    """Local pid file gone, but the container claim names a proven daemon running
    from ANOTHER worktree → this one is the duplicate: retire, and do not overwrite
    the claim. Mutation: re-claim without consulting the container claim → RED."""
    ws = _ws(tmp_path / "wt-b")
    other_ws = _ws(tmp_path / "wt-a")
    claim = tmp_path / "claim.pid"
    claim.write_text(f"12342\n{other_ws}")
    monkeypatch.setattr(notifier, "_global_pid_path", lambda cid: claim)
    notifier._pid_hb_path(other_ws, 12342).parent.mkdir(parents=True, exist_ok=True)
    notifier._pid_hb_path(other_ws, 12342).write_text(f"12342 {time.time() - 1}")
    _record_kills(monkeypatch)
    assert notifier._superseded_by(ws, CID) == 12342
    assert claim.read_text().startswith("12342"), "the other worktree keeps its claim"
    assert not notifier._pid_path(ws).exists()


def test_owner_never_retires_itself(monkeypatch, tmp_path):
    ws = _ws(tmp_path)
    notifier._pid_path(ws).write_text(str(notifier.os.getpid()))
    assert notifier._superseded_by(ws, CID) is None


# ---------- D5: diagnosis under --quiet ----------

def test_lifecycle_log_is_timestamped_on_stderr(capsys):
    """Mutation: gate lifecycle_log on `not quiet` or drop the stamp → RED."""
    notifier._lifecycle_log("daemon up: pid 1")
    err = capsys.readouterr().err
    assert err.startswith("[notifier 20") and err.rstrip().endswith("daemon up: pid 1")


def test_daemon_loop_retires_a_duplicate_before_ticking(monkeypatch, tmp_path, capsys):
    """End to end through cmd_notifier: a running daemon that learns it is a
    duplicate leaves its loop (no wake tick), logs why with a timestamp under
    --quiet, and cleans up only its own files. Mutation: delete the owner check
    in the daemon loop → tick runs (raises) → RED."""
    import types

    monkeypatch.chdir(_ws(tmp_path))
    for name, value in {
        "_load_master_key_from_env_file": lambda *a, **k: None,
        "_write_global_pid": lambda *a, **k: None,
        "_global_pid_path": lambda cid: tmp_path / "claim.pid",
        "reconcile_codex_conversation_runs": lambda *a, **k: None,
        "reap_workers": lambda *a, **k: None,
        "reap_orphan_leases": lambda *a, **k: None,
        "service_residents": lambda *a, **k: None,
        "reap_orphaned_runs": lambda *a, **k: 0,
        "_probe_container": lambda *a, **k: "ok",
        "_OWNER_CHECK_INTERVAL": 0.0,
        "_superseded_by": lambda cwd, cid: 12342,
    }.items():
        monkeypatch.setattr(notifier, name, value)
    monkeypatch.setattr(notifier.signal, "signal", lambda *a, **k: None)

    def _tick(*a, **k):
        raise KeyboardInterrupt  # bounds the loop if the owner check is gone

    monkeypatch.setattr(notifier, "tick", _tick)
    args = types.SimpleNamespace(
        stop=False, restart=False, ensure=False, once=False, quiet=True,
        api_base="http://x", container=CID, dry_run=True, cooldown=0, min_idle=0,
        interval=999, lease_ttl=1200.0, stall_secs=120.0,
    )
    try:
        notifier.cmd_notifier(args)
    except KeyboardInterrupt:
        raise AssertionError("the duplicate kept ticking instead of retiring")
    err = capsys.readouterr().err
    assert "is a duplicate" in err and "retiring" in err and err.startswith("[notifier 20")
    assert not notifier._pid_hb_path(tmp_path, notifier.os.getpid()).exists()
