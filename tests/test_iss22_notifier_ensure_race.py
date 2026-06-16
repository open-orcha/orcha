"""ISS-22 / #92 — `orcha notifier --ensure` racy liveness check after a kill.

Root cause: `daemon_running()`/`_pid_alive()` use a bare `os.kill(pid, 0)`, which reports a
non-live process as ALIVE for two states — a ZOMBIE (exited, not yet reaped) and a REUSED pid
(after a SIGKILL the finally-block never cleared the pidfile and the OS handed the pid to an
unrelated process). So `--ensure` refuses to spawn a replacement and the container is left
unserviced. A third form is the graceful-drain window on the restart path, where `stop_daemon`
returned BEFORE the old daemon finished exiting.

Fix (host-CLI only, zero API/DB/OpenAPI):
  P1  `_daemon_pid_live()` vets the pid against `ps` (reject zombie / foreign / wrong-container),
      fail-open if `ps` is unusable; `daemon_running()` uses it and CLEARS a stale pidfile.
  P2  `_terminate_and_wait()` blocks until the daemon actually exits (SIGKILL after grace);
      `stop_daemon` uses it; new `orcha notifier --restart` / `--stop` operator verbs.

Each test carries a mutation note: revert the named production line and the assert goes RED.
"""
import signal
import types

import pytest

from orcha_cli import notifier            # noqa: E402 (conftest puts orcha-cli on sys.path)

_DEAD_PID = 2_000_000_000                 # a pid that is virtually never alive
_LIVE_PID = 4242


# ---------- P1: _ps_inspect parsing ----------

def test_ps_inspect_parses_state_and_command(monkeypatch):
    """`ps -o state= -o command=` output is split into (state, command). Mutation: change the
    `line.partition(" ")` split → state/command get mangled → this RED."""
    monkeypatch.setattr(notifier.subprocess, "run",
                        lambda *a, **k: types.SimpleNamespace(
                            returncode=0, stdout="S   orcha notifier --quiet --container CID-1\n"))
    state, command = notifier._ps_inspect(_LIVE_PID)
    assert state == "S"
    assert command == "orcha notifier --quiet --container CID-1"


def test_ps_inspect_returns_none_on_ps_error(monkeypatch):
    """A non-zero `ps` exit (pid gone) yields None so the caller can fail open. Mutation: drop
    the `if out.returncode != 0: return None` guard → returns a bogus tuple → this RED."""
    monkeypatch.setattr(notifier.subprocess, "run",
                        lambda *a, **k: types.SimpleNamespace(returncode=1, stdout=""))
    assert notifier._ps_inspect(_LIVE_PID) is None


def test_ps_inspect_returns_none_when_ps_missing(monkeypatch):
    """`ps` absent / OSError → None (fail-open signal). Mutation: drop the OSError except → raises."""
    def _boom(*a, **k):
        raise FileNotFoundError("no ps")
    monkeypatch.setattr(notifier.subprocess, "run", _boom)
    assert notifier._ps_inspect(_LIVE_PID) is None


# ---------- P1: _daemon_pid_live verdicts ----------

def test_daemon_pid_live_rejects_zombie(monkeypatch):
    """A zombie (state starts with Z) is NOT a live daemon even though os.kill(pid,0) succeeds.
    Mutation: drop the `if state and state[0] == 'Z'` reject → returns True → this RED."""
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(notifier, "_ps_inspect", lambda pid: ("Z", "orcha notifier --quiet"))
    assert notifier._daemon_pid_live(_LIVE_PID) is False


def test_daemon_pid_live_rejects_reused_foreign_pid(monkeypatch):
    """A reused pid running an unrelated command (no 'notifier') is rejected. Mutation: drop the
    `if 'notifier' not in command` reject → a `vim` on a reused pid reads as a live daemon."""
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(notifier, "_ps_inspect", lambda pid: ("S", "vim notes.txt"))
    assert notifier._daemon_pid_live(_LIVE_PID) is False


