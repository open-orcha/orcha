"""ISS-22 round 3 — the "unstuck" incident: self-heal fooled by a dead daemon.

Field failure: the quantal-health notifier died (likely OOM); the provisioner's
2-minute `orcha notifier --ensure` self-heal never revived it because liveness
was pid-identity only — a recycled pid passed `os.kill(pid, 0)`, and `ps`
failing open (`_ps_inspect` → None ⇒ "alive") masked the death indefinitely.
The container sat unserviced until a human intervened ("unstuck").

Fix under test — heartbeat-primary SERVING liveness:
  H1  the daemon stamps `<pid> <epoch>` into .claude/.orcha-notifier.hb every
      loop pass (`write_heartbeat`), and `heartbeat_verdict` reads it back
      (True fresh+match / False stale-or-foreign / None no-file).
  H2  `daemon_pid_healthy` (NEW, serving lane): fresh heartbeat proves life;
      stale heartbeat is dead-or-wedged regardless of ps; NO heartbeat requires
      a POSITIVE ps identification — an unusable ps now fails CLOSED.
  H3  `daemon_running` / `daemon_running_for_container` use the healthy check,
      TERMINATE a wedged (alive-but-stale) daemon, and clear the claim so
      `--ensure` actually frees the slot instead of double-spawning.
  H4  `daemon_pid_live` (termination lane) intentionally keeps its fail-open
      behavior so a wedged daemon stays killable.

Each test carries a mutation note: revert the named production line → RED.
"""
import pathlib
import time
import types

from orcha_cli import notifier  # noqa: E402 (conftest puts orcha-cli on sys.path)

_PID = 4242


def _ws(tmp_path):
    (tmp_path / ".claude").mkdir(parents=True, exist_ok=True)
    return tmp_path


def _stamp(ws, pid, age_secs):
    notifier._hb_path(ws).write_text(f"{pid} {time.time() - age_secs}")


def _ps_says(monkeypatch, value):
    monkeypatch.setattr(notifier, "_ps_inspect", lambda _pid: value)


def _alive(monkeypatch, alive=True):
    monkeypatch.setattr(notifier, "_pid_alive", lambda _pid: alive)


# ---------- H1: stamp + verdict ----------

def test_write_heartbeat_stamps_own_pid_and_now(tmp_path, monkeypatch):
    """Mutation: drop the write in `write_heartbeat` → no file → RED."""
    ws = _ws(tmp_path)
    notifier._write_heartbeat(ws)
    pid_s, ts_s = notifier._hb_path(ws).read_text().split()
    assert int(pid_s) == notifier.os.getpid()
    assert abs(float(ts_s) - time.time()) < 5.0


def test_heartbeat_verdict_fresh_stale_foreign_missing(tmp_path):
    """Mutation: drop the `hb_pid != pid` guard or the staleness compare → RED."""
    ws = _ws(tmp_path)
    assert notifier._heartbeat_verdict(ws, _PID) is None          # no file
    _stamp(ws, _PID, age_secs=1.0)
    assert notifier._heartbeat_verdict(ws, _PID) is True          # fresh + match
    _stamp(ws, _PID, age_secs=notifier.HEARTBEAT_STALE_SECS + 5)
    assert notifier._heartbeat_verdict(ws, _PID) is False         # stale
    _stamp(ws, _PID + 1, age_secs=1.0)
    assert notifier._heartbeat_verdict(ws, _PID) is False         # another pid's


# ---------- H2: serving-lane health ----------

def test_healthy_requires_positive_ps_when_no_heartbeat(tmp_path, monkeypatch):
    """THE incident: pid alive, ps unusable (None), no heartbeat — the old check
    said alive; the serving lane must now say DEAD. Mutation: restore the
    fail-open `return True` for `info is None` in daemon_pid_healthy → RED."""
    ws = _ws(tmp_path)
    _alive(monkeypatch)
    _ps_says(monkeypatch, None)
    assert notifier._daemon_pid_healthy(_PID, "CID-1", ws) is False


def test_healthy_rejects_recycled_pid_without_heartbeat(tmp_path, monkeypatch):
    """A recycled pid belonging to a non-notifier process is dead for serving.
    Mutation: drop the `'notifier' not in command` guard → RED."""
    ws = _ws(tmp_path)
    _alive(monkeypatch)
    _ps_says(monkeypatch, ("S", "postgres: checkpointer"))
    assert notifier._daemon_pid_healthy(_PID, "CID-1", ws) is False


def test_healthy_true_on_fresh_heartbeat_even_if_ps_unusable(tmp_path, monkeypatch):
    """A fresh heartbeat is proof of life on ps-less systems. Mutation: require
    ps success before honoring a True verdict → RED."""
    ws = _ws(tmp_path)
    _alive(monkeypatch)
    _ps_says(monkeypatch, None)
    _stamp(ws, _PID, age_secs=1.0)
    assert notifier._daemon_pid_healthy(_PID, "CID-1", ws) is True


