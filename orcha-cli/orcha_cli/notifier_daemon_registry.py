"""Track notifier daemon ownership with local and container-wide PID claims."""

from __future__ import annotations

import json
import pathlib
from typing import Optional


def pid_path(cwd: pathlib.Path) -> pathlib.Path:
    return cwd / ".claude" / ".orcha-notifier.pid"


def log_path(cwd: pathlib.Path) -> pathlib.Path:
    return cwd / ".claude" / ".orcha-notifier.log"


# ISS-22 round 3 (the "unstuck" incident): pid-identity vetting alone is spoofable —
# a recycled pid whose command happens to pass the ps vet, or an unusable ps
# (the old FAIL-OPEN), reported a dead daemon as alive, so `--ensure`'s 2-minute
# self-heal skipped the restart forever and the container sat unserviced. The
# heartbeat is ground truth the daemon itself must keep proving: a file it
# re-stamps every loop pass. Liveness for SERVING decisions now requires either a
# FRESH heartbeat or (no heartbeat yet — a just-started daemon) a POSITIVE ps
# identification; an unreadable ps no longer fails open.
HEARTBEAT_STALE_SECS = 120.0  # 60× the 2s loop; generous for long ticks


def hb_path(cwd: pathlib.Path) -> pathlib.Path:
    return cwd / ".claude" / ".orcha-notifier.hb"


def hb_dir(cwd: pathlib.Path) -> pathlib.Path:
    """Per-daemon heartbeats (GH #313): one `<pid>` file per daemon, so a duplicate
    daemon can no longer overwrite the pid-file owner's proof-of-life."""
    return cwd / ".claude" / ".orcha-notifier.hb.d"


def pid_hb_path(cwd: pathlib.Path, pid: int) -> pathlib.Path:
    return hb_dir(cwd) / str(int(pid))


def owns_pid_file(cwd: pathlib.Path, *, services) -> bool:
    """True when the local pid file names this process (or the launcher that
    spawned it), or when there is no readable pid file to defer to."""
    try:
        owner = int(services._pid_path(cwd).read_text().strip())
    except (OSError, ValueError):
        return True
    return owner in (services.os.getpid(), services.os.getppid())


def write_heartbeat(cwd: pathlib.Path, *, services) -> None:
    """Stamp `<pid> <epoch>` — the daemon's own proof-of-life, once per loop pass.

    Always into this daemon's per-pid file; into the shared file (read by older
    tools and `orcha serve`) only while it owns the pid file, so a stray
    duplicate stops overwriting the owner's stamp (GH #313)."""
    stamp = f"{services.os.getpid()} {services.time.time()}"
    try:
        own = services._pid_hb_path(cwd, services.os.getpid())
        own.parent.mkdir(parents=True, exist_ok=True)
        own.write_text(stamp)
    except OSError:
        pass
    if not services._owns_pid_file(cwd):
        return
    try:
        services._hb_path(cwd).write_text(stamp)
    except OSError:
        pass


def _read_stamp(path: pathlib.Path) -> Optional[tuple]:
    try:
        raw = path.read_text().split()
        return int(raw[0]), float(raw[1])
    except (OSError, ValueError, IndexError):
        return None


def read_pid_stamp(cwd: pathlib.Path, pid: int, *, services) -> Optional[float]:
    """Epoch of `pid`'s own per-pid heartbeat, or None when it has none."""
    stamp = _read_stamp(services._pid_hb_path(cwd, pid))
    return stamp[1] if stamp is not None and stamp[0] == pid else None


def heartbeat_verdict(cwd: pathlib.Path, pid: int, *, services):
    """True = fresh; False = stale; None = no proof about this pid either way.

    The pid's own per-pid stamp is authoritative. Without one (a daemon from an
    older build, or one still in its first pass) the shared file is consulted:
    its own stamp counts as before, but a FRESH stamp from another pid says
    nothing about this one — that was a live duplicate overwriting it, and the
    old `False` got a healthy owner killed and replaced (GH #313). A STALE
    foreign stamp still means nobody, this pid included, has stamped for
    HEARTBEAT_STALE_SECS, so it stays False."""
    now = services.time.time()
    own = _read_stamp(services._pid_hb_path(cwd, pid))
    if own is not None and own[0] == pid:
        return (now - own[1]) < HEARTBEAT_STALE_SECS
    shared = _read_stamp(services._hb_path(cwd))
    if shared is None:
        return None
    fresh = (now - shared[1]) < HEARTBEAT_STALE_SECS
    if shared[0] == pid:
        return fresh
    return None if fresh else False