def test_daemon_pid_live_rejects_other_container(monkeypatch):
    """A notifier stamped for a DIFFERENT container (reused pid taken by another project's
    daemon) is rejected when we know our cid. Mutation: drop the cid mismatch reject → True."""
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(notifier, "_ps_inspect",
                        lambda pid: ("S", "orcha notifier --quiet --container OTHER-CID"))
    assert notifier._daemon_pid_live(_LIVE_PID, cid="OUR-CID") is False


def test_daemon_pid_live_accepts_our_notifier(monkeypatch):
    """A live notifier for OUR container is accepted."""
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(notifier, "_ps_inspect",
                        lambda pid: ("S", "orcha notifier --quiet --container OUR-CID"))
    assert notifier._daemon_pid_live(_LIVE_PID, cid="OUR-CID") is True


def test_daemon_pid_live_accepts_notifier_without_container_token(monkeypatch):
    """A directly-started `orcha notifier` (no --container token) can't be disambiguated, so it's
    accepted as ours — guards against falsely killing a legit daemon. Mutation: change the
    `'--container' in command` guard to an unconditional cid check → this RED."""
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(notifier, "_ps_inspect", lambda pid: ("S", "orcha notifier --quiet"))
    assert notifier._daemon_pid_live(_LIVE_PID, cid="OUR-CID") is True


def test_daemon_pid_live_fails_open_when_ps_unavailable(monkeypatch):
    """`ps` unusable (None) → fall back to os.kill verdict (alive). Mutation: change the
    `if info is None: return True` to `return False` → a live daemon reads dead on a ps-less box."""
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(notifier, "_ps_inspect", lambda pid: None)
    assert notifier._daemon_pid_live(_LIVE_PID) is True


def test_daemon_pid_live_dead_pid_is_false(monkeypatch):
    """os.kill gate first: a dead pid is False without even consulting ps. Mutation: drop the
    leading `if not _pid_alive(pid): return False` → calls ps on a dead pid."""
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: False)
    monkeypatch.setattr(notifier, "_ps_inspect",
                        lambda pid: pytest.fail("ps must not be consulted for a dead pid"))
    assert notifier._daemon_pid_live(_DEAD_PID) is False


# ---------- P1: daemon_running clears a stale pidfile ----------

def _write_pidfile(tmp_path, pid):
    pidf = tmp_path / ".claude" / ".orcha-notifier.pid"
    pidf.parent.mkdir(parents=True, exist_ok=True)
    pidf.write_text(str(pid))
    return pidf


def test_daemon_running_clears_stale_pidfile(monkeypatch, tmp_path):
    """A pidfile pointing at a dead/zombie/reused pid is CLEARED and None returned — so a stale
    pidfile can't make --ensure refuse forever. Mutation: drop the `p.unlink()` in the dead
    branch → the file survives → this RED."""
    pidf = _write_pidfile(tmp_path, _DEAD_PID)
    monkeypatch.setattr(notifier, "_daemon_pid_live", lambda pid, cid=None: False)
    assert notifier.daemon_running(tmp_path) is None
    assert not pidf.exists(), "stale pidfile must be cleared"


def test_daemon_running_keeps_live_pidfile(monkeypatch, tmp_path):
    """A live daemon's pid is returned and its pidfile preserved."""
    pidf = _write_pidfile(tmp_path, _LIVE_PID)
    monkeypatch.setattr(notifier, "_daemon_pid_live", lambda pid, cid=None: True)
    assert notifier.daemon_running(tmp_path) == _LIVE_PID
    assert pidf.exists()


# ---------- P2: _terminate_and_wait ----------

class _AdvancingClock:
    """time.time() that advances `step` seconds per call so the bounded wait can cross its grace."""
    def __init__(self, step=1.0):
        self.t = 0.0
        self.step = step
    def __call__(self):
        self.t += self.step
        return self.t


