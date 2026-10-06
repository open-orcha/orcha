"""Carry saved checkout state across project worktree-routing changes."""

from __future__ import annotations

import os
import pathlib
from dataclasses import dataclass
from urllib.parse import urlencode

from . import notifier_worktree_cleanup as _cleanup
from .notifier_worktree_cleanup import HandoffResult


@dataclass(frozen=True)
class PreviousRunLookup:
    """Outcome of an exact, provenance-bearing run-history lookup."""

    ok: bool
    run: dict | None = None
    code: str = ""


@dataclass(frozen=True)
class CheckoutStartPreparation:
    """One routing decision plus its optional shared-checkout barrier."""

    handoff: HandoffResult
    activity: object | None = None

    @property
    def ok(self) -> bool:
        return bool(self.handoff)

    @property
    def code(self) -> str:
        return self.handoff.code

    @property
    def guidance(self) -> str:
        return self.handoff.guidance

    def __bool__(self) -> bool:
        return self.ok


_CONTROL_WAKE_EVENTS = frozenset(
    {
        "checkout_consent_prompt",
        "checkout_consent_declined",
        "checkout_consent_resolved",
        "checkout_handoff_blocked",
    }
)


def _routing_result(
    ok,
    code,
    phase,
    *,
    source=None,
    destination=None,
    owner_key=None,
    guidance="",
    details=None,
):
    """Build a structured routing outcome without reaching into cleanup internals."""
    return HandoffResult(
        ok=bool(ok),
        code=code,
        phase=phase,
        source=str(source) if source is not None else None,
        destination=str(destination) if destination is not None else None,
        requested_owner=owner_key,
        guidance=guidance,
        details=details or {},
    )


def _maybe_structured(result, structured):
    return result if structured else result.ok


def _snapshot_failure_with_evidence(
    code,
    guidance,
    *,
    source_cwd,
    run_id,
    agent_id,
    owner_key,
    services,
    details=None,
):
    """Persist a durable ambiguity marker before finalizing without a snapshot.

    An intrinsic snapshot failure will not improve while a dead run remains
    open, but closing that row without durable proof lets a later sole row claim
    the combined shared checkout.  Finalization is safe only after append-only
    ambiguity evidence has been written and revalidated.
    """
    recorder = getattr(services, "_record_checkout_overlap_evidence", None)
    if recorder is None:
        return _routing_result(
            False,
            "snapshot_overlap_capability_missing",
            "source_snapshot",
            source=source_cwd,
            owner_key=owner_key,
            guidance=(
                "Orcha could not persist restart-safe proof of this snapshot "
                "failure, so it kept the stopped run for a safe retry."
            ),
        )
    evidence = recorder(
        source_cwd,
        owner_key,
        run_id=run_id,
        agent_id=agent_id,
        other_rows=(),
        unknown_checkout_user=False,
        reason=f"snapshot_failure:{code}",
    )
    if evidence is None or not evidence.ok:
        return evidence or _routing_result(
            False,
            "snapshot_overlap_evidence_write_failed",
            "source_snapshot",
            source=source_cwd,
            owner_key=owner_key,
            guidance=(
                "Orcha could not persist restart-safe proof of this snapshot "
                "failure, so it kept the stopped run for a safe retry."
            ),
        )
    return _routing_result(
        False,
        code,
        "source_snapshot",
        source=source_cwd,
        owner_key=owner_key,
        guidance=guidance,
        details={
            **(details or {}),
            "ambiguity_evidence_recorded": True,
            "ambiguity_evidence_count": (evidence.details or {}).get(
                "evidence_count", 0
            ),
        },
    )


_FINALIZE_WITHOUT_SNAPSHOT_CODES = frozenset(
    {
        # A validated pre-existing marker is itself durable proof. New intrinsic
        # failures finalize only when their result explicitly confirms that a
        # fresh ambiguity marker was written and revalidated.
        "snapshot_prior_shared_overlap",
    }
)


def stopped_snapshot_requires_retry(result) -> bool:
    """Return whether a failed stopped-run snapshot may become safe on retry.

    A transient visibility, read, stability, or write failure retains the run
    as the snapshot owner.  Intrinsic ambiguity is finalized without attaching
    checkout contents to that run: the files and existing ownership proof stay
    in place, while a later handoff remains fail-closed for human review.
    Unknown failures default to retry so new error codes cannot silently weaken
    preservation guarantees.
    """
    if result is None or result.ok:
        return False
    details = getattr(result, "details", {}) or {}
    has_durable_ambiguity_proof = bool(
        result.code in _FINALIZE_WITHOUT_SNAPSHOT_CODES
        or details.get("ambiguity_evidence_recorded") is True
    )
    return not has_durable_ambiguity_proof


def stopped_snapshot_has_attributable_state(result) -> bool:
    """Return whether checkout contents may be attached to the stopped run."""
    return result is None or bool(result.ok)


def capture_stopped_checkout_diff(result, cwd, services):
    """Capture a run diff only when its checkout state is unambiguous."""
    if not stopped_snapshot_has_attributable_state(result):
        return None
    if result is not None and getattr(result, "code", None) == "snapshot_recorded":
        # Shared main can acquire a new writer immediately after the stopped-run
        # snapshot.  Use the bounded display copy made from that immutable
        # snapshot instead of re-reading a now-mutable checkout.
        details = getattr(result, "details", {}) or {}
        return details.get("captured_diff")
    return services._capture_diff(cwd)


def _previous_run_lookup(
    api_base,
    agent_id,
    services,
    *,
    task_id=None,
    conversation_id=None,
    wake_kind=None,
    lane=None,
    require_taskless=False,
):
    """Return an exact stream lookup, distinguishing absence from uncertainty."""
    parameters = {"limit": 200, "provenance_only": "true"}
    if task_id:
        parameters["task_id"] = task_id
    if conversation_id:
        parameters["conversation_id"] = conversation_id
    if wake_kind:
        parameters["wake_kind"] = wake_kind
    if lane:
        parameters["lane"] = lane
    if require_taskless:
        parameters["taskless"] = "true"
    data = services._get_json(
        f"{api_base}/api/agents/{agent_id}/runs?{urlencode(parameters)}"
    )
    if not isinstance(data, dict) or not isinstance(data.get("runs"), list):
        return PreviousRunLookup(False, code="run_history_unavailable")
    runs = data["runs"]
    for run in runs:
        if run.get("wake_event") in _CONTROL_WAKE_EVENTS:
            continue
        if task_id and run.get("task_id") != task_id:
            # Routing provenance comes from the run's primary checkout pin, never
            # its many-to-many progress-feed membership.  Keep this defensive
            # check even though current provenance queries filter server-side so
            # older servers and test doubles cannot return another task's state.
            continue
        if conversation_id and run.get("conversation_id") != conversation_id:
            continue
        if wake_kind and run.get("wake_kind") != wake_kind:
            continue
        if lane and run.get("lane") != lane:
            continue
        if require_taskless and (
            run.get("task_id") is not None or run.get("conversation_id") is not None
        ):
            continue
        if run.get("worktree") or run.get("base_cwd"):
            return PreviousRunLookup(True, run=run, code="found")
    if data.get("query_complete") is True or len(runs) < 200:
        return PreviousRunLookup(True, code="not_found")
    return PreviousRunLookup(False, code="run_history_truncated")


