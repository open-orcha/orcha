"""Coordinate notifier worker progress, completion, and watchdog handling."""

from __future__ import annotations

import os
import time

from . import notifier_reaper_completion as completion
from . import notifier_reaper_watchdog as watchdog


def reap_workers(
    api_base,
    live_workers,
    quiet,
    stall_secs,
    failed_drains,
    agent_hold_until,
    services,
):
    """Reap completed workers and intervene only when progress has stopped."""
    now = time.time()
    for aid, worker in list(live_workers.items()):
        proc = worker["proc"]
        lane = worker.get("lane", "work")
        services._pump_one(api_base, aid, worker)
        if proc.poll() is not None:
            completion.handle_exited(
                api_base,
                aid,
                worker,
                live_workers,
                failed_drains,
                agent_hold_until,
                now,
                quiet,
                services,
            )
            continue
        renew = services._post_json(
            f"{api_base}/api/agents/{aid}/wake-renew",
            {"lease_ttl": services.WAKE_LEASE_TTL_SECS, "lane": lane},
        )
        if completion.handle_human_stop(
            api_base, aid, worker, live_workers, renew, quiet, services
        ):
            continue
        size = worker.get("last_size", 0)
        if worker.get("log_path"):
            try:
                size = os.path.getsize(worker["log_path"])
            except OSError:
                pass
        if size > worker.get("last_size", 0):
            worker["last_size"] = size
            worker["last_progress_ts"] = now
        stalled = now - worker.get("last_progress_ts", now) > stall_secs
        over_cap = now > worker.get("hard_deadline", now)
        if not (stalled or over_cap):
            continue
        runtime = services._normalize_runtime(
            (worker.get("respawn_ctx") or {}).get("model_runtime")
        )
        if watchdog.handle_terminal_result(
            api_base,
            aid,
            worker,
            live_workers,
            failed_drains,
            agent_hold_until,
            now,
            quiet,
            runtime,
            services,
        ):
            continue
        is_live = services._worker_is_live(worker.get("log_path"), runtime=runtime)
        if stalled and not over_cap and is_live:
            if not quiet:
                print(
                    f"[notifier] worker for {aid} (pid {proc.pid}) log-silent "
                    "but ALIVE (in-flight tool / rate-limit backoff) — not stall-killing"
                )
            continue
        respawnable = (
            bool(worker.get("respawn_ctx"))
            and worker.get("respawns", 0) < services.HARD_CAP_RESPAWN_MAX
        )
        if respawnable and (not stalled or (over_cap and is_live)):
            services._checkpoint_and_respawn(api_base, aid, worker, live_workers, quiet)
            continue
        watchdog.kill_stalled(
            api_base,
            aid,
            worker,
            live_workers,
            stall_secs,
            now,
            stalled,
            over_cap,
            is_live,
            runtime,
            services,
        )
