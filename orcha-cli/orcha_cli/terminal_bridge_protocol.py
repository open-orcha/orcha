"""Build live-terminal environments and encode its small JSON frame protocol."""

import fcntl
import json
import os
import struct
import termios


def build_spawn_env(
    alias,
    cold,
    session_id=None,
    base_env=None,
    model=None,
    runtime=None,
    run_token=None,
):
    """Return the environment consumed by ``orcha use`` inside a live PTY."""
    env = dict(os.environ if base_env is None else base_env)
    env["ORCHA_ALIAS"] = alias
    env["ORCHA_LIVE"] = "1"
    _set_optional(env, "ORCHA_RUN_TOKEN", run_token)
    env["ORCHA_LIVE_COLD"] = "1" if cold else "0"
    _set_optional(
        env,
        "ORCHA_LIVE_RESUME_SID",
        session_id if not cold else None,
    )
    _set_optional(env, "ORCHA_LIVE_MODEL", model)
    _set_optional(env, "ORCHA_LIVE_RUNTIME", runtime)
    return env


def _set_optional(env, name, value):
    if value:
        env[name] = str(value)
    else:
        env.pop(name, None)


def make_frame(frame_type, **fields):
    """Encode a server-to-client terminal frame."""
    return json.dumps({"type": frame_type, **fields})


def parse_frame(raw):
    """Decode a client frame, returning ``None`` for malformed input."""
    try:
        frame = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return frame if isinstance(frame, dict) and "type" in frame else None


def set_winsize(master_fd, cols, rows):
    """Apply a bounded xterm size to a PTY, returning whether it succeeded."""
    try:
        cols = max(1, min(int(cols), 10_000))
        rows = max(1, min(int(rows), 10_000))
        packed = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, packed)
        return True
    except (OSError, ValueError, TypeError):
        return False