def test_healthy_fresh_heartbeat_still_vetoed_by_foreign_command(tmp_path, monkeypatch):
    """Heartbeat + recycled pid race: ps positively identifying a NON-notifier
    wins over a (necessarily stale-owner) heartbeat. Mutation: drop the
    post-verdict command veto → RED."""
    ws = _ws(tmp_path)
    _alive(monkeypatch)
    _ps_says(monkeypatch, ("S", "python3 -m http.server"))
    _stamp(ws, _PID, age_secs=1.0)
    assert notifier._daemon_pid_healthy(_PID, "CID-1", ws) is False


def test_healthy_stale_heartbeat_is_dead_even_with_good_ps(tmp_path, monkeypatch):
    """A wedged daemon (real process, stopped stamping) is unhealthy. Mutation:
    treat verdict False as fall-through to the ps path → RED."""
    ws = _ws(tmp_path)
    _alive(monkeypatch)
    _ps_says(monkeypatch, ("S", "orcha notifier --quiet --container CID-1"))
    _stamp(ws, _PID, age_secs=notifier.HEARTBEAT_STALE_SECS + 5)
    assert notifier._daemon_pid_healthy(_PID, "CID-1", ws) is False


def test_healthy_no_heartbeat_grace_with_positive_ps(tmp_path, monkeypatch):
    """A just-started daemon (first stamp pending) with a positive ps identity
    is healthy — no false replace. Mutation: fail-closed on verdict None even
    with a good ps → RED."""
    ws = _ws(tmp_path)
    _alive(monkeypatch)
    _ps_says(monkeypatch, ("S", "orcha notifier --quiet --container CID-1"))
    assert notifier._daemon_pid_healthy(_PID, "CID-1", ws) is True


# ---------- H3: daemon_running frees a wedged slot ----------

def test_daemon_running_terminates_wedged_daemon_and_clears_claim(tmp_path, monkeypatch):
    """Stale heartbeat + live identity ⇒ terminate + unlink + None, so --ensure
    can spawn a replacement instead of trusting (or duplicating) the wedged one.
    Mutation: skip the `_terminate_and_wait` call in daemon_running → RED."""
    ws = _ws(tmp_path)
    notifier._pid_path(ws).write_text(str(_PID))
    _stamp(ws, _PID, age_secs=notifier.HEARTBEAT_STALE_SECS + 5)
    _alive(monkeypatch)
    _ps_says(monkeypatch, ("S", "orcha notifier --quiet"))
    monkeypatch.setattr(notifier, "_container_id_for", lambda _cwd: "CID-1")
    killed = []
    monkeypatch.setattr(notifier, "_terminate_and_wait",
                        lambda pid, cid, grace=8.0: killed.append((pid, cid)))
    assert notifier.daemon_running(ws) is None
    assert killed == [(_PID, "CID-1")]
    assert not notifier._pid_path(ws).exists()


def test_daemon_running_returns_healthy_pid(tmp_path, monkeypatch):
    """Fresh heartbeat ⇒ the pid is returned untouched. Mutation: invert the
    healthy check → RED."""
    ws = _ws(tmp_path)
    notifier._pid_path(ws).write_text(str(_PID))
    _stamp(ws, _PID, age_secs=1.0)
    _alive(monkeypatch)
    _ps_says(monkeypatch, ("S", "orcha notifier --quiet"))
    monkeypatch.setattr(notifier, "_container_id_for", lambda _cwd: "CID-1")
    assert notifier.daemon_running(ws) == _PID


def test_container_claim_uses_workspace_heartbeat(tmp_path, monkeypatch):
    """The global claim's 2nd line (workspace) grounds the heartbeat check for
    daemon_running_for_container. Mutation: pass cwd=None there → the stale
    heartbeat goes unseen, positive ps wins → RED."""
    ws = _ws(tmp_path)
    _stamp(ws, _PID, age_secs=notifier.HEARTBEAT_STALE_SECS + 5)
    claim = tmp_path / "claim.pid"
    claim.write_text(f"{_PID}\n{ws}")
    monkeypatch.setattr(notifier, "_global_pid_path", lambda _cid: claim)
    _alive(monkeypatch)
    _ps_says(monkeypatch, ("S", "orcha notifier --quiet --container CID-1"))
    killed = []
    monkeypatch.setattr(notifier, "_terminate_and_wait",
                        lambda pid, cid, grace=8.0: killed.append(pid))
    assert notifier.daemon_running_for_container("CID-1") is None
    assert killed == [_PID]
    assert not claim.exists()


# ---------- H4: termination lane unchanged ----------

def test_termination_lane_keeps_fail_open(monkeypatch):
    """`daemon_pid_live` must stay permissive so a wedged daemon is killable.
    Mutation: make it consult the heartbeat → a stale-hb daemon reads dead →
    terminate_and_wait no-ops → RED."""
    _alive(monkeypatch)
    _ps_says(monkeypatch, None)
    assert notifier._daemon_pid_live(_PID, "CID-1") is True