def test_terminate_and_wait_returns_after_clean_exit(monkeypatch):
    """SIGTERM, then return as soon as the pid exits — no SIGKILL. Mutation: delete the
    `if not _daemon_pid_live(...): return` inside the loop → it never short-circuits and escalates."""
    sent = []
    monkeypatch.setattr(notifier.os, "kill", lambda pid, sig: sent.append(sig))
    monkeypatch.setattr(notifier.time, "sleep", lambda s: None)
    monkeypatch.setattr(notifier.time, "time", _AdvancingClock())
    # alive on the first poll, then exits
    seq = iter([True, False])
    monkeypatch.setattr(notifier, "_daemon_pid_live", lambda pid, cid=None: next(seq, False))

    notifier._terminate_and_wait(_LIVE_PID, "CID")
    assert sent == [signal.SIGTERM], "clean exit must NOT escalate to SIGKILL"


def test_terminate_and_wait_escalates_to_sigkill(monkeypatch, capsys):
    """A daemon that won't exit within grace is SIGKILL'd and the escalation logged LOUDLY.
    Mutation: drop the `os.kill(pid, signal.SIGKILL)` after the grace loop → no SIGKILL → RED."""
    sent = []
    monkeypatch.setattr(notifier.os, "kill", lambda pid, sig: sent.append(sig))
    monkeypatch.setattr(notifier.time, "sleep", lambda s: None)
    monkeypatch.setattr(notifier.time, "time", _AdvancingClock(step=1.0))
    monkeypatch.setattr(notifier, "_daemon_pid_live", lambda pid, cid=None: True)  # never exits

    notifier._terminate_and_wait(_LIVE_PID, "CID", grace=8.0)
    assert signal.SIGTERM in sent and signal.SIGKILL in sent
    err = capsys.readouterr().err
    assert "SIGKILL" in err and str(_LIVE_PID) in err, "escalation must be logged loudly with the pid"


def test_terminate_and_wait_noop_when_already_dead(monkeypatch):
    """If the pid passes the leading identity vet but the SIGTERM then races a clean exit
    (ProcessLookupError), return immediately — no grace-loop wait, no SIGKILL. Mutation: drop the
    `except ProcessLookupError: return` after the SIGTERM → it would enter the grace loop.

    #276 rework note: the leading `_daemon_pid_live` guard now polls ONCE before the SIGTERM, so
    the grace loop adding further polls is the regression we guard against — exactly one poll, the
    pre-vet, means the loop was never entered."""
    sent = []
    def _kill(pid, sig):
        sent.append(sig)
        raise ProcessLookupError
    monkeypatch.setattr(notifier.os, "kill", _kill)
    polled = {"n": 0}
    monkeypatch.setattr(notifier, "_daemon_pid_live",
                        lambda pid, cid=None: polled.__setitem__("n", polled["n"] + 1) or True)
    notifier._terminate_and_wait(_LIVE_PID, "CID")
    assert sent == [signal.SIGTERM], "only a SIGTERM is attempted; no SIGKILL after it raced gone"
    assert polled["n"] == 1, "only the leading pre-signal vet runs — the grace loop must not be entered"


# ---------- P2: stop_daemon waits before returning ----------

def test_stop_daemon_waits_for_exit(monkeypatch, tmp_path):
    """stop_daemon routes the kill through _terminate_and_wait (blocks until exit). Mutation:
    replace `_terminate_and_wait(pid, cid)` with a bare `os.kill(pid, SIGTERM)` → this RED."""
    _write_pidfile(tmp_path, _LIVE_PID)
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: _LIVE_PID)
    monkeypatch.setattr(notifier, "_container_id_for", lambda cwd: None)
    monkeypatch.setattr(notifier, "daemon_running_for_container", lambda cid: None)
    waited = {"pid": None}
    monkeypatch.setattr(notifier, "_terminate_and_wait",
                        lambda pid, cid, grace=8.0: waited.__setitem__("pid", pid))
    assert notifier.stop_daemon(tmp_path, quiet=True) is True
    assert waited["pid"] == _LIVE_PID, "stop_daemon must wait for the pid to exit"


