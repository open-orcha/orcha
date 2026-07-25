"""Close warm residents and launch isolated inbox-drain sidecars."""

from __future__ import annotations

import pathlib
import sys
import time
from typing import Optional


def _compat():
    return sys.modules["orcha_cli.notifier"]


def _close_resident(
    api_base: str,
    resident: dict,
    reason: str = "idle",
    teardown_worktree: bool = False,
    stamp_woken: bool = True,
) -> None:
    """Close a resident process and its lease while preserving resumable work."""
    compat = _compat()
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
        resident["sidecar"] = None
    if resident.get("current_run_id"):
        compat._finish_run(
            api_base,
            resident["current_run_id"],
            "exited",
            0,
            resident.get("log_path"),
        )
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
        sent, _, process = compat.spawn_headless(
            base_cwd,
            prompt,
            None,
            False,
            alias=resident.get("alias"),
            system_prompt=persona,
            model=model,
            reasoning_effort=reasoning_effort,
            runtime=compat.RUNTIME_CLAUDE,
            log_path=log_path,
        )
        if not sent or process is None:
            return False
        resident["sidecar"] = {
            "proc": process,
            "log_path": log_path,
            "hard_deadline": time.time() + compat.HARD_CAP_MIN_SECS,
            "ack_ts": ack_ts,
            "ackable_ids": list(ackable_ids or []),
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
