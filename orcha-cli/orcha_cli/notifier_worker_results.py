"""Classify worker exits and derive retry delays from Codex event logs."""

from __future__ import annotations

import json
import os
import re


def codex_tail_is_rate_limited(log_path, services) -> bool:
    """Return whether the last meaningful Codex event is a rate-limit signal."""
    if not log_path:
        return False
    try:
        with open(log_path, "rb") as log:
            log.seek(0, os.SEEK_END)
            log.seek(max(0, log.tell() - 65536))
            tail = log.read()
    except OSError:
        return False

    last = None
    for raw in tail.split(b"\n"):
        try:
            event = json.loads(raw.strip())
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        if services._codex_is_rate_limit(event):
            last = "rate_limit"
        elif services._codex_is_turn_end(event):
            last = "turn_end"
        else:
            phase, _item_id = services._codex_event_phase(event)
            if phase in ("start", "end"):
                last = phase
    return last == "rate_limit"


def parse_rate_limit_reset(log_path, services) -> float:
    """Read the last retry hint, falling back to the notifier's safe cooldown."""
    seconds = None
    for event in _tail_events(log_path):
        if not services._codex_is_rate_limit(event):
            continue
        message = event.get("msg") if isinstance(event.get("msg"), dict) else {}
        retry_after = event.get("retry_after") or message.get("retry_after")
        if isinstance(retry_after, (int, float)) and retry_after > 0:
            seconds = float(retry_after)
            continue
        fields = (
            message.get("message"),
            message.get("error"),
            event.get("error"),
            event.get("message"),
        )
        for field in fields:
            if not isinstance(field, str):
                continue
            match = re.search(
                r"retry[ _-]?after[^0-9]*([0-9]+(?:\.[0-9]+)?)",
                field.lower(),
            )
            if match:
                seconds = float(match.group(1))
    if not seconds or seconds <= 0:
        seconds = services.RATE_LIMIT_DEFAULT_BACKOFF_SECS
    return max(5.0, min(seconds, 3600.0))


def drain_task_failure(
    api_base: str,
    worker: dict,
    agent_id: str,
    task_id,
    status: str,
    returncode,
    diff,
    *,
    failed_drains: dict,
    agent_hold_until: dict,
    now: float,
    quiet: bool,
    lane: str,
    live_workers: dict,
    pid,
    drain_desc: str,
    services,
) -> None:
    """Preserve failed task work and apply bounded retry bookkeeping."""
    if services._finish_run(
        api_base,
        worker.get("run_id"),
        status,
        returncode,
        worker.get("log_path"),
        diff,
        kill_reason=json.dumps(
            {
                "run_id": str(worker.get("run_id")),
                "agent_id": agent_id,
                "cause": status,
                "task_id": task_id,
            }
        ),
    ):
        services._reap_sandbox_artifacts(worker)  # I4: reap the wake's container once stamped
    key = (agent_id, task_id)
    failed_drains[key] = failed_drains.get(key, 0) + 1
    attempts = failed_drains[key]
    if status == "rate_limited":
        hold = services._parse_rate_limit_reset(worker.get("log_path"))
        agent_hold_until[agent_id] = now + hold
        human = (
            "worker hit a rate limit (Codex 429) — work saved and preserved; "
            "it will retry after the cooldown"
        )
    else:
        human = (
            "worker exited without finishing — work saved and preserved; "
            "it will retry"
        )
    saved_ref = services._saved_ref(worker, None, diff)
    services._record_task_saved_ref(api_base, worker, saved_ref, human)

    if attempts >= services.FAILED_DRAIN_MAX:
        services._post_json(
            f"{api_base}/api/agents/{agent_id}/wake-ack",
            {
                "delivered_ts": worker.get("wake_ack_ts"),
                "kind": "worker_drain_failed_released",
                "release_lease": True,
                "lane": lane,
            },
        )
        services._record_task_saved_ref(
            api_base,
            worker,
            saved_ref,
            f"heads up: this worker has failed to finish {attempts} times "
            "in a row — releasing it for now so it doesn't loop; the work "
            "is saved on its branch",
        )
        failed_drains.pop(key, None)
    else:
        kind = (
            "worker_rate_limited"
            if status == "rate_limited"
            else "worker_drain_failed"
        )
        services._post_json(
            f"{api_base}/api/agents/{agent_id}/wake-ack",
            {"kind": kind, "release_lease": True, "lane": lane},
        )

    services._retire_headless(api_base, live_workers, agent_id)
    if not quiet:
        cursor = (
            "advanced (bound hit)"
            if attempts >= services.FAILED_DRAIN_MAX
            else "withheld"
        )
        print(
            f"[notifier] task worker for {agent_id} (pid {pid}) "
            f"{drain_desc} {status} ({attempts}/{services.FAILED_DRAIN_MAX}) "
            f"— worktree PRESERVED, cursor {cursor}"
        )


def _tail_events(log_path):
    """Yield dictionary events from the bounded tail of a worker log."""
    if not log_path:
        return
    try:
        with open(log_path, "rb") as log:
            log.seek(0, os.SEEK_END)
            log.seek(max(0, log.tell() - 65536))
            tail = log.read()
    except OSError:
        return
    for raw in tail.split(b"\n"):
        try:
            event = json.loads(raw.strip())
        except ValueError:
            continue
        if isinstance(event, dict):
            yield event