def previous_run(
    api_base,
    agent_id,
    services,
    *,
    task_id=None,
    conversation_id=None,
    wake_kind=None,
    lane=None,
    require_taskless=False,
):
    """Return the newest run for the same logical stream of work."""
    return _previous_run_lookup(
        api_base,
        agent_id,
        services,
        task_id=task_id,
        conversation_id=conversation_id,
        wake_kind=wake_kind,
        lane=lane,
        require_taskless=require_taskless,
    ).run


def previous_checkout(api_base, agent_id, services, **filters):
    """Return the newest recorded checkout for the same logical stream of work."""
    run = previous_run(api_base, agent_id, services, **filters)
    return (run.get("worktree") or run.get("base_cwd")) if run else None


def checkout_owner_key(
    agent_id,
    *,
    task_id=None,
    conversation_id=None,
    wake_kind=None,
    lane=None,
):
    """Name the logical stream allowed to reconcile a checkout's saved patch."""
    if task_id:
        return f"task:{task_id}"
    if conversation_id:
        return f"conversation:{conversation_id}"
    if wake_kind == "live":
        return f"terminal:{agent_id}"
    return f"{lane or 'work'}:{agent_id}:taskless"


def retained_branch_exists(services, base_cwd, branch):
    """Return whether a recorded worker branch still exists, or None when unknowable."""
    run_git = getattr(services, "_run_git", None)
    if run_git is None or not branch or not base_cwd:
        return None
    try:
        return_code, _ = run_git(
            ["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"],
            cwd=base_cwd,
        )
    except (OSError, TypeError, ValueError):
        return None
    if return_code == 0:
        return True
    if return_code == 1:
        return False
    # ``git show-ref --verify --quiet`` reserves exit 1 for a missing ref.
    # Repository, permission, and corruption failures use other codes and must
    # remain unknown so routing fails closed instead of treating work as gone.
    return None


def _retirement_proof(services, base_cwd, source_cwd, branch):
    checker = getattr(services, "_retirement_record_status", None)
    if checker is None:
        return "missing", None
    try:
        return checker(base_cwd, source_cwd, branch)
    except (OSError, TypeError, ValueError):
        return "invalid", None


def checkout_live_guard(
    api_base,
    services,
    *,
    container_id=None,
    local_workers=None,
    ignore_run_id=None,
    ignore_activity_id=None,
):
    """Build a last-moment guard against mutating any checkout with a live user."""
    if local_workers is None:
        local_workers = getattr(services, "_LOCAL_CHECKOUT_REGISTRIES", None)
    resolver = getattr(services, "_container_id_for", None)

    def guard(source, destination):
        cid = container_id
        if not cid and resolver is not None:
            for candidate in (destination, source):
                try:
                    cid = resolver(pathlib.Path(candidate))
                except (OSError, TypeError, ValueError):
                    cid = None
                if cid:
                    break
        if not cid:
            return _routing_result(
                False,
                "checkout_live_state_unverified",
                "live_checkout_guard",
                source=source,
                destination=destination,
                guidance=(
                    "Orcha could not identify the repository container, so it did "
                    "not change either checkout."
                ),
            )
        data = services._get_json(
            f"{api_base}/api/containers/{cid}/running-runs?include_retired=true"
        )
        rows = data.get("runs") if isinstance(data, dict) else None
        if rows is None:
            return _routing_result(
                False,
                "checkout_live_state_unverified",
                "live_checkout_guard",
                source=source,
                destination=destination,
                guidance=(
                    "Orcha could not verify current checkout users, so it left both "
                    "checkouts and their ownership proof unchanged."
                ),
            )
        try:
            protected = {
                pathlib.Path(source).resolve(),
                pathlib.Path(destination).resolve(),
            }
            users = []
            unknown = 0
            activity_users = 0
            activity_pending = 0
            activity_inspector = getattr(
                services, "_checkout_activity_status", None
            )
            if callable(activity_inspector):
                for checkout in protected:
                    activity = activity_inspector(
                        checkout,
                        ignore_reservation_id=ignore_activity_id,
                        ignore_run_id=ignore_run_id,
                    )
                    status = (
                        activity.get("status")
                        if isinstance(activity, dict)
                        else "unreadable"
                    )
                    if status == "active":
                        activity_users += 1
                    elif status == "pending_snapshot":
                        activity_pending += 1
                    elif status not in {"none", "ignored"}:
                        unknown += 1
            for row in rows:
                if row.get("wake_event") in _CONTROL_WAKE_EVENTS:
                    # Checkout-consent notices deliberately create pathless,
                    # non-writer run rows. They must not masquerade as an
                    # unidentified checkout user and poison unrelated handoffs.
                    continue
                if (
                    ignore_run_id is not None
                    and str(row.get("run_id")) == str(ignore_run_id)
                ):
                    continue
                cwd = row.get("worktree") or row.get("base_cwd")
                if not cwd:
                    unknown += 1
                    continue
                if pathlib.Path(cwd).resolve() in protected:
                    users.append(row)
            # A just-spawned worker can exist briefly before its run row is
            # visible, and a failed run-registration call used to leave that
            # worker alive indefinitely.  The notifier's in-memory registry is
            # authoritative for that local gap; consult it in addition to the
            # durable server rows whenever the caller can provide it.
            registries = (
                local_workers
                if isinstance(local_workers, (tuple, list))
                else (local_workers,)
            )
            for registry in registries:
                if registry is None:
                    continue
                if not isinstance(registry, dict):
                    unknown += 1
                    continue
                for worker in registry.values():
                    if not isinstance(worker, dict):
                        unknown += 1
                        continue
                    process = worker.get("proc")
                    live = True
                    poll = getattr(process, "poll", None)
                    if callable(poll):
                        try:
                            live = poll() is None
                        except (OSError, TypeError, ValueError):
                            live = True
                    if not live:
                        continue
                    cwd = worker.get("worktree") or worker.get("base_cwd")
                    if not cwd:
                        unknown += 1
                        continue
                    if pathlib.Path(cwd).resolve() in protected:
                        users.append(worker)
        except (OSError, TypeError, ValueError):
            users = []
            unknown = 1
        if users or activity_users or activity_pending or unknown:
            return _routing_result(
                False,
                (
                    "checkout_live_in_use"
                    if users or activity_users
                    else "checkout_snapshot_pending"
                    if activity_pending
                    else "checkout_live_state_unverified"
                ),
                "live_checkout_guard",
                source=source,
                destination=destination,
                guidance=(
                    "A worker is still using one of these checkouts. Orcha paused "
                    "the handoff before changing any file or ownership record."
                    if users or activity_users
                    else "A stopped worker's exact checkout snapshot is still pending, so Orcha preserved both checkouts."
                    if activity_pending
                    else "A running worker did not identify its checkout, so Orcha paused the handoff without changing anything."
                ),
                details={
                    "matching_live_runs": len(users),
                    "active_checkout_reservations": activity_users,
                    "pending_checkout_snapshots": activity_pending,
                    "unidentified_live_runs": unknown,
                },
            )
        return None

    return guard


