"""Compatibility facade for Orcha's host-side live-terminal bridge.

Focused modules own the wire protocol, API lifecycle, PTY transport, warm-session
registry, connection orchestration, and daemon process management. This facade keeps
the established import and monkeypatch surface used by callers and tests.
"""

import os
import sys

from . import (
    notifier,
    terminal_bridge_api,
    terminal_bridge_daemon,
    terminal_bridge_protocol,
    terminal_bridge_pty,
    terminal_bridge_relay,
    terminal_bridge_warm,
)

BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORT = 8765
LIVE_LEASE_TTL_SECS = 180
LIVE_RENEW_SECS = 60
LIVE_GRACE_SECS = LIVE_LEASE_TTL_SECS
LIVE_REPLAY_CAP = 65_536
LIVE_RUN_OUTPUT_CAP = 200_000
PTY_READ_BYTES = 65_536
PTY_SELECT_TIMEOUT = 0.2
PREEMPT_RETRY_TOTAL_SECS = 20.0
PREEMPT_RETRY_INTERVAL_SECS = 1.0
CLOSE_NOW_CODE = 4001
RUNTIME_CLAUDE = "claude"

_WARM_SESSIONS = {}

build_spawn_env = terminal_bridge_protocol.build_spawn_env
make_frame = terminal_bridge_protocol.make_frame
parse_frame = terminal_bridge_protocol.parse_frame
set_winsize = terminal_bridge_protocol.set_winsize
safe_teardown_worktree = terminal_bridge_api.safe_teardown_worktree
mint_live_token = terminal_bridge_api.mint_live_token
revoke_live_token = terminal_bridge_api.revoke_live_token
claim_live_lease = terminal_bridge_api.claim_live_lease
renew_live_lease = terminal_bridge_api.renew_live_lease
release_live_lease = terminal_bridge_api.release_live_lease
start_live_run = terminal_bridge_api.start_live_run
finish_live_run = terminal_bridge_api.finish_live_run
spawn_pty = terminal_bridge_pty.spawn_pty
terminate_pty = terminal_bridge_pty.terminate_pty
_read_fd = terminal_bridge_pty.read_fd
_wait_readable = terminal_bridge_pty.wait_readable
_parse_qs = terminal_bridge_relay.parse_query
_safe_close = terminal_bridge_relay.safe_close
_safe_send = terminal_bridge_relay.safe_send
_ws_path = terminal_bridge_relay.websocket_path
_relay_impl = terminal_bridge_relay.relay
_WarmSession = terminal_bridge_warm.WarmSession


def _bridge():
    """Return this facade so extracted code observes compatibility monkeypatches."""
    return sys.modules[__name__]


def apply_client_frame(frame, master_fd):
    """Route a parsed stdin or resize frame to the PTY."""
    if not frame:
        return "ignored"
    frame_type = frame.get("type")
    if frame_type == "stdin":
        data = frame.get("data")
        if isinstance(data, str) and data:
            os.write(master_fd, data.encode("utf-8", "replace"))
            return "stdin"
        return "ignored"
    if frame_type == "resize":
        set_winsize(master_fd, frame.get("cols"), frame.get("rows"))
        return "resize"
    return "ignored"


async def acquire_live_lease(api_base, aid, preempt=False, on_yielding=None):
    """Claim a live lease, waiting briefly while an idle resident yields."""
    import asyncio

    claim = claim_live_lease(api_base, aid, preempt=preempt)
    if (claim and claim.get("claimed")) or not (
        claim and claim.get("reason") == "yield_pending"
    ):
        return claim
    if on_yielding is not None:
        await on_yielding()
    attempts = max(1, int(PREEMPT_RETRY_TOTAL_SECS / PREEMPT_RETRY_INTERVAL_SECS))
    for _ in range(attempts):
        await asyncio.sleep(PREEMPT_RETRY_INTERVAL_SECS)
        claim = claim_live_lease(api_base, aid, preempt=preempt)
        if claim and claim.get("claimed"):
            return claim
        if not (claim and claim.get("reason") == "yield_pending"):
            return claim
    return claim


def _pid_alive(pid):
    return _bridge_warm().pid_alive(pid)


def _take_warm(aid):
    return _bridge_warm().take_warm(_bridge(), aid)


def _park_warm(session, quiet=True):
    return _bridge_warm().park_warm(_bridge(), session, quiet=quiet)


async def _expire_warm(session, quiet=True):
    return await _bridge_warm().expire_warm(_bridge(), session, quiet=quiet)


def _retire_warm(session, quiet=True):
    return _bridge_warm().retire_warm(_bridge(), session, quiet=quiet)


def _retire_all_warm():
    return _bridge_warm().retire_all_warm(_bridge())


def _bridge_warm():
    return terminal_bridge_warm


async def handle_connection(ws, api_base, base_cwd, quiet=True):
    """Authorize and run one websocket-attached terminal session."""
    from .terminal_bridge_connection import handle_connection as handle

    return await handle(_bridge(), notifier, ws, api_base, base_cwd, quiet=quiet)


async def _relay(ws, master_fd, rec, run_id, api_base, aid):
    return await _relay_impl(_bridge(), ws, master_fd, rec, run_id, api_base, aid)


async def serve_bridge(
    api_base, base_cwd, host=BRIDGE_HOST, port=BRIDGE_PORT, quiet=True
):
    """Run the localhost websocket server until shutdown."""
    import asyncio

    import websockets

    async def handler(ws):
        await handle_connection(ws, api_base, base_cwd, quiet=quiet)

    async with websockets.serve(handler, host, port):
        if not quiet:
            print(f"[terminal-bridge] listening on ws://{host}:{port}/terminal")
        try:
            await asyncio.Future()
        finally:
            _retire_all_warm()


def _bridge_pid_path(cwd):
    return terminal_bridge_daemon.bridge_pid_path(cwd)


def bridge_running(cwd):
    return terminal_bridge_daemon.bridge_running(cwd)


def stop_bridge(cwd, quiet=False):
    return terminal_bridge_daemon.stop_bridge(_bridge(), cwd, quiet=quiet)


def ensure_bridge(cwd, quiet=False, restart=False):
    return terminal_bridge_daemon.ensure_bridge(
        _bridge(), cwd, quiet=quiet, restart=restart
    )
