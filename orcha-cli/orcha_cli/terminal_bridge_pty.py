"""Spawn, resize, read, and terminate the live terminal's host PTY."""

import os
import pty
import signal
import time

from .terminal_bridge_protocol import build_spawn_env

PTY_READ_BYTES = 65_536
PTY_SELECT_TIMEOUT = 0.2


def spawn_pty(
    alias,
    cold,
    session_id,
    cwd,
    base_env=None,
    model=None,
    runtime=None,
    run_token=None,
):
    """Fork ``orcha use <alias>`` into a new PTY session."""
    env = build_spawn_env(
        alias,
        cold,
        session_id,
        base_env=base_env,
        model=model,
        runtime=runtime,
        run_token=run_token,
    )
    pid, master_fd = pty.fork()
    if pid == 0:
        try:
            if cwd:
                os.chdir(cwd)
            os.execvpe("orcha", ["orcha", "use", alias], env)
        except Exception as exc:  # noqa: BLE001  # pragma: no cover
            os.write(2, f"orcha terminal bridge: exec failed: {exc}\n".encode())
            os._exit(127)
    return pid, master_fd


def terminate_pty(pid, master_fd, grace=5.0):
    """Signal the PTY session, then force-stop it after a short grace period."""
    for sig in (signal.SIGHUP, signal.SIGTERM):
        try:
            os.killpg(os.getpgid(pid), sig)
        except (ProcessLookupError, PermissionError, OSError):
            break
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done:
                break
        except ChildProcessError:
            break
        time.sleep(0.1)
    else:
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    try:
        os.close(master_fd)
    except OSError:
        pass


def read_fd(fd):
    """Read a PTY chunk, treating descriptor failure as EOF."""
    try:
        return os.read(fd, PTY_READ_BYTES)
    except OSError:
        return b""


def wait_readable(fd, timeout=PTY_SELECT_TIMEOUT):
    """Wait briefly for PTY data so a parked reader can stop promptly."""
    import select

    try:
        readable, _, _ = select.select([fd], [], [], timeout)
        return bool(readable)
    except (OSError, ValueError):
        return False