# ---------- P2: CLI verbs ----------

def _ns(**kw):
    ns = types.SimpleNamespace(quiet=False, ensure=False, once=False, stop=False, restart=False)
    for k, v in kw.items():
        setattr(ns, k, v)
    return ns


def test_cmd_notifier_stop_noop_message(monkeypatch, capsys):
    """`--stop` with no running daemon prints a clear no-op message and does NOT error. Mutation:
    drop the `if not stopped: print(...nothing to stop)` → silent → this RED."""
    monkeypatch.setattr(notifier, "stop_daemon", lambda cwd, quiet=False: False)
    notifier.cmd_notifier(_ns(stop=True))
    assert "nothing to stop" in capsys.readouterr().out


def test_cmd_notifier_restart_calls_ensure_restart(monkeypatch):
    """`--restart` routes to ensure_daemon(restart=True). Mutation: change the restart branch to
    `ensure_daemon(cwd)` (no restart) → the old daemon is never stopped → this RED."""
    seen = {}
    monkeypatch.setattr(notifier, "ensure_daemon",
                        lambda cwd, quiet=False, restart=False: seen.update(restart=restart))
    notifier.cmd_notifier(_ns(restart=True))
    assert seen.get("restart") is True


def test_cmd_notifier_stop_takes_precedence_over_ensure(monkeypatch):
    """`--stop` is handled before `--ensure` so the operator verb wins. Mutation: move the stop
    branch BELOW the --ensure block → --ensure would spawn instead of stopping."""
    calls = []
    monkeypatch.setattr(notifier, "stop_daemon", lambda cwd, quiet=False: calls.append("stop") or True)
    monkeypatch.setattr(notifier, "ensure_daemon",
                        lambda cwd, quiet=False, restart=False: calls.append("ensure"))
    notifier.cmd_notifier(_ns(stop=True, ensure=True))
    assert calls == ["stop"], "stop must win over ensure"


# ====================================================================================
# #276 GATE 2nd-pass REWORK — the container-GLOBAL pidfile path (the local-pidfile fix
# above left the dual-pidfile path on a bare `_pid_alive`, so #92 still reproduced and a
# stop path could signal a reused/foreign pid). Two P1s:
#   P1 #1 CORRECTNESS — global-claim liveness must be identity-vetted + clear stale claims.
#   P1 #2 SAFETY      — NO stop path may signal a pid before it passes `_daemon_pid_live`.
# ====================================================================================

def _write_global_pidfile(monkeypatch, tmp_path, container_id, pid, cwd_line="/some/cwd"):
    """Point _global_pid_path at tmp_path (never the real $HOME) and seed a global claim."""
    gp = tmp_path / "global" / f"notifier-{container_id}.pid"
    gp.parent.mkdir(parents=True, exist_ok=True)
    gp.write_text(f"{pid}\n{cwd_line}")
    monkeypatch.setattr(notifier, "_global_pid_path", lambda cid: gp)
    return gp


# ---------- P1 #1: daemon_running_for_container is identity-vetted + clears stale claims ----------

def test_daemon_running_for_container_clears_stale_global_claim(monkeypatch, tmp_path):
    """A GLOBAL claim pointing at a zombie/reused/foreign pid is CLEARED and None returned — the
    dual-pidfile path that 1st-pass missed (#92 still repro'd through it). Mutation: revert the
    global reader to bare `_pid_alive` (or drop the `p.unlink()`) → stale claim survives → RED."""
    gp = _write_global_pidfile(monkeypatch, tmp_path, "CID-1", _DEAD_PID)
    monkeypatch.setattr(notifier, "_daemon_pid_live", lambda pid, cid=None: False)
    assert notifier.daemon_running_for_container("CID-1") is None
    assert not gp.exists(), "stale GLOBAL claim must be cleared so --ensure can spawn"


