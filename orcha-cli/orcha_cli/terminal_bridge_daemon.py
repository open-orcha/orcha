"""Start, stop, and inspect the per-project terminal bridge daemon process."""

import os
import shutil
import subprocess
import sys


def bridge_pid_path(cwd):
    return cwd / ".claude" / ".orcha-terminal-bridge.pid"


def bridge_running(cwd):
    """Return the running bridge PID, or ``None`` for an absent/stale file."""
    try:
        pid = int(bridge_pid_path(cwd).read_text().strip())
    except (OSError, ValueError):
        return None
    try:
        os.kill(pid, 0)
        return pid
    except OSError:
        return None


def stop_bridge(bridge, cwd, quiet=False):
    """Stop this project's bridge and remove its PID file."""
    pid = bridge.bridge_running(cwd)
    pid_file = bridge._bridge_pid_path(cwd)
    if not pid:
        if pid_file.exists():
            try:
                pid_file.unlink()
            except OSError:
                pass
        return False
    try:
        os.kill(pid, __import__("signal").SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        pid_file.unlink()
    except (FileNotFoundError, OSError):
        pass
    if not quiet:
        print(f"[terminal-bridge] stopped (pid {pid})")
    return True


def ensure_bridge(bridge, cwd, quiet=False, restart=False):
    """Start the detached bridge once for an initialized, unmanaged project."""
    if not (cwd / ".claude" / "orcha.json").exists():
        return False
    if os.environ.get("ORCHA_HEADLESS_WORKER") or os.environ.get("ORCHA_LIVE"):
        return False
    if restart:
        bridge.stop_bridge(cwd, quiet=True)
    pid = bridge.bridge_running(cwd)
    if pid:
        if not quiet:
            print(f"[terminal-bridge] already running (pid {pid})")
        return True

    executable = shutil.which("orcha")
    argv = (
        [executable, "terminal-bridge", "--quiet"]
        if executable
        else [
            sys.executable,
            "-m",
            "orcha_cli",
            "terminal-bridge",
            "--quiet",
        ]
    )
    log = cwd / ".claude" / ".orcha-terminal-bridge.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(log, "ab") as log_file:
            process = subprocess.Popen(
                argv,
                cwd=str(cwd),
                stdout=log_file,
                stderr=log_file,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
    except (OSError, subprocess.SubprocessError) as exc:
        if not quiet:
            print(f"[terminal-bridge] could not start: {exc}", file=sys.stderr)
        return False
    bridge._bridge_pid_path(cwd).write_text(str(process.pid))
    if not quiet:
        print(f"[terminal-bridge] started (pid {process.pid}); log: {log}")
    return True