def reserve_checkout_start(
    api_base,
    cwd,
    owner_key,
    services,
    *,
    container_id=None,
    local_workers=None,
):
    """Create cross-process checkout-use proof before a worker can start."""
    reserver = getattr(services, "_reserve_checkout_activity", None)
    if not callable(reserver):
        return _routing_result(
            False,
            "checkout_activity_capability_missing",
            "activity_reservation",
            destination=cwd,
            owner_key=owner_key,
            guidance=(
                "This runtime cannot create restart-safe checkout-use proof, so "
                "Orcha did not start a worker."
            ),
        )
    return reserver(
        cwd,
        owner_key,
        checkout_guard=checkout_live_guard(
            api_base,
            services,
            container_id=container_id,
            local_workers=local_workers,
        ),
    )


def prepare_checkout_start(
    api_base,
    agent_id,
    destination_cwd,
    services,
    *,
    shared_checkout=False,
    source_cwd=None,
    task_id=None,
    conversation_id=None,
    wake_kind=None,
    lane=None,
    require_taskless=False,
    local_workers=None,
    container_id=None,
):
    """Route saved state behind a durable barrier before a writer can start.

    Shared-main starts reserve the destination first.  Every handoff's final
    live check then ignores only that exact reservation.  A daemon crash can
    therefore leave an explicit ``routing`` phase, but never an unguarded gap
    in which a second daemon starts writing or attributes the old state to the
    prospective owner.
    """
    owner_key = checkout_owner_key(
        agent_id,
        task_id=task_id,
        conversation_id=conversation_id,
        wake_kind=wake_kind,
        lane=lane,
    )
    activity = None
    if shared_checkout:
        activity = reserve_checkout_start(
            api_base,
            destination_cwd,
            owner_key,
            services,
            container_id=container_id,
            local_workers=local_workers,
        )
        if not activity:
            return CheckoutStartPreparation(activity, None)
    handoff = carry_previous_checkout(
        api_base,
        agent_id,
        destination_cwd,
        services,
        source_cwd=source_cwd,
        task_id=task_id,
        conversation_id=conversation_id,
        wake_kind=wake_kind,
        lane=lane,
        require_taskless=require_taskless,
        structured=True,
        local_workers=local_workers,
        ignore_activity_id=(
            getattr(activity, "reservation_id", None) if activity else None
        ),
    )
    if not handoff:
        if activity is not None:
            release = getattr(services, "_release_checkout_activity", None)
            released = (
                release(destination_cwd, activity=activity)
                if callable(release)
                else None
            )
            if released is None or not released:
                return CheckoutStartPreparation(
                    _routing_result(
                        False,
                        getattr(released, "code", "checkout_routing_cleanup_failed"),
                        "activity_release",
                        source=getattr(handoff, "source", source_cwd),
                        destination=destination_cwd,
                        owner_key=owner_key,
                        guidance=(
                            getattr(released, "guidance", "")
                            or "Routing stopped, but Orcha could not prove that the pre-start checkout state was unchanged. The reservation and all files were preserved for review."
                        ),
                        details={"handoff_code": getattr(handoff, "code", None)},
                    ),
                    None,
                )
        return CheckoutStartPreparation(handoff, None)
    if activity is not None:
        marker = getattr(services, "_mark_checkout_activity_routed", None)
        marked = False
        if callable(marker):
            try:
                marked = bool(
                    marker(
                        activity,
                        source=getattr(handoff, "source", source_cwd),
                        patch_sha256=getattr(handoff, "patch_sha256", None),
                    )
                )
            except (OSError, TypeError, ValueError):
                marked = False
        if not marked:
            # The phase write failed after routing.  Do not release a record
            # whose before-fingerprint no longer matches; release itself
            # performs that proof and otherwise leaves a fail-closed marker.
            release = getattr(services, "_release_checkout_activity", None)
            if callable(release):
                release(destination_cwd, activity=activity)
            return CheckoutStartPreparation(
                _routing_result(
                    False,
                    "checkout_activity_route_bind_failed",
                    "activity_reservation",
                    source=getattr(handoff, "source", source_cwd),
                    destination=destination_cwd,
                    owner_key=owner_key,
                    guidance=(
                        "The saved files were routed, but Orcha could not persist "
                        "the exact pre-writer phase. No worker was started; the "
                        "checkout and reservation were preserved for review."
                    ),
                ),
                None,
            )
    return CheckoutStartPreparation(handoff, activity)


