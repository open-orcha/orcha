"""Keep live PTYs warm across short websocket disconnects and retire them safely."""

import asyncio
import os

from .notifier_routing_handoff import (
    record_stopped_checkout_snapshot,
    stopped_snapshot_requires_retry,
)


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
        worktrees_disabled=False,
        checkout_activity=None,
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
        self.worktrees_disabled = bool(worktrees_disabled)
        self.checkout_activity = checkout_activity
        self._expiry_task = None
        self.snapshot_retry_pending = None
        self._retire_teardown_worktree = None
        self._pty_stopped = False

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
    if bridge._WARM_SESSIONS.get(aid) is session:
        bridge._retire_warm(session, quiet=quiet)


async def _retry_snapshot(bridge, session, quiet):
    """Keep the lease alive and retry a failed stopped-checkout snapshot."""
    try:
        await asyncio.sleep(bridge.LIVE_RENEW_SECS)
        if bridge._WARM_SESSIONS.get(session.aid) is not session:
            return
        bridge.renew_live_lease(session.api_base, session.aid)
        bridge._retire_warm(
            session,
            quiet=quiet,
            teardown_worktree=bool(session._retire_teardown_worktree),
        )
    except asyncio.CancelledError:
        return


def _retain_snapshot_retry(bridge, session, quiet):
    """Retain one stopped session as the sole owner until its snapshot succeeds."""
    current = bridge._WARM_SESSIONS.get(session.aid)
    if current is not None and current is not session:
        # A live lease should make this impossible.  Never overwrite a different
        # in-memory owner merely to make the retry convenient.
        return
    bridge._WARM_SESSIONS[session.aid] = session
    previous = session._expiry_task
    try:
        active = asyncio.current_task()
    except RuntimeError:
        active = None
    if previous is not None and previous is not active:
        previous.cancel()
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        session._expiry_task = None
        return
    session._expiry_task = loop.create_task(
        _retry_snapshot(bridge, session, quiet)
    )


def retire_warm(bridge, session, quiet=True, teardown_worktree=True):
    """Terminate a session and release every resource it owns."""
    disposition = None
    snapshot_ready = True
    if session._retire_teardown_worktree is None:
        # Preserve the first retirement intent across retries.  In particular,
        # a routing-toggle retry must never turn into worktree teardown.
        session._retire_teardown_worktree = bool(teardown_worktree)
    teardown_worktree = bool(session._retire_teardown_worktree)
    try:
        if not session._pty_stopped:
            try:
                bridge.terminate_pty(session.pid, session.master_fd)
                session._pty_stopped = True
            except Exception:  # noqa: BLE001 - a live writer cannot be snapshotted
                snapshot_ready = False
                session.snapshot_retry_pending = "pty_stop_failed"
                disposition = "snapshot-pending:pty_stop_failed"
                _retain_snapshot_retry(bridge, session, quiet)
        notifier = getattr(bridge, "notifier", None)
        if snapshot_ready and notifier is not None:
            try:
                snapshot = record_stopped_checkout_snapshot(
                    {
                        "base_cwd": session.base_cwd,
                        "worktree": session.worktree,
                        "run_id": session.run_id,
                        "wake_kind": "live",
                        "lane": "live",
                        "checkout_activity": session.checkout_activity,
                    },
                    session.aid,
                    notifier,
                    api_base=session.api_base,
                )
            except Exception:  # noqa: BLE001 - fail closed and retry in memory
                snapshot = None
                snapshot_ready = False
                session.snapshot_retry_pending = "snapshot_exception"
            if stopped_snapshot_requires_retry(snapshot):
                snapshot_ready = False
                session.snapshot_retry_pending = snapshot.code
            if not snapshot_ready:
                disposition = (
                    "snapshot-pending:"
                    f"{session.snapshot_retry_pending}"
                )
                _retain_snapshot_retry(bridge, session, quiet)
        if snapshot_ready and teardown_worktree:
            disposition = bridge.safe_teardown_worktree(
                session.base_cwd, session.worktree, session.branch
            )
        elif snapshot_ready and session.worktree:
            # A project routing toggle may retire an old warm process, but must never clean up the
            # worktree it used.  Leave it available for explicit human inspection/removal.
            disposition = "preserved-routing-change"
        elif snapshot_ready:
            disposition = "noop"
    finally:
        if snapshot_ready:
            session.snapshot_retry_pending = None
            if bridge._WARM_SESSIONS.get(session.aid) is session:
                bridge._WARM_SESSIONS.pop(session.aid, None)
            retry_task = session._expiry_task
            try:
                active = asyncio.current_task()
            except RuntimeError:
                active = None
            if retry_task is not None and retry_task is not active:
                retry_task.cancel()
            session._expiry_task = None
            bridge.release_live_lease(session.api_base, session.aid)
            bridge.finish_live_run(
                session.api_base,
                session.run_id,
                "exited",
                output="".join(session.rec["chunks"]),
            )
            bridge.revoke_live_token(
                session.api_base, getattr(session, "run_token", None)
            )
    if not quiet:
        print(
            f"[terminal-bridge] warm session retired for {session.alias} "
            f"(worktree {disposition})"
        )
    return disposition


def retire_all_warm(bridge):
    """Best-effort retirement for every session during bridge shutdown."""
    for aid in list(bridge._WARM_SESSIONS):
        session = bridge._WARM_SESSIONS.get(aid)
        if session is None:
            continue
        session.cancel_expiry()
        try:
            bridge._retire_warm(session)
        except Exception:  # noqa: BLE001, S110 - shutdown is best-effort
            pass
