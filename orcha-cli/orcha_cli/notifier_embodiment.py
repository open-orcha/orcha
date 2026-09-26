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
) -> bool:
    """Persist a run's terminal output, diff, diagnostic, and token usage.

    Returns True iff the finish POST actually landed (I5: the sandbox reaper must
    only `docker rm` a container AFTER its stamp is durably recorded — a failed
    POST keeps the exited container as evidence and retries next sweep)."""
    if not run_id:
        return False
    res = post_json(
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
    return res is not None


def reap_sandbox_artifacts(rec: dict, *, sandbox_mod) -> None:
    """I4 (Task-5 review): a COMPLETED sandbox wake's container is NOT auto-removed
    (`docker run` without --rm by design — the reaper owns removal AFTER stamping),
    so every Popen-completion path must reap the container + its per-run api-config
    or each finished wake leaks an exited container. `rec` is any in-memory record
    that carries sandbox_container_id (+ worktree/base_cwd): a live_workers entry,
    a Codex conversation resident, or a drain-sidecar handle. No-op for host wakes;
    never raises. Call ONLY after the run's stamp landed (or when there is no run
    row at all, e.g. the sidecar) — see finish_run's return contract."""
    sbx = rec.get("sandbox_container_id")
    if not sbx:
        return
    try:
        # force=True (`docker rm -f`, never -v — volumes are durable state): the
        # kill paths reach here with a container that may still be RUNNING (the
        # SIGKILL escalation kills only the docker CLIENT). For a hard-capped
        # drain sidecar that is fatal with plain rm: row-less + orphan-exempt,
        # so nothing else would EVER stop it — an immortal running container.
        # Every caller is post-stamp (or row-less by design), so nothing worth
        # preserving lives in the container itself.
        sandbox_mod.remove(sbx, force=True)
        cwd = rec.get("worktree") or rec.get("base_cwd")
        if cwd:
            sandbox_mod.remove_api_config(cwd, sbx)
    except Exception:
        pass                                   # cleanup must never take down a reap path


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
    # Resident-lane sandbox (remote-runner §3.3c): a row with a sandbox_container_id
    # is CONTAINER-backed — its docker-client pid dies with a daemon restart while
    # the container (and its stamp-worthy exit state) lives on. Leave those rows to
    # the container-liveness sweep (reap_orphaned_runs), and shield the lane's lease
    # from this pid-keyed release while any such row is open.
    sandbox_rows = [run for run in runs if run.get("sandbox_container_id")]
    runs = [run for run in runs if not run.get("sandbox_container_id")]

    def alive(run):
        pid = run.get("pid")
        return pid in live_pids or pid_alive(pid)

    dead = [run for run in runs if not alive(run)]
    if not dead:
        return 0
    live_sibling = any(alive(run) for run in runs) or bool(sandbox_rows)
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