def _activity_run_matches(record, row, checkout) -> bool:
    """Prove that a run row is the activity record's own logical writer."""
    try:
        row_checkout = row.get("worktree") or row.get("base_cwd")
        if not row_checkout or pathlib.Path(row_checkout).resolve() != checkout:
            return False
    except (OSError, TypeError, ValueError):
        return False
    recorded_run = record.get("run_id")
    if recorded_run is not None:
        return str(row.get("run_id")) == str(recorded_run)
    recorded_pid = record.get("pid")
    if recorded_pid is not None and row.get("pid") != recorded_pid:
        return False
    owner = record.get("owner_key") or ""
    if owner.startswith("task:"):
        return str(row.get("task_id")) == owner.removeprefix("task:")
    if owner.startswith("conversation:"):
        return str(row.get("conversation_id")) == owner.removeprefix(
            "conversation:"
        )
    if owner.startswith("terminal:"):
        return str(row.get("agent_id")) == owner.removeprefix("terminal:")
    pieces = owner.split(":")
    return (
        len(pieces) == 3
        and pieces[2] == "taskless"
        and str(row.get("agent_id")) == pieces[1]
        and row.get("task_id") is None
    )


def reconcile_checkout_activities(
    api_base,
    base_cwd,
    services,
    *,
    container_id=None,
    local_workers=None,
):
    """Finalize unlocked checkout reservations left by a daemon restart.

    A version-two launcher passes the locked reservation descriptor into its
    child.  Thus a locked record is a live writer and an unlocked record is a
    stopped/pre-spawn writer.  Before snapshotting, this recovery pass also
    proves the API has no different checkout user and correlates any own run
    row by exact run id or by PID plus logical stream identity.
    """
    common = _cleanup._git_common_path(base_cwd, services)
    if common is None:
        return []
    directory = common / "orcha" / "handoffs" / "activity"
    if not directory.is_dir():
        return []
    data = services._get_json(
        f"{api_base}/api/containers/{container_id}/running-runs?include_retired=true"
    ) if container_id else None
    rows = data.get("runs") if isinstance(data, dict) else None
    outcomes = []
    for path in sorted(directory.glob("*.json")):
        descriptor, record = _cleanup._read_activity_record(path)
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if record is None:
            outcomes.append(
                _routing_result(
                    False,
                    "checkout_activity_unreadable",
                    "activity_recovery",
                    guidance="Unreadable checkout-use proof was preserved for project-owner review.",
                )
            )
            continue
        checkout_text = record.get("checkout")
        try:
            checkout = pathlib.Path(checkout_text).resolve()
            expected = _cleanup._checkout_activity_path(checkout, services)
            checkout_common = _cleanup._git_common_path(checkout, services)
            valid_location = (
                expected is not None
                and expected == path.resolve()
                and checkout_common == common
            )
        except (OSError, TypeError, ValueError):
            valid_location = False
            checkout = pathlib.Path(base_cwd).resolve()
        if not valid_location:
            outcomes.append(
                _routing_result(
                    False,
                    "checkout_activity_location_conflict",
                    "activity_recovery",
                    source=checkout_text,
                    owner_key=record.get("owner_key"),
                    guidance="The reservation path did not match its checkout; it was left untouched.",
                )
            )
            continue
        status = _cleanup.checkout_activity_status(checkout, services)
        if status.get("status") == "active":
            outcomes.append(
                _routing_result(
                    True,
                    "checkout_activity_still_live",
                    "activity_recovery",
                    source=checkout,
                    owner_key=record.get("owner_key"),
                    guidance="The checkout writer still holds its reservation.",
                )
            )
            continue
        if status.get("status") != "pending_snapshot":
            outcomes.append(
                _routing_result(
                    False,
                    "checkout_activity_unreadable",
                    "activity_recovery",
                    source=checkout,
                    owner_key=record.get("owner_key"),
                    guidance="The checkout-use proof could not be validated and was preserved.",
                )
            )
            continue
        phase = record.get("phase") if record.get("version") == 3 else None
        if phase == "routing":
            outcomes.append(
                _routing_result(
                    False,
                    "checkout_routing_interrupted",
                    "activity_recovery",
                    source=checkout,
                    owner_key=record.get("owner_key"),
                    guidance=(
                        "A daemon stopped during checkout routing. Orcha cannot "
                        "prove that no partial handoff occurred, so it preserved "
                        "the checkout and reservation for project-owner review."
                    ),
                    details={"activity_phase": phase},
                )
            )
            continue
        pid = record.get("pid")
        pid_checker = getattr(services, "_run_pid_alive", None)
        if pid is not None:
            try:
                pid_live = bool(pid_checker(pid)) if callable(pid_checker) else False
            except (OSError, TypeError, ValueError):
                pid_live = True
            if pid_live:
                outcomes.append(
                    _routing_result(
                        False,
                        "checkout_activity_process_unlocked",
                        "activity_recovery",
                        source=checkout,
                        owner_key=record.get("owner_key"),
                        guidance="The recorded process is still live without a verifiable lock; recovery stayed fail-closed.",
                    )
                )
                continue
        if record.get("version") == 1 and pid is None and record.get("run_id") is None:
            outcomes.append(
                _routing_result(
                    False,
                    "checkout_activity_legacy_identity_missing",
                    "activity_recovery",
                    source=checkout,
                    owner_key=record.get("owner_key"),
                    guidance="Legacy reservation proof cannot establish whether a child started; it was preserved for review.",
                )
            )
            continue
        if rows is None:
            outcomes.append(
                _routing_result(
                    False,
                    "checkout_live_state_unverified",
                    "activity_recovery",
                    source=checkout,
                    owner_key=record.get("owner_key"),
                    guidance="The run service was unavailable, so restart recovery left the reservation untouched.",
                )
            )
            continue
        own_rows = [row for row in rows if _activity_run_matches(record, row, checkout)]
        if len(own_rows) > 1:
            outcomes.append(
                _routing_result(
                    False,
                    "checkout_activity_run_ambiguous",
                    "activity_recovery",
                    source=checkout,
                    owner_key=record.get("owner_key"),
                    guidance="More than one run matched the stopped reservation; all proof was preserved.",
                )
            )
            continue
        own_run_id = (
            str(own_rows[0].get("run_id"))
            if own_rows
            else record.get("run_id")
        )
        guard = checkout_live_guard(
            api_base,
            services,
            container_id=container_id,
            local_workers=local_workers,
            ignore_run_id=own_run_id,
            ignore_activity_id=record.get("reservation_id"),
        )
        guarded = guard(checkout, checkout)
        if guarded is not None:
            outcomes.append(guarded)
            continue
        if phase == "routed":
            if own_rows:
                outcomes.append(
                    _routing_result(
                        False,
                        "checkout_routed_run_identity_ambiguous",
                        "activity_recovery",
                        source=checkout,
                        owner_key=record.get("owner_key"),
                        guidance=(
                            "A run row exists for a reservation that never "
                            "reached its writer-started phase. Orcha preserved "
                            "both records for review."
                        ),
                    )
                )
                continue
            if not _cleanup._activity_fingerprint_matches(
                checkout, record.get("routed_fingerprint"), services
            ):
                outcomes.append(
                    _routing_result(
                        False,
                        "checkout_routed_state_changed",
                        "activity_recovery",
                        source=checkout,
                        owner_key=record.get("owner_key"),
                        guidance=(
                            "The checkout changed after routing but before a "
                            "writer identity was durably bound. Orcha preserved "
                            "all files and proof without assigning them to a stream."
                        ),
                    )
                )
                continue
            outcomes.append(
                _cleanup.release_checkout_activity(
                    checkout,
                    services,
                    reservation_id=record["reservation_id"],
                )
            )
            continue
        snapshot_run_id = own_run_id or f"activity:{record['reservation_id']}"
        snapshot = _cleanup.record_checkout_stream_snapshot(
            checkout,
            record["owner_key"],
            services,
            run_id=snapshot_run_id,
        )
        if not snapshot.ok:
            outcomes.append(snapshot)
            continue
        released = _cleanup.release_checkout_activity(
            checkout,
            services,
            reservation_id=record["reservation_id"],
        )
        outcomes.append(released)
    return outcomes


