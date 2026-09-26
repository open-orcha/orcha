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


def write_heartbeat(cwd: pathlib.Path, *, services) -> None:
    """Stamp `<pid> <epoch>` — the daemon's own proof-of-life, once per loop pass."""
    try:
        services._hb_path(cwd).write_text(
            f"{services.os.getpid()} {services.time.time()}"
        )
    except OSError:
        pass


def heartbeat_verdict(cwd: pathlib.Path, pid: int, *, services):
    """True = fresh + same pid; False = stale or another pid's; None = no file."""
    try:
        raw = services._hb_path(cwd).read_text().split()
        hb_pid, hb_ts = int(raw[0]), float(raw[1])
    except (OSError, ValueError, IndexError):
        return None
    if hb_pid != pid:
        return False
    return (services.time.time() - hb_ts) < HEARTBEAT_STALE_SECS


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
