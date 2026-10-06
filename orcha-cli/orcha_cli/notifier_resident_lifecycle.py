"""Close warm residents and launch isolated inbox-drain sidecars."""

from __future__ import annotations

import pathlib
import sys
import time
from typing import Optional

from .notifier_routing_handoff import (
    capture_stopped_checkout_diff,
    record_stopped_checkout_snapshot,
    stopped_snapshot_requires_retry,
)


def _compat():
    return sys.modules["orcha_cli.notifier"]


def _ensure_idle_snapshot_run(api_base: str, resident: dict, compat) -> bool:
    """Give a stopped, idle shared-checkout resident a durable snapshot row."""
    activity = resident.get("checkout_activity")
    if activity is None or resident.get("current_run_id"):
        return True
    run_id = resident.get("snapshot_run_id_pending")
    if not run_id:
        try:
            run = compat._post_json(
                f"{api_base}/api/agents/{resident['agent_id']}/runs",
                {
                    "wake_kind": "resident",
                    "wake_event": "resident_checkout_snapshot",
                    "log_path": str(resident["log_path"])
                    if resident.get("log_path")
                    else None,
                    "pid": getattr(resident.get("proc"), "pid", None),
                    "conversation_id": resident.get("conversation_id"),
                    "worktree": resident.get("worktree"),
                    "branch": resident.get("branch"),
                    "base_cwd": resident.get("base_cwd"),
                    "lane": "conversation",
                    "sandbox_container_id": resident.get("sandbox_container_id"),
                },
            )
        except Exception:
            run = None
        run_id = (run or {}).get("run_id")
        if not run_id:
            resident["snapshot_retry_pending"] = "snapshot_run_registration_failed"
            return False
        resident["snapshot_run_id_pending"] = run_id
    try:
        bound = compat._bind_checkout_activity(
            activity,
            run_id=run_id,
            pid=getattr(resident.get("proc"), "pid", None),
            sandbox_container_id=resident.get("sandbox_container_id"),
        )
    except Exception:
        bound = False
    if not bound:
        resident["snapshot_retry_pending"] = "checkout_activity_bind_failed"
        return False
    resident["current_run_id"] = run_id
    resident["run_id"] = run_id
    resident.pop("snapshot_run_id_pending", None)
    return True


def _close_resident(
    api_base: str,
    resident: dict,
    reason: str = "idle",
    teardown_worktree: bool = False,
    stamp_woken: bool = True,
) -> bool:
    """Close a resident process and its lease while preserving resumable work."""
    compat = _compat()
    retry = resident.get("snapshot_retry_close")
    if isinstance(retry, dict):
        # Keep the original close semantics across retries.  A routing toggle
        # that promised to preserve its old worktree must never later inherit a
        # default teardown from a different lifecycle branch.
        reason = retry.get("reason", reason)
        teardown_worktree = bool(
            retry.get("teardown_worktree", teardown_worktree)
        )
        stamp_woken = bool(retry.get("stamp_woken", stamp_woken))

    if not resident.get("snapshot_writer_stopped"):
        process = resident.get("proc")
        try:
            if process is not None and getattr(process, "stdin", None) is not None:
                process.stdin.close()
        except OSError:
            pass
        if process is not None:
            compat._kill_worker(process, graceful=True)

        sidecar = resident.get("sidecar")
        if isinstance(sidecar, dict) and sidecar.get("proc") is not None:
            compat._kill_worker(sidecar["proc"], graceful=True)
            # I4 (resident lane): the sidecar is row-less by design AND label-exempt
            # from the orphan pass — killing its docker client here without reaping
            # would leak its sandbox container forever. No-op for host mode.
            compat._reap_sandbox_artifacts(sidecar)
            resident["sidecar"] = None
        resident["snapshot_writer_stopped"] = True
    if not _ensure_idle_snapshot_run(api_base, resident, compat):
        resident["snapshot_retry_close"] = {
            "reason": reason,
            "teardown_worktree": bool(teardown_worktree),
            "stamp_woken": bool(stamp_woken),
        }
        return False
    finished = True
    if resident.get("current_run_id"):
        snapshot = record_stopped_checkout_snapshot(
            resident,
            resident["agent_id"],
            compat,
            api_base=api_base,
        )
        if stopped_snapshot_requires_retry(snapshot):
            resident["snapshot_retry_pending"] = snapshot.code
            resident["snapshot_retry_close"] = {
                "reason": reason,
                "teardown_worktree": bool(teardown_worktree),
                "stamp_woken": bool(stamp_woken),
            }
            return False
        resident.pop("snapshot_retry_pending", None)
        resident.pop("snapshot_retry_close", None)
        finished = compat._finish_run(
            api_base,
            resident["current_run_id"],
            "exited",
            0,
            resident.get("log_path"),
            capture_stopped_checkout_diff(
                snapshot,
                resident.get("worktree") or resident.get("base_cwd"),
                compat,
            ),
        )
    # I4 (resident lane): the warm session's container is spawned without --rm by
    # design — every close path must reap it (container + per-run api-config) or
    # each retired resident leaks a container. Only after the stamp landed (or
    # with no open row at all); a failed finish leaves the exited container as
    # evidence for the container-liveness sweep to stamp + rm next tick (I5).
    if finished:
        compat._reap_sandbox_artifacts(resident)
    if teardown_worktree:
        compat._safe_teardown_worktree(
            resident.get("base_cwd"),
            resident.get("worktree"),
            resident.get("branch"),
        )
    compat._post_json(
        f"{api_base}/api/agents/{resident['agent_id']}/wake-ack",
        {
            "kind": f"resident_{reason}",
            "release_lease": True,
            "stamp_woken": stamp_woken,
            "lane": "conversation",
        },
    )
    return True


