"""Authorize websocket clients and orchestrate attached live-terminal sessions."""

from .notifier_checkout_activity import preserve_unregistered_writer
from .notifier_routing_handoff import (
    checkout_owner_key,
    prepare_checkout_start,
)
from .terminal_bridge_relay import (
    parse_query,
    safe_close,
    safe_send,
    websocket_path,
)


async def handle_connection(bridge, notifier, ws, api_base, base_cwd, quiet=True):
    """Run one authorized websocket connection, reattaching when possible."""
    params = parse_query(websocket_path(ws))
    aid = params.get("agent_id")
    actor = params.get("actor_agent_id")
    if not aid or not actor:
        await ws.send(
            bridge.make_frame("error", message="agent_id + actor_agent_id required")
        )
        await ws.close(code=4400)
        return

    actor_agent = notifier._get_json(f"{api_base}/api/agents/{actor}/persona")
    if not actor_agent or actor_agent.get("kind") != "human":
        await ws.send(
            bridge.make_frame("status", state="lease_denied", reason="actor not human")
        )
        await ws.close(code=4403)
        return
    target = notifier._get_json(f"{api_base}/api/agents/{aid}/persona")
    if not target:
        await ws.send(bridge.make_frame("error", message=f"agent {aid} not found"))
        await ws.close(code=4404)
        return

    alias = target.get("alias") or aid
    model = target.get("model")
    runtime = target.get("model_runtime") or bridge.RUNTIME_CLAUDE
    worktrees_disabled = bool(target.get("worktrees_disabled"))
    preempt = params.get("preempt") in ("1", "true", "yes")

    async def on_yielding():
        await safe_send(
            ws,
            bridge.make_frame("status", state="yielding", holder="resident"),
        )

    async def snapshot_still_pending(warm, disposition):
        pending = getattr(warm, "snapshot_retry_pending", None)
        if not pending:
            return False
        await safe_send(
            ws,
            bridge.make_frame(
                "error",
                state="snapshot_pending",
                reason=pending,
                message=(
                    "The previous terminal stopped, but Orcha could not yet "
                    "save an exact checkout snapshot. Its lease and files are "
                    "being preserved for retry."
                ),
                worktree=disposition,
            ),
        )
        await safe_close(ws)
        return True

    warm = bridge._take_warm(aid)
    routing_source_cwd = None
    if warm is not None and getattr(warm, "snapshot_retry_pending", None):
        # A stopped session awaiting a durable snapshot is not attachable, even
        # if its old PID happens to appear alive.  Retry retirement first and
        # keep its lease/registry entry on another failure.
        routing_source_cwd = warm.worktree or warm.base_cwd
        warm.cancel_expiry()
        disposition = bridge._retire_warm(warm, quiet=quiet)
        if await snapshot_still_pending(warm, disposition):
            return
        warm = None
    if (
        warm is not None
        and bool(getattr(warm, "worktrees_disabled", False)) != worktrees_disabled
    ):
        # The persisted project routing changed while this PTY was parked.  Do not reattach it in
        # the wrong checkout, and do not remove its old worktree as a side effect of the toggle.
        routing_source_cwd = warm.worktree or warm.base_cwd
        warm.cancel_expiry()
        disposition = bridge._retire_warm(
            warm, quiet=quiet, teardown_worktree=False
        )
        if await snapshot_still_pending(warm, disposition):
            return
        warm = None
    if warm is not None and warm.pty_alive():
        session = _adopt_warm(bridge, ws, warm)
        await session["connected"]
    else:
        if warm is not None:
            warm.cancel_expiry()
            disposition = bridge._retire_warm(warm, quiet=quiet)
            if await snapshot_still_pending(warm, disposition):
                return
        session = await _start_session(
            bridge,
            notifier,
            ws,
            api_base,
            base_cwd,
            aid,
            alias,
            model,
            runtime,
            worktrees_disabled,
            preempt,
            on_yielding,
            routing_source_cwd,
            container_id=target.get("container_id"),
        )
        if session is None:
            return

    relay_alive = await bridge._relay(
        ws,
        session["master_fd"],
        session["rec"],
        session["run_id"],
        api_base,
        aid,
    )
    await _detach_or_retire(
        bridge,
        ws,
        api_base,
        base_cwd,
        aid,
        alias,
        session,
        relay_alive,
        quiet,
    )


