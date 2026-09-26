"""Keep live PTYs warm across short websocket disconnects and retire them safely."""

import asyncio
import os


class WarmSession:
    """State owned by a live PTY while it is detached from a websocket."""

    def __init__(
        self,
        aid,
        alias,
        api_base,
        base_cwd,
        pid,
        master_fd,
        worktree,
        branch,
        run_id,
        rec,
        run_token=None,
    ):
        self.aid = aid
        self.alias = alias
        self.api_base = api_base
        self.base_cwd = base_cwd
        self.pid = pid
        self.master_fd = master_fd
        self.worktree = worktree
        self.branch = branch
        self.run_id = run_id
        self.rec = rec
        self.run_token = run_token
        self._expiry_task = None

    def pty_alive(self):
        return pid_alive(self.pid)

    def cancel_expiry(self):
        if self._expiry_task is not None:
            self._expiry_task.cancel()
            self._expiry_task = None


def pid_alive(pid):
    """Return whether a PTY child process still exists."""
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def take_warm(bridge, aid):
    """Atomically adopt a parked session, if one exists."""
    return bridge._WARM_SESSIONS.pop(aid, None)


def park_warm(bridge, session, quiet=True):
    """Park a live session and schedule retirement after the grace window."""
    bridge._WARM_SESSIONS[session.aid] = session
    session._expiry_task = asyncio.ensure_future(
        bridge._expire_warm(session, quiet=quiet)
    )


async def expire_warm(bridge, session, quiet=True):
    """Renew a parked session's lease until adoption or grace expiry."""
    aid = session.aid
    try:
        elapsed = 0
        while elapsed < bridge.LIVE_GRACE_SECS:
            delay = min(bridge.LIVE_RENEW_SECS, bridge.LIVE_GRACE_SECS - elapsed)
            await asyncio.sleep(delay)
            elapsed += bridge.LIVE_RENEW_SECS
            if bridge._WARM_SESSIONS.get(aid) is not session:
                return
            bridge.renew_live_lease(session.api_base, aid)
    except asyncio.CancelledError:
        return
    if bridge._WARM_SESSIONS.pop(aid, None) is session:
        bridge._retire_warm(session, quiet=quiet)


def retire_warm(bridge, session, quiet=True):
    """Terminate a session and release every resource it owns."""
    disposition = None
    try:
        bridge.terminate_pty(session.pid, session.master_fd)
        disposition = bridge.safe_teardown_worktree(
            session.base_cwd, session.worktree, session.branch
        )
    finally:
        bridge.release_live_lease(session.api_base, session.aid)
        bridge.finish_live_run(
            session.api_base,
            session.run_id,
            "exited",
            output="".join(session.rec["chunks"]),
        )
        bridge.revoke_live_token(session.api_base, getattr(session, "run_token", None))
    if not quiet:
        print(
            f"[terminal-bridge] warm session retired for {session.alias} "
            f"(worktree {disposition})"
        )
    return disposition


def retire_all_warm(bridge):
    """Best-effort retirement for every session during bridge shutdown."""
    for aid in list(bridge._WARM_SESSIONS):
        session = bridge._WARM_SESSIONS.pop(aid, None)
        if session is None:
            continue
        session.cancel_expiry()
        try:
            bridge._retire_warm(session)
        except Exception:  # noqa: BLE001, S110 - shutdown is best-effort
            pass
