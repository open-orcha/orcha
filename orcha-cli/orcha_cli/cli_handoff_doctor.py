"""Read-only checkout handoff diagnostics for operators and automation."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import replace

from . import notifier_worktree_cleanup


class _ReadOnlyGitServices:
    """Git adapter that forbids optional index and metadata refresh writes."""

    @staticmethod
    def _run_git(args, cwd=None, timeout: float = 30.0):
        environment = os.environ.copy()
        environment["GIT_OPTIONAL_LOCKS"] = "0"
        try:
            result = subprocess.run(
                ["git", "--no-optional-locks", *args],
                cwd=cwd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="surrogateescape",
                timeout=timeout,
                check=False,
                env=environment,
            )
            return result.returncode, result.stdout
        except (OSError, subprocess.SubprocessError, ValueError):
            return 1, ""


def inspect_checkout_handoff(
    source, destination, owner_key, *, snapshot_run_id=None
):
    """Return a structured handoff preflight without changing either checkout."""
    services = _ReadOnlyGitServices()

    def activity_summary(checkout):
        if not checkout:
            return {
                "status": "not_checked",
                "owner_key": None,
                "run_id": None,
                "pid": None,
                "reservation_id": None,
            }
        git_code, _ = services._run_git(
            ["rev-parse", "--git-dir"], cwd=checkout
        )
        if git_code != 0:
            return {
                "status": "not_available",
                "owner_key": None,
                "run_id": None,
                "pid": None,
                "reservation_id": None,
            }
        try:
            activity = notifier_worktree_cleanup.checkout_activity_status(
                checkout, services
            )
        except (OSError, ValueError):
            activity = {"status": "unreadable", "records": []}
        records = activity.get("records") or []
        record = records[0] if records and isinstance(records[0], dict) else {}
        return {
            "status": activity.get("status", "unreadable"),
            "owner_key": record.get("owner_key"),
            "run_id": record.get("run_id"),
            "pid": record.get("pid"),
            "reservation_id": record.get("reservation_id"),
        }

    source_activity = activity_summary(source)
    if (
        source
        and destination
        and os.path.realpath(source) == os.path.realpath(destination)
    ):
        destination_activity = source_activity
    else:
        destination_activity = activity_summary(destination)
    activity_details = {
        "source": source_activity,
        "destination": destination_activity,
    }
    activity_metadata = {
        "checkout_activity_checked": True,
        "checkout_activity": activity_details,
        # Git-private reservations are authoritative barriers, but this local
        # command intentionally does not query the Orcha API's run table.
        "live_api_users_checked": False,
        "live_state_checked": False,
    }
    blocking_statuses = {"active", "pending_snapshot", "unreadable"}
    blockers = [
        (side, summary)
        for side, summary in (
            ("source", source_activity),
            ("destination", destination_activity),
        )
        if summary["status"] in blocking_statuses
    ]
    if blockers:
        side, blocker = blockers[0]
        status = blocker["status"]
        code = {
            "active": f"{side}_checkout_activity_active",
            "pending_snapshot": f"{side}_checkout_activity_pending_snapshot",
            "unreadable": f"{side}_checkout_activity_unreadable",
        }[status]
        if status == "active":
            reason = f"A worker is currently using the {side} checkout."
        elif status == "pending_snapshot":
            reason = (
                f"The {side} checkout has stopped-worker state that still needs "
                "an exact snapshot."
            )
        else:
            reason = f"The {side} checkout activity proof could not be read."
        return notifier_worktree_cleanup.HandoffResult(
            ok=False,
            code=code,
            phase="checkout_activity",
            source=os.path.realpath(source) if source else None,
            destination=os.path.realpath(destination) if destination else None,
            requested_owner=owner_key,
            observed_owner=blocker.get("owner_key"),
            guidance=(
                f"{reason} This read-only preflight preserved both checkouts and "
                "did not declare the handoff ready. Let Orcha finish the worker "
                "snapshot or ask the project owner to reconcile unreadable proof."
            ),
            mutated=False,
            details=activity_metadata,
        )

    # Only capture file state after the process-held barriers prove that neither
    # checkout has an active writer or an unreconciled stopped writer.
    result = notifier_worktree_cleanup.inspect_handoff(
        source,
        destination,
        services,
        owner_key=owner_key,
        snapshot_run_id=snapshot_run_id,
    )
    activity_guidance = (
        "Checkout activity reservations were checked and do not add a blocker. "
        "The real handoff also rechecks API-recorded live users immediately "
        "before any mutation."
    )
    return replace(
        result,
        guidance=f"{result.guidance} {activity_guidance}".strip(),
        details={**result.details, **activity_metadata},
    )


def _print_human_result(payload: dict) -> None:
    status = "preflight-ready" if payload["ok"] else "blocked"
    fields = (
        ("status", status),
        ("code", payload["code"]),
        ("phase", payload["phase"]),
        ("source", payload["source"]),
        ("destination", payload["destination"]),
        ("requested_owner", payload["requested_owner"]),
        ("observed_owner", payload["observed_owner"]),
        ("patch_sha256", payload["patch_sha256"]),
        ("mutated", str(payload["mutated"]).lower()),
        ("guidance", payload["guidance"]),
    )
    for key, value in fields:
        print(f"{key}: {value if value is not None else '-'}")
    print(f"details: {json.dumps(payload['details'], sort_keys=True)}")


def cmd_handoff_doctor(args) -> None:
    """Run the public, non-mutating handoff preflight command."""
    result = inspect_checkout_handoff(
        args.source,
        args.destination,
        args.owner_key,
        snapshot_run_id=args.snapshot_run_id,
    )
    payload = result.to_dict()
    if args.json:
        print(json.dumps(payload, sort_keys=True))
    else:
        _print_human_result(payload)
    sys.exit(0 if result.ok else 1)