def _spawn_drain_sidecar(
    api_base: str,
    resident: dict,
    inbox: int,
    *,
    messages: Optional[list] = None,
    ack_ts=None,
    ackable_ids: Optional[list] = None,
    model: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
    dry_run: bool = False,
    quiet: bool = False,
) -> bool:
    """Launch a context-isolated worker for non-conversation resident inbox."""
    if dry_run:
        return True
    compat = _compat()
    try:
        base_cwd = resident.get("base_cwd")
        if not base_cwd or not pathlib.Path(base_cwd).is_dir():
            return False
        sidecar_cwd = resident.get("worktree") or base_cwd
        checkout_activity = resident.get("checkout_activity")
        shared_git = False
        if not resident.get("worktree"):
            checker = getattr(compat, "_is_git_repo", None)
            try:
                shared_git = bool(checker(sidecar_cwd)) if callable(checker) else False
            except (OSError, TypeError, ValueError):
                shared_git = False
        if shared_git and checkout_activity is None:
            # A row-less sidecar cannot establish its own stopped-run identity.
            # It may share the owning resident's barrier, but must never launch
            # as an untracked writer in a shared Git checkout.
            return False
        persona = compat._build_persona(api_base, resident["agent_id"])
        log_path = (
            pathlib.Path(base_cwd)
            / ".claude"
            / ".orcha-wakes"
            / (
                f"{resident.get('alias', 'agent')}-drain-"
                f"{int(time.time())}.log"
            )
        )
        prompt = compat.build_resident_sidecar_drain_prompt(
            resident.get("alias"), inbox, messages
        )
        # sandbox_sidecar (Task-5 REQUIREMENT): the sidecar registers NO worker_run
        # (locked no-lease invariant) — in sandbox mode its container must carry the
        # orcha.sidecar=1 label or the reaper's orphan pass (live managed container
        # with no open run row → stop) would kill it mid-drain.
        _side_info: dict = {}
        sent, _, process = compat.spawn_headless(
            sidecar_cwd,
            prompt,
            None,
            False,
            alias=resident.get("alias"),
            system_prompt=persona,
            model=model,
            reasoning_effort=reasoning_effort,
            runtime=compat.RUNTIME_CLAUDE,
            log_path=log_path,
            sandbox_sidecar=True,
            spawn_info=_side_info,
            checkout_activity=checkout_activity,
        )
        if not sent or process is None:
            return False
        resident["sidecar"] = {
            "proc": process,
            "log_path": log_path,
            "hard_deadline": time.time() + compat.HARD_CAP_MIN_SECS,
            "ack_ts": ack_ts,
            "ackable_ids": list(ackable_ids or []),
            # I4: the sidecar has NO run row (nothing to stamp) but its
            # sandbox container must still be reaped on completion —
            # the handle is the only place its name survives.
            "sandbox_container_id": _side_info.get("sandbox_container_id"),
            "base_cwd": base_cwd,
            "worktree": resident.get("worktree"),
            "checkout_activity": checkout_activity,
        }
        if not quiet:
            print(
                f"[notifier] resident {resident.get('alias')} idle with "
                f"{inbox} queued inbox event(s) — spawned a throwaway "
                f"drain sidecar (pid {process.pid}) in its OWN session; warm "
                "conversation + lease KEPT (#247 B3 warm-zone, no context-bleed)"
            )
        return True
    except Exception as error:
        if not quiet:
            print(
                f"[notifier] resident {resident.get('alias')} drain sidecar "
                f"spawn FAILED ({error!r}) — falling back to idle-yield "
                "(#247 B3 §8 fail-open)",
                file=sys.stderr,
            )
        return False
