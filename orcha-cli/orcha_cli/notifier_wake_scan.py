"""Coordinate one notifier wake scan across its eligible agent candidates."""

from __future__ import annotations

import sys
import time

from . import notifier_wake_candidate


def _backfill_reachability(api_base, container_id, scan, base_cwd, quiet, services):
    """Make portal-created agents spawnable and resolvable from host workers."""
    if not base_cwd:
        return
    for candidate in scan.get("candidates", []):
        if not candidate.get("wake_enabled"):
            continue
        if not candidate.get("headless_cwd") and not candidate.get("tmux_target"):
            result = services._post_json(
                f"{api_base}/api/agents/{candidate['agent_id']}/reachability",
                {"headless_cwd": base_cwd},
            )
            if result and result.get("headless_cwd"):
                candidate["headless_cwd"] = result["headless_cwd"]
                if not quiet:
                    print(
                        f"[notifier] auto-recorded reachability for "
                        f"{candidate.get('alias')} (headless_cwd={base_cwd}) "
                        "— portal-created agent now wakeable"
                    )
        seeded = services._seed_tab_binding(
            base_cwd,
            candidate.get("alias"),
            candidate.get("agent_id"),
            container_id,
        )
        if seeded and not quiet:
            print(
                f"[notifier] seeded tab binding for {candidate.get('alias')} "
                f"(.claude/orcha-tabs/{candidate.get('alias')}.json) "
                "— portal-created agent now resolvable"
            )


def _scan_context(scan, agent_hold_until, services):
    """Resolve scan-wide grading settings once for all candidates."""
    triage_config = services._triage_config_from_scan(scan)
    triage_key = services._unseal_scan_key(scan, "triage_key_enc")

    def triage(text):
        return services._triage_wake(
            text, config=triage_config, api_key=triage_key
        )

    return {
        "triage": triage,
        "ack_config": services._ack_config_from_scan(scan),
        "ack_key": services._unseal_scan_key(scan, "ack_key_enc"),
        "autonomy_level": scan.get("autonomy_level"),
        "t2_enabled": scan.get("autonomy_level") == "full",
        "hold_now": time.time(),
        "agent_hold_until": agent_hold_until,
    }


def tick(
    api_base,
    container_id,
    *,
    dry_run,
    cooldown,
    min_idle,
    quiet,
    lease_ttl,
    live_workers,
    base_cwd,
    agent_hold_until,
    services,
):
    """Run one scan-and-wake pass and return the public summary."""
    holds = agent_hold_until if agent_hold_until is not None else {}
    scan = services._get_json(
        f"{api_base}/api/containers/{container_id}/wake-scan"
        f"?cooldown={cooldown}&min_idle={min_idle}"
    )
    if scan is None:
        if not quiet:
            print(
                "[notifier] wake-scan unreachable (is the stack up?)",
                file=sys.stderr,
            )
        return {"ok": False, "woke": [], "error": "scan_unreachable"}
    if not scan.get("active"):
        if not quiet:
            print(
                f"[notifier] container {scan.get('container_status')} "
                "— wakes suppressed"
            )
        return {
            "ok": True,
            "woke": [],
            "suppressed": scan.get("container_status"),
        }

    if base_cwd and not dry_run:
        _backfill_reachability(
            api_base, container_id, scan, base_cwd, quiet, services
        )
    context = _scan_context(scan, holds, services)
    woke = []
    for candidate in scan.get("candidates", []):
        record = notifier_wake_candidate.process_candidate(
            api_base,
            candidate,
            context=context,
            dry_run=dry_run,
            quiet=quiet,
            lease_ttl=lease_ttl,
            live_workers=live_workers,
            services=services,
        )
        if record is not None:
            woke.append(record)
    return {"ok": True, "woke": woke}