def _adopt_warm(bridge, ws, warm):
    """Prepare a parked session for websocket reattachment."""
    warm.cancel_expiry()

    async def connected():
        await ws.send(
            bridge.make_frame(
                "status",
                state="connected",
                worktree=bool(warm.worktree),
                cold=False,
                reattached=True,
            )
        )
        tail = "".join(warm.rec["chunks"])[-bridge.LIVE_REPLAY_CAP :]
        if tail:
            await safe_send(ws, bridge.make_frame("stdout", data=tail))

    return {
        "pid": warm.pid,
        "master_fd": warm.master_fd,
        "worktree": warm.worktree,
        "branch": warm.branch,
        "run_id": warm.run_id,
        "rec": warm.rec,
        "run_token": warm.run_token,
        "checkout_activity": getattr(warm, "checkout_activity", None),
        "worktrees_disabled": bool(getattr(warm, "worktrees_disabled", False)),
        "connected": connected(),
    }


async def _start_session(
    bridge,
    notifier,
    ws,
    api_base,
    base_cwd,
    aid,
    alias,
    model,
    runtime,
    worktrees_disabled,
    preempt,
    on_yielding,
    routing_source_cwd=None,
    container_id=None,
):
    """Claim resources and start a new PTY-backed live session."""
    claim = await bridge.acquire_live_lease(
        api_base, aid, preempt=preempt, on_yielding=on_yielding
    )
    if not (claim and claim.get("claimed")):
        await ws.send(
            bridge.make_frame(
                "status",
                state="lease_denied",
                holder=(claim or {}).get("lease_kind"),
                reason=(claim or {}).get("reason", "embodiment busy"),
            )
        )
        await ws.close(code=4409)
        return None

    cold = bool(claim.get("cold", True))
    worktree, branch = (
        (None, None)
        if worktrees_disabled
        else notifier._provision_live_worktree(base_cwd, alias)
    )
    run_cwd = worktree or base_cwd
    git_checker = getattr(notifier, "_is_git_repo", None)
    shared_git_checkout = False
    if worktree is None and callable(git_checker):
        try:
            shared_git_checkout = bool(git_checker(run_cwd))
        except (OSError, TypeError, ValueError):
            shared_git_checkout = False
    preparation = prepare_checkout_start(
        api_base,
        aid,
        run_cwd,
        notifier,
        shared_checkout=shared_git_checkout,
        source_cwd=routing_source_cwd,
        wake_kind="live",
        container_id=container_id,
    )
    handoff = preparation.handoff
    checkout_activity = preparation.activity
    if not handoff:
        bridge.release_live_lease(api_base, aid)
        await ws.send(
            bridge.make_frame(
                "error",
                message=getattr(
                    handoff,
                    "guidance",
                    "Could not safely carry the saved files into the selected checkout. Both checkouts were preserved.",
                ),
                reason=getattr(handoff, "code", "handoff_failed"),
            )
        )
        await ws.close(code=1011)
        return None
    run_token = bridge.mint_live_token(api_base, aid)
    pid, master_fd = bridge.spawn_pty(
        alias,
        cold,
        claim.get("session_id"),
        run_cwd,
        model=model,
        runtime=runtime,
        run_token=run_token,
        checkout_activity=checkout_activity,
    )
    if checkout_activity is not None:
        try:
            activity_bound = notifier._bind_checkout_activity(
                checkout_activity, pid=pid
            )
        except Exception:
            activity_bound = False
        if not activity_bound:
            bridge.terminate_pty(pid, master_fd)
            preserve_unregistered_writer(
                api_base,
                notifier,
                cwd=run_cwd,
                owner_key=checkout_owner_key(aid, wake_kind="live"),
                agent_id=aid,
                activity=checkout_activity,
                identity=run_token or pid,
            )
            bridge.revoke_live_token(api_base, run_token)
            bridge.release_live_lease(api_base, aid)
            await ws.send(
                bridge.make_frame(
                    "error",
                    message=(
                        "The terminal process was stopped because Orcha could not "
                        "bind its checkout safety record. Its files remain preserved."
                    ),
                    reason="checkout_activity_bind_failed",
                )
            )
            await ws.close(code=1011)
            return None
    run_id = bridge.start_live_run(
        api_base,
        aid,
        pid=pid,
        token_id=run_token,
        worktree=worktree,
        branch=branch,
        base_cwd=base_cwd,
    )
    if run_token and run_id is None:
        bridge.revoke_live_token(api_base, run_token)
        run_token = None
    if run_id is None:
        bridge.terminate_pty(pid, master_fd)
        if checkout_activity is not None:
            preserve_unregistered_writer(
                api_base,
                notifier,
                cwd=run_cwd,
                owner_key=checkout_owner_key(aid, wake_kind="live"),
                agent_id=aid,
                activity=checkout_activity,
                identity=pid,
            )
        bridge.release_live_lease(api_base, aid)
        await ws.send(
            bridge.make_frame(
                "error",
                message=(
                    "The terminal was stopped because Orcha could not create its "
                    "durable run record. Any files it created remain preserved."
                ),
                reason="live_run_registration_failed",
            )
        )
        await ws.close(code=1011)
        return None
    if checkout_activity is not None:
        try:
            activity_bound = notifier._bind_checkout_activity(
                checkout_activity, run_id=run_id, pid=pid
            )
        except Exception:
            activity_bound = False
        if not activity_bound:
            bridge.terminate_pty(pid, master_fd)
            warm = bridge._WarmSession(
                aid,
                alias,
                api_base,
                base_cwd,
                pid,
                master_fd,
                worktree,
                branch,
                run_id,
                {"chunks": [], "len": 0},
                run_token=run_token,
                worktrees_disabled=worktrees_disabled,
                checkout_activity=checkout_activity,
            )
            warm._pty_stopped = True
            bridge._retire_warm(warm, quiet=True, teardown_worktree=False)
            await ws.send(
                bridge.make_frame(
                    "error",
                    message=(
                        "The terminal was stopped because its durable checkout "
                        "identity could not be completed. Its files remain preserved."
                    ),
                    reason="checkout_activity_run_bind_failed",
                )
            )
            await ws.close(code=1011)
            return None
    rec = {"chunks": [], "len": 0}
    await ws.send(
        bridge.make_frame(
            "status", state="connected", worktree=bool(worktree), cold=cold
        )
    )
    return {
        "pid": pid,
        "master_fd": master_fd,
        "worktree": worktree,
        "branch": branch,
        "run_id": run_id,
        "rec": rec,
        "run_token": run_token,
        "checkout_activity": checkout_activity,
        "worktrees_disabled": worktrees_disabled,
    }


