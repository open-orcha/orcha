"""Authorize websocket clients and orchestrate attached live-terminal sessions."""

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
    preempt = params.get("preempt") in ("1", "true", "yes")

    async def on_yielding():
        await safe_send(
            ws,
            bridge.make_frame("status", state="yielding", holder="resident"),
        )

    warm = bridge._take_warm(aid)
    if warm is not None and warm.pty_alive():
        session = _adopt_warm(bridge, ws, warm)
        await session["connected"]
    else:
        if warm is not None:
            warm.cancel_expiry()
            bridge._retire_warm(warm, quiet=quiet)
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
            preempt,
            on_yielding,
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
    preempt,
    on_yielding,
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
    worktree, branch = notifier._provision_live_worktree(base_cwd, alias)
    run_token = bridge.mint_live_token(api_base, aid)
    pid, master_fd = bridge.spawn_pty(
        alias,
        cold,
        claim.get("session_id"),
        worktree or base_cwd,
        model=model,
        runtime=runtime,
        run_token=run_token,
    )
    run_id = bridge.start_live_run(api_base, aid, pid=pid, token_id=run_token)
    if run_token and run_id is None:
        bridge.revoke_live_token(api_base, run_token)
        run_token = None
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
    await safe_send(
        ws,
        bridge.make_frame("status", state="closed", worktree=disposition),
    )
    await safe_close(ws)
    if not quiet:
        print(f"[terminal-bridge] session closed for {alias} (worktree {disposition})")