def carry_previous_checkout(
    api_base,
    agent_id,
    destination_cwd,
    services,
    *,
    source_cwd=None,
    task_id=None,
    conversation_id=None,
    wake_kind=None,
    lane=None,
    require_taskless=False,
    structured=False,
    local_workers=None,
    ignore_activity_id=None,
):
    """Move the prior file view into ``destination_cwd`` before a new run starts.

    A missing prior run means there is no recorded state to carry. If a recorded
    worktree was retired, committed state is recovered from its retained branch;
    a routing change fails closed when no recoverable source remains. All actual
    transfers use the ownership-aware handoff and fail closed on conflicts.
    """
    owner_key = checkout_owner_key(
        agent_id,
        task_id=task_id,
        conversation_id=conversation_id,
        wake_kind=wake_kind,
        lane=lane,
    )
    configured_registries = getattr(
        services, "_LOCAL_CHECKOUT_REGISTRIES", None
    )
    if local_workers is None:
        local_workers = configured_registries
    elif configured_registries:
        configured = (
            configured_registries
            if isinstance(configured_registries, (tuple, list))
            else (configured_registries,)
        )
        local_workers = (local_workers, *configured)
    live_guard = None
    if callable(getattr(services, "_container_id_for", None)):
        live_guard = checkout_live_guard(
            api_base,
            services,
            local_workers=local_workers,
            ignore_activity_id=ignore_activity_id,
        )
    lookup = _previous_run_lookup(
        api_base,
        agent_id,
        services,
        task_id=task_id,
        conversation_id=conversation_id,
        wake_kind=wake_kind,
        lane=lane,
        require_taskless=require_taskless,
    )
    if not lookup.ok:
        return _maybe_structured(
            _routing_result(
                False,
                lookup.code,
                "run_history",
                source=source_cwd,
                destination=destination_cwd,
                owner_key=owner_key,
                guidance=(
                    "Orcha could not prove the complete run history for this work "
                    "stream. It left both checkouts untouched; retry after the "
                    "service is available or ask the project owner to reconcile it."
                ),
            ),
            structured,
        )
    prior_run = lookup.run
    recorded_source_cwd = (
        prior_run.get("worktree") or prior_run.get("base_cwd")
        if prior_run
        else None
    )
    if source_cwd is None:
        source_cwd = recorded_source_cwd
    if not source_cwd or not destination_cwd:
        if destination_cwd and live_guard is not None:
            guarded = live_guard(destination_cwd, destination_cwd)
            if guarded is not None and not guarded.ok:
                return _maybe_structured(guarded, structured)
        return _maybe_structured(
            _routing_result(
                True,
                "no_saved_checkout",
                "routing",
                source=source_cwd,
                destination=destination_cwd,
                owner_key=owner_key,
                guidance="There is no saved checkout state to carry.",
            ),
            structured,
        )
    try:
        source = pathlib.Path(source_cwd).resolve()
        destination = pathlib.Path(destination_cwd).resolve()
        if source == destination:
            if live_guard is not None:
                guarded = live_guard(source, destination)
                if guarded is not None and not guarded.ok:
                    return _maybe_structured(guarded, structured)
            # Shared main can remain at the same path across wakes.  A same-path
            # route is not a bypass around durable proof that two streams
            # overlapped there: starting another writer would deepen the
            # ambiguity even though no file transfer is required.
            git_checker = getattr(services, "_is_git_repo", None)
            metadata_applies = True
            if callable(git_checker):
                try:
                    metadata_applies = bool(git_checker(str(source)))
                except (OSError, TypeError, ValueError):
                    metadata_applies = True
            if (
                prior_run
                and not prior_run.get("worktree")
                and metadata_applies
            ):
                overlap_inspector = getattr(
                    services, "_checkout_overlap_evidence", None
                )
                if overlap_inspector is None:
                    return _maybe_structured(
                        _routing_result(
                            False,
                            "source_overlap_capability_missing",
                            "source_provenance",
                            source=source,
                            destination=destination,
                            owner_key=owner_key,
                            guidance=(
                                "Orcha cannot verify shared-checkout ambiguity "
                                "proof, so it did not start another writer in "
                                "that checkout."
                            ),
                        ),
                        structured,
                    )
                overlap = overlap_inspector(source)
                overlap_status = (
                    overlap.get("status")
                    if isinstance(overlap, dict)
                    else "unreadable"
                )
                if overlap_status != "none":
                    return _maybe_structured(
                        _routing_result(
                            False,
                            (
                                "source_overlap_evidence_unreadable"
                                if overlap_status == "unreadable"
                                else "source_shared_overlap_unresolved"
                            ),
                            "source_provenance",
                            source=source,
                            destination=destination,
                            owner_key=owner_key,
                            guidance=(
                                "This checkout has unresolved proof that multiple "
                                "streams shared its files. It remains preserved, "
                                "and no worker will resume there until the project "
                                "owner reconciles the saved states."
                            ),
                            details={
                                "overlap_status": overlap_status,
                                "overlap_evidence_count": (
                                    overlap.get("evidence_count", 0)
                                    if isinstance(overlap, dict)
                                    else 0
                                ),
                            },
                        ),
                        structured,
                    )
            return _maybe_structured(
                _routing_result(
                    True,
                    "same_checkout",
                    "routing",
                    source=source,
                    destination=destination,
                    owner_key=owner_key,
                    guidance="The stream is already using the selected checkout.",
                ),
                structured,
            )
        source_owner_verified = bool(
            recorded_source_cwd
            and source == pathlib.Path(recorded_source_cwd).resolve()
        )
        if not source.exists():
            branch = prior_run.get("branch") if prior_run else None
            base_cwd = prior_run.get("base_cwd") if prior_run else None
            handoff_branch_result = getattr(
                services, "_handoff_branch_changes_result", None
            )
            handoff_branch = getattr(services, "_handoff_branch_changes", None)
            if branch and base_cwd and handoff_branch is not None:
                if retained_branch_exists(services, base_cwd, branch) is False:
                    proof_status, proof = _retirement_proof(
                        services, base_cwd, source, branch
                    )
                    if proof_status == "match":
                        disposition = proof.get("disposition")
                        if (
                            disposition == "clean"
                            and proof.get("checkout_head_oid")
                            != proof.get("origin_main_oid")
                        ):
                            return _maybe_structured(
                                _routing_result(
                                    False,
                                    "retired_checkout_commits_unavailable",
                                    "source_recovery",
                                    source=source,
                                    destination=destination,
                                    owner_key=owner_key,
                                    guidance=(
                                        "The retired checkout was clean but its recorded "
                                        "HEAD contained commits beyond the recorded base, "
                                        "and the retained branch is now missing. Orcha "
                                        "preserved the commit identity and destination but "
                                        "will not silently start from an empty checkout; ask "
                                        "the project owner to restore or reconcile that commit."
                                    ),
                                    details={
                                        "recorded_base_oid": proof.get(
                                            "origin_main_oid"
                                        ),
                                        "recorded_head_oid": proof.get(
                                            "checkout_head_oid"
                                        ),
                                    },
                                ),
                                structured,
                            )
                        return _maybe_structured(
                            _routing_result(
                                True,
                                (
                                    "human_discarded_checkout"
                                    if disposition == "human_discarded"
                                    else "retired_clean_checkout"
                                ),
                                "source_recovery",
                                source=source,
                                destination=destination,
                                owner_key=owner_key,
                                guidance=(
                                    "The prior checkout was retired cleanly and its "
                                    "durable retirement proof was validated."
                                    if disposition == "clean"
                                    else "The prior checkout was discarded with recorded human consent."
                                ),
                            ),
                            structured,
                        )
                    return _maybe_structured(
                        _routing_result(
                            False,
                            "missing_clean_retirement_proof",
                            "source_recovery",
                            source=source,
                            destination=destination,
                            owner_key=owner_key,
                            guidance=(
                                "The recorded source checkout and branch are gone, but "
                                "Orcha has no durable proof that they were retired cleanly. "
                                "Nothing was changed; ask the project owner which state to resume."
                            ),
                        ),
                        structured,
                    )
                if handoff_branch_result is not None:
                    branch_outcome = handoff_branch_result(
                        base_cwd,
                        branch,
                        str(destination),
                        owner_key=owner_key,
                        checkout_guard=live_guard,
                    )
                    return _maybe_structured(branch_outcome, structured)
                branch_ok = handoff_branch(
                    base_cwd, branch, str(destination), owner_key=owner_key,
                    checkout_guard=live_guard,
                )
                return _maybe_structured(
                    _routing_result(
                        bool(branch_ok),
                        "branch_transferred" if branch_ok else "branch_transfer_failed",
                        "source_recovery",
                        source=source,
                        destination=destination,
                        owner_key=owner_key,
                        guidance=(
                            "The retained branch was carried into the selected checkout."
                            if branch_ok
                            else "The retained branch could not be applied safely; both the branch and destination were preserved."
                        ),
                    ),
                    structured,
                )
            # Disposable worktrees with no retained branch are expected to
            # disappear between ordinary same-mode wakes. Crossing from that
            # missing source into main is different: the prior file view cannot
            # be proven, so stop instead of silently dropping it.
            if prior_run and prior_run.get("worktree") and base_cwd:
                try:
                    proof_status, proof = _retirement_proof(
                        services, base_cwd, source, branch
                    )
                    safe_fresh = proof_status == "match"
                    return _maybe_structured(
                        _routing_result(
                            safe_fresh,
                            (
                                "retired_disposable_checkout"
                                if safe_fresh
                                else "missing_source_checkout"
                            ),
                            "source_recovery",
                            source=source,
                            destination=destination,
                            owner_key=owner_key,
                            guidance=(
                                "The disposable checkout has validated retirement proof, so no saved state was lost."
                                if safe_fresh
                                else "The saved source checkout is missing without durable clean-retirement proof, so Orcha cannot prove what should resume."
                            ),
                            details={
                                "retirement_proof": proof_status,
                                "retirement_disposition": (
                                    proof.get("disposition") if proof else None
                                ),
                            },
                        ),
                        structured,
                    )
                except OSError:
                    pass
            return _maybe_structured(
                _routing_result(
                    False,
                    "missing_source_checkout",
                    "source_recovery",
                    source=source,
                    destination=destination,
                    owner_key=owner_key,
                    guidance=(
                        "The saved source checkout is missing and no retained branch "
                        "can reconstruct it. Leave the destination untouched and ask "
                        "the project owner which state should resume."
                    ),
                ),
                structured,
            )
    except OSError:
        return _maybe_structured(
            _routing_result(
                False,
                "checkout_path_unreadable",
                "routing",
                source=source_cwd,
                destination=destination_cwd,
                owner_key=owner_key,
                guidance="A saved checkout path could not be resolved; no files were changed.",
            ),
            structured,
        )

    handoff_result = getattr(services, "_handoff_worktree_changes_result", None)
    if handoff_result is not None:
        result = handoff_result(
            str(source),
            str(destination),
            owner_key=owner_key,
            source_owner_verified=source_owner_verified,
            snapshot_run_id=prior_run.get("run_id") if prior_run else None,
            checkout_guard=live_guard,
        )
    else:
        ok = services._handoff_worktree_changes(
            str(source),
            str(destination),
            owner_key=owner_key,
            source_owner_verified=source_owner_verified,
            snapshot_run_id=prior_run.get("run_id") if prior_run else None,
            checkout_guard=live_guard,
        )
        result = _routing_result(
            bool(ok),
            "transferred" if ok else "handoff_failed",
            "checkout_handoff",
            source=source,
            destination=destination,
            owner_key=owner_key,
            guidance=(
                "The saved checkout state was carried into the selected checkout."
                if ok
                else "Orcha could not prove a safe checkout handoff; both checkouts were preserved."
            ),
        )
    return _maybe_structured(result, structured)