def test_daemon_running_for_container_keeps_live_global_claim(monkeypatch, tmp_path):
    """A live daemon's global claim is returned as (pid, cwd) and the file preserved."""
    gp = _write_global_pidfile(monkeypatch, tmp_path, "CID-1", _LIVE_PID, cwd_line="/work/tree")
    monkeypatch.setattr(notifier, "_daemon_pid_live", lambda pid, cid=None: True)
    assert notifier.daemon_running_for_container("CID-1") == (_LIVE_PID, "/work/tree")
    assert gp.exists(), "a live global claim must be preserved"


def test_claim_container_treats_zombie_holder_as_stale(monkeypatch, tmp_path):
    """When the O_EXCL create loses to an EXISTING claim whose pid is a ZOMBIE (os.kill sees it
    alive but it's not a live daemon), `_claim_container`'s explicit staleness check must use
    `_daemon_pid_live` — judge it stale, clear it and WIN the claim so --ensure spawns. We pin the
    vetted reader (`daemon_running_for_container`) to None so the loop reaches that inner check on
    the raw pidfile. Mutation: revert the `stale = not _daemon_pid_live(...)` to bare `_pid_alive`
    → the zombie reads live (`_pid_alive` True) → stale=False → claim refused → no spawn → RED."""
    _write_global_pidfile(monkeypatch, tmp_path, "CID-1", _LIVE_PID)
    monkeypatch.setattr(notifier, "daemon_running_for_container", lambda cid: None)  # reader: no live holder
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: True)                    # zombie: os.kill sees it
    monkeypatch.setattr(notifier, "_daemon_pid_live", lambda pid, cid=None: False)   # but not a live daemon
    won, holder = notifier._claim_container("CID-1")
    assert won is True and holder is None, "a stale (zombie) claim must be cleared and re-won"


# ---------- P1 #2: no stop path signals a pid before it passes the identity vet ----------

def test_terminate_and_wait_sends_no_signal_to_unvetted_pid(monkeypatch):
    """The leading guard: if the pid is NOT our live daemon (reused/foreign/zombie/dead), send NO
    signal at all — Gate's repro SIGTERM'd a `vim`. Mutation: drop the leading
    `if not _daemon_pid_live(pid, cid): return` → a SIGTERM lands on the foreign pid → RED."""
    sent = []
    monkeypatch.setattr(notifier.os, "kill", lambda pid, sig: sent.append(sig))
    monkeypatch.setattr(notifier.time, "sleep", lambda s: None)
    monkeypatch.setattr(notifier.time, "time", _AdvancingClock())
    monkeypatch.setattr(notifier, "_daemon_pid_live", lambda pid, cid=None: False)  # not our daemon
    notifier._terminate_and_wait(_LIVE_PID, "CID")
    assert sent == [], "must NOT signal a pid that fails the identity vet"


def test_stop_daemon_for_container_routes_through_terminate_and_wait(monkeypatch, tmp_path):
    """`stop_daemon_for_container` must route the kill through `_terminate_and_wait` (which re-vets
    identity) instead of a bare `os.kill` — the second signal-before-vet site Gate flagged.
    Mutation: restore the bare `os.kill(holder[0], SIGTERM)` → `_terminate_and_wait` not called →
    RED, and a raw signal would reach an unvetted pid."""
    _write_global_pidfile(monkeypatch, tmp_path, "CID-1", _LIVE_PID)
    monkeypatch.setattr(notifier, "daemon_running_for_container", lambda cid: (_LIVE_PID, ""))
    routed = {"pid": None}
    monkeypatch.setattr(notifier, "_terminate_and_wait",
                        lambda pid, cid, grace=8.0: routed.__setitem__("pid", pid))
    # a bare os.kill here would be the bug — make it loud if anything calls it directly
    monkeypatch.setattr(notifier.os, "kill",
                        lambda pid, sig: pytest.fail("stop_daemon_for_container must not os.kill directly"))
    assert notifier.stop_daemon_for_container("CID-1", quiet=True) is True
    assert routed["pid"] == _LIVE_PID, "kill must route through the identity-vetting _terminate_and_wait"
