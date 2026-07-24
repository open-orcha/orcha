"""Manage notifier process capabilities, terminal run records, and dead resident runs."""

from __future__ import annotations

import os
from typing import Callable, Optional


def mint_token(api_base: str, aid: str, lane: str, kind: str, *, post_json) -> Optional[str]:
    """Mint a process-scoped token, failing soft so transport startup can continue."""
    try:
        response = post_json(
            f"{api_base}/api/agents/{aid}/embodiment-tokens",
            {"lane": lane, "kind": kind},
        )
    except Exception:
        response = None
    token = (
        (response or {}).get("run_token")
        or (response or {}).get("token")
        or (response or {}).get("token_id")
    )
    if token:
        return token
    try:
        print(
            f"[notifier] embodiment mint FAILED aid={aid} lane={lane} kind={kind} "
            "— spawning token-less",
            flush=True,
        )
    except Exception:
        pass
    return None


def revoke_token(api_base: str, token: Optional[str], *, post_json) -> bool:
    """Best-effort, idempotent token revocation."""
    if not token:
        return True
    try:
        response = post_json(f"{api_base}/api/embodiment-tokens/{token}/revoke", {})
    except Exception:
        response = None
    return response is not None


def finish_run(
    api_base: str,
    run_id,
    status: str,
    exit_code,
    log_path,
    *,
    post_json,
    capture_output,
    usage_from_log,
    diff=None,
    kill_reason=None,
) -> None:
    """Persist a run's terminal output, diff, diagnostic, and token usage."""
    if not run_id:
        return
    post_json(
        f"{api_base}/api/runs/{run_id}/finish",
        {
            "status": status,
            "exit_code": exit_code,
            "output": capture_output(log_path),
            "diff": diff,
            "kill_reason": kill_reason,
            **usage_from_log(log_path),
        },
    )


def run_pid_alive(pid) -> bool:
    """Return whether a host process exists, treating unknown PIDs as dead."""
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, ValueError, TypeError):
        return False


def reap_dead_resident_runs(
    api_base: str,
    aid: str,
    live_pids=frozenset(),
    *,
    get_json,
    post_json,
    finish_run: Callable,
    pid_alive: Callable,
    quiet: bool = True,
) -> int:
    """Reconcile dead resident run rows without disturbing a live sibling's lease."""
    data = get_json(f"{api_base}/api/agents/{aid}/resident-runs?status=running") or {}
    runs = data.get("runs", [])
    if not runs:
        return 0

    def alive(run):
        pid = run.get("pid")
        return pid in live_pids or pid_alive(pid)

    dead = [run for run in runs if not alive(run)]
    if not dead:
        return 0
    live_sibling = any(alive(run) for run in runs)
    if live_sibling:
        for run in dead:
            finish_run(api_base, run.get("run_id"), "killed", -1, None)
    else:
        post_json(
            f"{api_base}/api/agents/{aid}/wake-ack",
            {"kind": "resident_dead_pid", "release_lease": True, "lane": "conversation"},
        )
    if not quiet:
        disposition = "kept lease (live sibling)" if live_sibling else "released lease"
        print(f"[notifier] reaped {len(dead)} dead-pid resident run(s) for {aid} ({disposition})")
    return len(dead)