def record_stopped_checkout_snapshot(
    worker,
    agent_id,
    services,
    *,
    api_base=None,
    container_id=None,
):
    """Persist the exact shared-checkout view of a stopped worker.

    Dedicated linked worktrees already provide an unambiguous source boundary.
    Shared main does not, so its per-stream snapshot must survive daemon restart.
    The caller is responsible for stopping the worker before invoking this helper.
    """
    if not isinstance(worker, dict) or worker.get("worktree"):
        return None
    source_cwd = worker.get("base_cwd")
    recorder = getattr(services, "_record_checkout_stream_snapshot", None)
    run_id = worker.get("run_id") or worker.get("current_run_id")
    api_base = api_base or worker.get("api_base")
    container_id = container_id or worker.get("container_id")
    if not container_id:
        resolver = getattr(services, "_container_id_for", None)
        if resolver is not None:
            try:
                container_id = resolver(pathlib.Path(source_cwd))
            except (OSError, TypeError, ValueError):
                container_id = None
    # Older run rows can legitimately be pathless. There is no checkout to
    # read or mutate in that case, so retain the historical reconciliation
    # behavior instead of keeping the dead row and its lease forever. New run
    # rows carry ``base_cwd``; a known checkout with no run identity remains a
    # preservation failure because no immutable snapshot could be keyed safely.
    if not source_cwd:
        return None
    git_checker = getattr(services, "_is_git_repo", None)
    if callable(git_checker):
        try:
            if not git_checker(source_cwd):
                # Checkout handoff provenance is Git-private metadata. A
                # non-repository run has no such state to transfer, so preserve
                # the legacy run-finalization path instead of retrying forever.
                return None
        except (OSError, TypeError, ValueError):
            pass
    if not run_id:
        return _routing_result(
            False,
            "snapshot_identity_missing",
            "source_snapshot",
            source=source_cwd,
            guidance=(
                "This shared-checkout run is missing its path or run identity. "
                "Orcha preserved the checkout but will not attribute its files "
                "to an unknown stream."
            ),
        )
    context = worker.get("respawn_ctx") or {}
    local_owner_key = checkout_owner_key(
        agent_id,
        task_id=context.get("task_id") or worker.get("wake_task_id"),
        conversation_id=worker.get("conversation_id"),
        wake_kind=worker.get("wake_kind"),
        lane=worker.get("lane"),
    )
    if recorder is None:
        return _snapshot_failure_with_evidence(
            "snapshot_capability_missing",
            (
                "This notifier cannot archive an exact stopped-run snapshot. "
                "The shared checkout and existing ownership proof were preserved."
            ),
            source_cwd=source_cwd,
            run_id=run_id,
            agent_id=agent_id,
            owner_key=local_owner_key,
            services=services,
        )
    overlap_inspector = getattr(services, "_checkout_overlap_evidence", None)
    if overlap_inspector is None:
        return _routing_result(
            False,
            "snapshot_overlap_capability_missing",
            "source_snapshot",
            source=source_cwd,
            guidance=(
                "Orcha cannot verify whether this shared checkout has unresolved "
                "overlap evidence, so it kept the stopped run for a safe retry."
            ),
        )
    overlap = overlap_inspector(source_cwd)
    overlap_status = (
        overlap.get("status") if isinstance(overlap, dict) else "unreadable"
    )
    if overlap_status == "unreadable":
        return _routing_result(
            False,
            "snapshot_overlap_evidence_unreadable",
            "source_snapshot",
            source=source_cwd,
            guidance=(
                "Existing shared-checkout ambiguity proof could not be validated. "
                "The checkout and proof were preserved for project-owner review."
            ),
        )
    if overlap_status == "present":
        reasons = set(overlap.get("reasons") or ())
        prior_failures = sorted(
            reason.removeprefix("snapshot_failure:")
            for reason in reasons
            if reason.startswith("snapshot_failure:")
        )
        has_real_overlap = "concurrent_or_unidentified_checkout_user" in reasons
        if not has_real_overlap and len(prior_failures) == 1:
            prior_code = prior_failures[0]
            guidance = (
                "The complete checkout view exceeded the safe snapshot limit. "
                "The files and exact failure proof remain preserved for project-owner reconciliation."
                if prior_code == "snapshot_capture_limit"
                else "A prior stopped-run snapshot could not be attributed safely. The checkout and exact failure proof remain preserved for project-owner review."
            )
            return _routing_result(
                False,
                prior_code,
                "source_snapshot",
                source=source_cwd,
                guidance=guidance,
                details={
                    "evidence_count": overlap.get("evidence_count", 0),
                    "evidence_reasons": sorted(reasons),
                    "ambiguity_evidence_recorded": True,
                },
            )
        return _routing_result(
            False,
            "snapshot_prior_shared_overlap",
            "source_snapshot",
            source=source_cwd,
            guidance=(
                "This checkout was previously shared by overlapping streams. "
                "Orcha preserved the combined files but will not assign them to "
                "this stream without project-owner reconciliation."
            ),
            details={
                "evidence_count": overlap.get("evidence_count", 0),
                "evidence_reasons": sorted(reasons),
            },
        )
    if not container_id or not api_base:
        return _routing_result(
            False,
            "snapshot_live_state_unverified",
            "source_snapshot",
            source=source_cwd,
            guidance=(
                "Orcha could not identify the run's container and API endpoint, so "
                "it did not trust a shared-checkout snapshot. The checkout remains "
                "untouched."
            ),
        )
    running = services._get_json(
        f"{api_base}/api/containers/{container_id}/running-runs?include_retired=true"
    )
    rows = running.get("runs") if isinstance(running, dict) else None
    if rows is None:
        return _routing_result(
            False,
            "snapshot_live_state_unverified",
            "source_snapshot",
            source=source_cwd,
            guidance=(
                "Orcha could not verify live checkout users, so no shared-checkout "
                "snapshot was trusted."
            ),
        )
    try:
        source = pathlib.Path(source_cwd).resolve()
        own_rows = []
        other_users = []
        unknown_user = False
        for row in rows:
            if row.get("wake_event") in _CONTROL_WAKE_EVENTS:
                continue
            row_cwd = row.get("worktree") or row.get("base_cwd")
            if not row_cwd:
                unknown_user = True
                continue
            if pathlib.Path(row_cwd).resolve() == source:
                if str(row.get("run_id")) == str(run_id):
                    own_rows.append(row)
                else:
                    other_users.append(row)
    except OSError:
        own_rows = []
        other_users = []
        unknown_user = True
    if unknown_user or other_users:
        own_row = own_rows[0] if len(own_rows) == 1 else {}
        owner_key = checkout_owner_key(
            agent_id,
            task_id=own_row.get("task_id")
            if "task_id" in own_row
            else context.get("task_id") or worker.get("wake_task_id"),
            conversation_id=own_row.get("conversation_id")
            if "conversation_id" in own_row
            else worker.get("conversation_id"),
            wake_kind=own_row.get("wake_kind") or worker.get("wake_kind"),
            lane=own_row.get("lane") or worker.get("lane"),
        )
        overlap_recorder = getattr(
            services, "_record_checkout_overlap_evidence", None
        )
        if overlap_recorder is None:
            return _routing_result(
                False,
                "snapshot_overlap_capability_missing",
                "source_snapshot",
                source=source_cwd,
                owner_key=owner_key,
                guidance=(
                    "Orcha could not persist restart-safe proof that multiple "
                    "streams shared this checkout, so it kept the stopped run "
                    "for a safe retry."
                ),
            )
        evidence = overlap_recorder(
            source_cwd,
            owner_key,
            run_id=run_id,
            agent_id=agent_id,
            other_rows=other_users,
            unknown_checkout_user=unknown_user,
        )
        if evidence is None or not evidence.ok:
            return evidence or _routing_result(
                False,
                "snapshot_overlap_evidence_write_failed",
                "source_snapshot",
                source=source_cwd,
                owner_key=owner_key,
                guidance=(
                    "Orcha could not persist restart-safe overlap proof, so it "
                    "kept the stopped run for a safe retry."
                ),
            )
        return _routing_result(
            False,
            "snapshot_checkout_still_shared",
            "source_snapshot",
            source=source_cwd,
            owner_key=owner_key,
            guidance=(
                "Another live or unidentifiable run may still use this checkout, so "
                "Orcha left it untouched and did not assign its state to this stream."
            ),
            details={
                "matching_run_count": len(own_rows) + len(other_users),
                "other_checkout_user_count": len(other_users),
                "unknown_checkout_user": unknown_user,
                "ambiguity_evidence_recorded": True,
                "ambiguity_evidence_count": (evidence.details or {}).get(
                    "evidence_count", 0
                ),
            },
        )
    if len(own_rows) != 1:
        return _routing_result(
            False,
            "snapshot_run_identity_unverified",
            "source_snapshot",
            source=source_cwd,
            guidance=(
                "The open run could not be matched uniquely to its server record, "
                "so Orcha preserved the checkout without assigning its state."
            ),
        )
    authoritative = own_rows[0]
    if authoritative.get("agent_id") and str(authoritative.get("agent_id")) != str(agent_id):
        return _snapshot_failure_with_evidence(
            "snapshot_run_identity_conflict",
            "The server attributes this run to a different agent; no snapshot was written.",
            source_cwd=source_cwd,
            run_id=run_id,
            agent_id=agent_id,
            owner_key=local_owner_key,
            services=services,
        )
    local_task_id = context.get("task_id") or worker.get("wake_task_id")
    local_conversation_id = worker.get("conversation_id")
    row_has_task_id = "task_id" in authoritative
    row_has_conversation_id = "conversation_id" in authoritative
    row_task_id = authoritative.get("task_id")
    row_conversation_id = authoritative.get("conversation_id")
    if (
        (
            row_has_task_id
            and local_task_id
            and (row_task_id is None or str(local_task_id) != str(row_task_id))
        )
        or (
            row_has_conversation_id
            and local_conversation_id
            and (
                row_conversation_id is None
                or str(local_conversation_id) != str(row_conversation_id)
            )
        )
    ):
        return _snapshot_failure_with_evidence(
            "snapshot_stream_identity_conflict",
            (
                "The in-memory worker and server disagree about which work stream "
                "owns this run. Both records were preserved for review."
            ),
            source_cwd=source_cwd,
            run_id=run_id,
            agent_id=agent_id,
            owner_key=local_owner_key,
            services=services,
        )
    owner_key = checkout_owner_key(
        agent_id,
        task_id=(row_task_id if row_has_task_id else local_task_id),
        conversation_id=(
            row_conversation_id
            if row_has_conversation_id
            else local_conversation_id
        ),
        wake_kind=authoritative.get("wake_kind") or worker.get("wake_kind"),
        lane=authoritative.get("lane") or worker.get("lane"),
    )
    snapshot = recorder(
        source_cwd,
        owner_key,
        run_id=run_id,
    )
    if snapshot is not None and snapshot.code == "snapshot_capture_limit":
        snapshot = _snapshot_failure_with_evidence(
            snapshot.code,
            snapshot.guidance,
            source_cwd=source_cwd,
            run_id=run_id,
            agent_id=agent_id,
            owner_key=owner_key,
            services=services,
            details=snapshot.details,
        )
    if stopped_snapshot_requires_retry(snapshot):
        return snapshot

    # A checkout-use barrier outlives the process deliberately.  Archive and
    # remove it only after this stopped run has either an exact snapshot or
    # durable ambiguity proof.  On daemon restart the in-memory handle is gone,
    # so the validated run id is the recovery identity.
    releaser = getattr(services, "_release_checkout_activity", None)
    activity = worker.get("checkout_activity")
    if not callable(releaser):
        if activity is None:
            return snapshot
        return _routing_result(
            False,
            "checkout_activity_release_capability_missing",
            "activity_release",
            source=source_cwd,
            owner_key=owner_key,
            guidance=(
                "The stopped checkout was preserved, but this runtime cannot "
                "archive its activity barrier; finalization will retry."
            ),
        )
    released = releaser(
        source_cwd,
        activity=activity,
        run_id=run_id,
    )
    if released is not None and not released.ok:
        return _routing_result(
            False,
            released.code,
            "activity_release",
            source=source_cwd,
            owner_key=owner_key,
            guidance=released.guidance,
            details=released.details,
        )
    return snapshot