def pid_alive(pid: int, *, services) -> bool:
    try:
        services.os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError, ValueError, TypeError):
        return False


def ps_inspect(pid: int, *, services) -> Optional[tuple]:
    """Return a process state and command, failing open when ps is unavailable."""
    try:
        result = services.subprocess.run(
            ["ps", "-o", "state=", "-o", "command=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=2.0,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    line = (result.stdout or "").strip()
    if not line:
        return None
    state, _, command = line.partition(" ")
    return state, command.strip()


def daemon_pid_live(pid: int, cid: Optional[str], *, services) -> bool:
    """Reject zombies, reused PIDs, and daemons bound to another container.

    This is the TERMINATION-lane check (may I / need I still kill this pid?) —
    deliberately fail-open on an unusable ps so a wedged daemon stays killable.
    Serving decisions (ensure/claim/daemon_running) use daemon_pid_healthy."""
    if not services._pid_alive(pid):
        return False
    info = services._ps_inspect(pid)
    if info is None:
        return True
    state, command = info
    if state and state[0] == "Z":
        return False
    if "notifier" not in command:
        return False
    return not (cid and "--container" in command and cid not in command)


def daemon_pid_healthy(
    pid: int, cid: Optional[str], cwd: Optional[pathlib.Path], *, services
) -> bool:
    """SERVING-lane liveness: is this daemon genuinely alive AND doing its job?

    Heartbeat-primary: a fresh heartbeat proves both. A stale heartbeat (dead OR
    wedged daemon) is unhealthy regardless of what ps says. With no heartbeat
    file (daemon just started, pre-heartbeat build, or cwd unknown) fall back to
    ps identity — but FAIL CLOSED when ps is unusable: a healthy daemon writes
    its first heartbeat within one 2s loop pass, so "no proof either way" means
    replace, not trust (the failure mode behind the unstuck incident)."""
    if not services._pid_alive(pid):
        return False
    verdict = services._heartbeat_verdict(cwd, pid) if cwd is not None else None
    if verdict is False:
        return False
    info = services._ps_inspect(pid)
    if verdict is True:
        # heartbeat proves life; ps (when usable) may still veto a recycled pid
        if info is not None and "notifier" not in info[1]:
            return False
        return True
    if info is None:
        return False
    state, command = info
    if state and state[0] == "Z":
        return False
    if "notifier" not in command:
        return False
    return not (cid and "--container" in command and cid not in command)


# GH #313: the pid file only ever names ONE daemon, so daemons it does not name
# (orphans of a sleep/wake or session restart, a supervisor's respawn beside an
# --ensure'd one) were invisible to --ensure/--restart and piled up. Discovery is
# a process scan for the daemon LOOP of this exact container.
_ONE_SHOT_FLAGS = frozenset({"--ensure", "--stop", "--restart", "--once", "-h", "--help"})
_INTERPRETERS = ("sh", "bash", "zsh", "env")


def is_container_daemon_command(command: str, cid: str) -> bool:
    """Is this ps command line the long-running notifier loop for `cid`?

    Matches `orcha notifier ...` and `python -m orcha_cli notifier ...`. Only an
    interpreter or flags may precede the `orcha` token, so a worker whose prompt
    text merely quotes the command never matches; the exact `--container <cid>`
    pair is required (never another container's daemon); one-shot verbs
    (--ensure/--stop/--restart/--once) are not daemons."""
    if not cid:
        return False
    tokens = command.split()
    try:
        at = tokens.index("notifier")
    except ValueError:
        return False
    if at == 0 or at > 5:
        return False
    if pathlib.PurePath(tokens[at - 1]).name not in ("orcha", "orcha_cli"):
        return False
    for token in tokens[: at - 1]:
        name = pathlib.PurePath(token).name
        if not (token.startswith("-") or name.startswith("python") or name in _INTERPRETERS):
            return False
    args = tokens[at + 1:]
    if _ONE_SHOT_FLAGS.intersection(args):
        return False
    if f"--container={cid}" in args:
        return True
    return any(
        arg == "--container" and i + 1 < len(args) and args[i + 1] == cid
        for i, arg in enumerate(args)
    )


def ps_table(*, services) -> Optional[list]:
    """`(pid, ppid, state, command)` for every process; None when ps is unusable."""
    try:
        result = services.subprocess.run(
            ["ps", "-A", "-o", "pid=", "-o", "ppid=", "-o", "state=", "-o", "command="],
            capture_output=True,
            text=True,
            timeout=5.0,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    rows = []
    for line in (result.stdout or "").splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        try:
            rows.append((int(parts[0]), int(parts[1]), parts[2], parts[3]))
        except ValueError:
            continue
    return rows


def container_daemons(cid: str, *, services) -> Optional[dict]:
    """`{pid: ppid}` of every live notifier daemon loop for `cid`, zombies
    excluded; None when ps is unusable (callers then reap nothing)."""
    rows = services._ps_table()
    if rows is None:
        return None
    return {
        pid: ppid
        for pid, ppid, state, command in rows
        if not state.startswith("Z") and is_container_daemon_command(command, cid)
    }


def container_id_for(cwd: pathlib.Path) -> Optional[str]:
    try:
        config = json.loads((cwd / ".claude" / "orcha.json").read_text())
        return config.get("current_container_id") or None
    except (OSError, ValueError):
        return None


def api_base_for(cwd: pathlib.Path) -> Optional[str]:
    try:
        config = json.loads((cwd / ".claude" / "orcha.json").read_text())
        return (config.get("api_base_url") or "").rstrip("/") or None
    except (OSError, ValueError):
        return None


def daemon_running(cwd: pathlib.Path, *, services) -> Optional[int]:
    """Return the HEALTHY local daemon PID, clearing (and killing) stale claims.

    A pid that is alive by identity but unhealthy by heartbeat is a WEDGED
    daemon: terminate it before clearing the claim, or `--ensure` would spawn a
    duplicate beside it and the slot would never actually free."""
    path = services._pid_path(cwd)
    if not path.exists():
        return None
    try:
        pid = int(path.read_text().strip())
    except (ValueError, OSError):
        return None
    cid = services._container_id_for(cwd)
    if services._daemon_pid_healthy(pid, cid, cwd):
        return pid
    if services._daemon_pid_live(pid, cid):
        services._terminate_and_wait(pid, cid)
    try:
        path.unlink()
    except OSError:
        pass
    return None


def global_pid_path(container_id: str) -> pathlib.Path:
    return pathlib.Path.home() / ".orcha" / f"notifier-{container_id}.pid"


def write_global_pid(
    container_id: str, pid: int, cwd: pathlib.Path, *, services
) -> None:
    path = services._global_pid_path(container_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{pid}\n{cwd}")
    except OSError:
        pass


def daemon_running_for_container(container_id: str, *, services) -> Optional[tuple]:
    """Return a HEALTHY container-wide claim, clearing (and killing) stale ones.

    The claim file's second line records the daemon's workspace, which is where
    its heartbeat lives — so the health check here gets the same heartbeat
    grounding as the local-pidfile path."""
    path = services._global_pid_path(container_id)
    try:
        lines = path.read_text().splitlines()
        pid = int(lines[0].strip())
    except (OSError, ValueError, IndexError):
        return None
    ws = lines[1].strip() if len(lines) > 1 else ""
    hb_cwd = pathlib.Path(ws) if ws else None
    if not services._daemon_pid_healthy(pid, container_id, hb_cwd):
        if services._daemon_pid_live(pid, container_id):
            services._terminate_and_wait(pid, container_id)
        try:
            path.unlink()
        except OSError:
            pass
        return None
    return pid, ws


def claim_container(container_id: str, *, services):
    """Atomically claim a container before spawning its singleton daemon."""
    path = services._global_pid_path(container_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        return False, None
    for _ in range(3):
        try:
            fd = services.os.open(
                str(path),
                services.os.O_CREAT | services.os.O_EXCL | services.os.O_WRONLY,
            )
        except FileExistsError:
            holder = services.daemon_running_for_container(container_id)
            if holder:
                return False, holder
            try:
                raw = path.read_text().strip()
            except OSError:
                continue
            try:
                stale = not services._daemon_pid_live(
                    int(raw.splitlines()[0]), container_id
                )
            except (ValueError, IndexError):
                try:
                    stale = (services.time.time() - path.stat().st_mtime) >= 10.0
                except OSError:
                    continue
            if not stale:
                return False, (0, "")
            try:
                path.unlink()
            except (FileNotFoundError, OSError):
                pass
        except OSError:
            return False, None
        else:
            try:
                services.os.write(fd, f"{services.os.getpid()}\n".encode())
            finally:
                services.os.close(fd)
            return True, None
    return False, (0, "")
