"""Track notifier daemon ownership with local and container-wide PID claims."""

from __future__ import annotations

import json
import pathlib
from typing import Optional


def pid_path(cwd: pathlib.Path) -> pathlib.Path:
    return cwd / ".claude" / ".orcha-notifier.pid"


def log_path(cwd: pathlib.Path) -> pathlib.Path:
    return cwd / ".claude" / ".orcha-notifier.log"


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
    """Reject zombies, reused PIDs, and daemons bound to another container."""
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
    """Return the live local daemon PID and remove stale local claims."""
    path = services._pid_path(cwd)
    if not path.exists():
        return None
    try:
        pid = int(path.read_text().strip())
    except (ValueError, OSError):
        return None
    if services._daemon_pid_live(pid, services._container_id_for(cwd)):
        return pid
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
    """Return a live container-wide claim and remove stale global claims."""
    path = services._global_pid_path(container_id)
    try:
        lines = path.read_text().splitlines()
        pid = int(lines[0].strip())
    except (OSError, ValueError, IndexError):
        return None
    if not services._daemon_pid_live(pid, container_id):
        try:
            path.unlink()
        except OSError:
            pass
        return None
    return pid, (lines[1].strip() if len(lines) > 1 else "")


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