async def _detach_or_retire(
    bridge,
    ws,
    api_base,
    base_cwd,
    aid,
    alias,
    session,
    relay_alive,
    quiet,
):
    """Park a live PTY after a drop, or retire it after exit/explicit close."""
    user_closed = getattr(ws, "close_code", None) == bridge.CLOSE_NOW_CODE
    alive = relay_alive and bridge._pid_alive(session["pid"])
    warm = bridge._WarmSession(
        aid,
        alias,
        api_base,
        base_cwd,
        session["pid"],
        session["master_fd"],
        session["worktree"],
        session["branch"],
        session["run_id"],
        session["rec"],
        run_token=session["run_token"],
        worktrees_disabled=session.get("worktrees_disabled", False),
        checkout_activity=session.get("checkout_activity"),
    )
    if alive and not user_closed:
        bridge._park_warm(warm, quiet=quiet)
        await safe_send(
            ws,
            bridge.make_frame(
                "status", state="detached", grace_secs=bridge.LIVE_GRACE_SECS
            ),
        )
        await safe_close(ws)
        if not quiet:
            print(
                f"[terminal-bridge] session parked warm for {alias} "
                f"({bridge.LIVE_GRACE_SECS}s grace)"
            )
        return

    await safe_send(ws, bridge.make_frame("status", state="snapshotting"))
    disposition = bridge._retire_warm(warm, quiet=quiet)
    pending = getattr(warm, "snapshot_retry_pending", None)
    await safe_send(
        ws,
        bridge.make_frame(
            "status",
            state="snapshot_pending" if pending else "closed",
            reason=pending,
            worktree=disposition,
        ),
    )
    await safe_close(ws)
    if not quiet:
        print(f"[terminal-bridge] session closed for {alias} (worktree {disposition})")
