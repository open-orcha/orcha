"""Claim, isolate, spawn, and register notifier work-lane workers."""

from __future__ import annotations

import sys
import time

from .notifier_routing_handoff import (
    checkout_owner_key,
    prepare_checkout_start,
)

# A wake whose saved files cannot be carried into the selected checkout is not
# retried on every scan tick: the candidate is held down for this long, and the
# visible thread notice is repeated at most once per interval instead of on every
# attempt (issue: thread spam every ~20s while a stale checkout record persisted).
HANDOFF_FAILURE_HOLD_SECS = 300.0
HANDOFF_FAILURE_NOTICE_INTERVAL_SECS = 1800.0
# One advisory per task while several agents share the main checkout because the
# project disabled worktrees.
SHARED_CHECKOUT_ADVISORY_INTERVAL_SECS = 6 * 3600.0

_HANDOFF_FAILURE_NOTICE_TS: dict = {}
_SHARED_CHECKOUT_ADVISORY_TS: dict = {}


def reset_notice_state() -> None:
    """Forget notice timestamps (tests and daemon restarts)."""
    _HANDOFF_FAILURE_NOTICE_TS.clear()
    _SHARED_CHECKOUT_ADVISORY_TS.clear()


def _due(registry, key, interval, now=None):
    """Return whether a notice keyed by ``key`` may be posted again, stamping it if so."""
    now = time.time() if now is None else now
    last = registry.get(key)
    if last is not None and now - last < interval:
        return False
    registry[key] = now
    return True


def shared_checkout_siblings(live_workers, candidate, run_task_id):
    """List other live workers editing the same main checkout for a different task."""
    if not candidate.get("worktrees_disabled") or not run_task_id or not live_workers:
        return []
    base_cwd = candidate.get("headless_cwd")
    siblings = []
    for agent_id, state in live_workers.items():
        if agent_id == candidate.get("agent_id") or not isinstance(state, dict):
            continue
        other_task = state.get("wake_task_id")
        if not other_task or other_task == run_task_id:
            continue
        if state.get("worktree"):
            continue
        if base_cwd and state.get("base_cwd") not in (None, base_cwd):
            continue
        respawn = state.get("respawn_ctx") or {}
        siblings.append(
            {
                "agent_id": agent_id,
                "alias": respawn.get("alias") or agent_id,
                "task_id": other_task,
            }
        )
    return siblings


def _advise_shared_checkout(api_base, candidate, run_task_id, live_workers, services):
    """Post one task-thread heads-up when worktrees are off and other tasks share main."""
    siblings = shared_checkout_siblings(live_workers, candidate, run_task_id)
    if not siblings:
        return None
    if not _due(
        _SHARED_CHECKOUT_ADVISORY_TS,
        run_task_id,
        SHARED_CHECKOUT_ADVISORY_INTERVAL_SECS,
    ):
        return None
    others = ", ".join(
        f"{sibling['alias']} (task {sibling['task_id']})" for sibling in siblings
    )
    body = (
        "Heads-up: worktrees are disabled for this project, so this task shares the "
        f"main checkout with {len(siblings)} other active task(s): {others}. "
        "Enable worktrees (Settings → \"Disable worktrees\" off) so every task gets its "
        "own isolated checkout and branch. Until then Orcha serialises edits per file: "
        "an agent waits for another agent's file lock before touching the same file, "
        "but unrelated edits still land in one shared working tree."
    )
    services._post_json(
        f"{api_base}/api/tasks/{run_task_id}/messages",
        {"author_agent_id": candidate["agent_id"], "body": body},
    )
    return siblings


def _previous_checkout_hint(api_base, candidate, task_id, services):
    """Best-effort path of the checkout whose files were not carried (for a notice)."""
    try:
        from .notifier_routing_handoff import previous_checkout

        return previous_checkout(
            api_base, candidate["agent_id"], services, task_id=task_id, lane="work"
        ) or "(unknown)"
    except Exception:  # noqa: BLE001 - the notice is informational only
        return "(unknown)"


def _worktree_for(candidate, auto_tasks, live_workers, dry_run, services):
    """Provision isolation appropriate to the candidate's likely work."""
    # This is the final routing decision shared by every work-lane trigger.  A disabled project
    # never creates OR selects a task/agent worktree; run_cwd below therefore falls back to the
    # registered main checkout.  Existing worktrees are deliberately left untouched.
    if candidate.get("worktrees_disabled"):
        return None, None, False
    headless_cwd = candidate.get("headless_cwd")
    noncode_events = ("request_answered", "request_closed")
    single_noncode = (candidate.get("pending_events") or 0) <= 1 and candidate.get(
        "latest_event"
    ) in noncode_events
    code_wake = (
        bool(auto_tasks)
        or bool(candidate.get("wake_task_id"))
        or bool(candidate.get("context_task_id"))
        or not single_noncode
    )
    task_id = candidate.get("context_task_id") or (
        auto_tasks[0] if auto_tasks else candidate.get("wake_task_id")
    )
    worktree = branch = None
    task_worktree = False
    if code_wake and headless_cwd and not dry_run and live_workers is not None:
        if task_id:
            worktree, branch = services._provision_task_worktree(
                headless_cwd, candidate.get("alias"), task_id
            )
            task_worktree = worktree is not None
        if worktree is None:
            worktree, branch = services._provision_worktree(
                headless_cwd, candidate.get("alias")
            )
    return worktree, branch, task_worktree


def _worker_state(
    candidate,
    *,
    process,
    run_id,
    log_path,
    worktree,
    branch,
    task_worktree,
    cap,
    event,
    run_task_id,
    token,
    prompt,
    sandbox_container_id=None,
    checkout_activity=None,
):
    """Build the daemon-owned state used by progress and completion reapers."""
    now = time.time()
    task_bound = run_task_id is not None
    handled = candidate.get("handled_event_ids") or []
    wake_ack_ts = candidate.get("ack_through_ts")
    if wake_ack_ts is None:
        wake_ack_ts = candidate.get("max_event_ts")
    respawn = {
        "prompt": prompt,
        "flags": candidate.get("headless_flags"),
        "alias": candidate.get("alias"),
        "model": candidate.get("model"),
        "reasoning_effort": candidate.get("reasoning_effort"),
        "model_runtime": candidate.get("model_runtime"),
        "task_id": run_task_id,
        "task_bound": task_bound,
        "task_worktree": task_worktree,
        "handled_event_ids": handled,
        "event": event,
        # Checkpoint respawns re-read the persisted project setting, but this value is the
        # fail-safe when the API is temporarily unavailable during that hand-off.
        "worktrees_disabled": bool(candidate.get("worktrees_disabled")),
    }
    return {
        "proc": process,
        "hard_deadline": now + cap,
        "last_size": 0,
        "last_progress_ts": now,
        "run_id": run_id,
        "log_path": log_path,
        # I4: the wake's sandbox container rides the record so every
        # completion path can reap it (container + api-config) after stamping.
        "sandbox_container_id": sandbox_container_id,
        "worktree": worktree,
        "branch": branch,
        "base_cwd": candidate.get("headless_cwd"),
        # Task failure/retry semantics must not depend on whether durable
        # task-worktree provisioning succeeded. A generic fallback is still a
        # task-bound run and must never acknowledge directives after failure.
        "task_bound": task_bound,
        "task_worktree": task_worktree,
        "started_ts": now,
        "agent_id": candidate["agent_id"],
        "lines_offset": 0,
        "lines_seq": 1,
        "lines_buf": b"",
        "cap": cap,
        "respawns": 0,
        "wake_event": event,
        # The server may ground a sole assignment/rework directive through
        # context_task_id even when wake_task_id is empty. Preserve that task
        # identity so every failure path withholds the directive for retry.
        "wake_task_id": run_task_id,
        "wake_ack_ts": wake_ack_ts,
        "handled_event_ids": handled,
        "respawn_ctx": respawn,
        "run_token": token,
        "lane": "work",
        "worktrees_disabled": bool(candidate.get("worktrees_disabled")),
        # Shared-main starts hold this Git-private barrier through stopped-state
        # snapshotting. Dedicated worktrees retain their existing isolation and
        # leave it unset. Keep the live handle out of respawn_ctx, which is
        # treated as serialisable continuation metadata.
        "checkout_activity": checkout_activity,
    }


def _stop_unregistered_worker(
    api_base,
    candidate,
    *,
    process,
    token,
    worktree,
    branch,
    task_worktree,
    run_task_id,
    log_path,
    sandbox_container_id,
    services,
):
    """Stop a worker whose durable run row could not be created.

    Letting that process continue would make every API-backed live-check blind to
    a real checkout writer.  Stop it synchronously, preserve any files it managed
    to create, and leave durable ambiguity proof when it used shared main.
    """
    killer = getattr(services, "_kill_worker", None)
    if callable(killer):
        killer(process, graceful=True)

    evidence = None
    if not worktree:
        recorder = getattr(services, "_record_checkout_overlap_evidence", None)
        if callable(recorder) and candidate.get("headless_cwd"):
            evidence = recorder(
                candidate["headless_cwd"],
                checkout_owner_key(
                    candidate["agent_id"], task_id=run_task_id, lane="work"
                ),
                run_id=(
                    f"unregistered:{token}"
                    if token
                    else f"unregistered-pid:{getattr(process, 'pid', 'unknown')}"
                ),
                agent_id=candidate["agent_id"],
                other_rows=(),
                unknown_checkout_user=True,
            )

    # A generic disposable checkout can be removed only when the existing safe
    # teardown proves it stayed clean.  Stable task worktrees are retained so a
    # later normal wake reuses the exact path and any early edits.
    if worktree and not task_worktree:
        teardown = getattr(services, "_safe_teardown_worktree", None)
        if callable(teardown):
            teardown(candidate.get("headless_cwd"), worktree, branch)

    reaper = getattr(services, "_reap_sandbox_artifacts", None)
    if callable(reaper):
        reaper(
            {
                "sandbox_container_id": sandbox_container_id,
                "base_cwd": candidate.get("headless_cwd"),
            }
        )
    revoker = getattr(services, "_revoke_or_defer", None)
    if callable(revoker):
        revoker(api_base, token)

    if run_task_id:
        evidence_code = getattr(evidence, "code", "unavailable")
        services._post_json(
            f"{api_base}/api/tasks/{run_task_id}/messages",
            {
                "author_agent_id": candidate["agent_id"],
                "body": (
                    "Worker start stopped because Orcha could not create its durable "
                    "run record. The process was terminated before another checkout "
                    "handoff, and any files it created remain preserved. "
                    f"Shared-checkout safety evidence: {evidence_code}."
                ),
            },
        )
    services._post_json(
        f"{api_base}/api/agents/{candidate['agent_id']}/wake-ack",
        {
            "kind": "worker_run_registration_failed",
            "release_lease": True,
            "lane": "work",
        },
    )
    return evidence


def spawn(
    api_base,
    candidate,
    *,
    prompt,
    event,
    dry_run,
    quiet,
    lease_ttl,
    live_workers,
    services,
):
    """Claim and launch one ephemeral worker, preserving all public wake seams."""
    cap = (
        max(lease_ttl, services.HARD_CAP_MIN_SECS)
        if live_workers is not None
        else lease_ttl
    )
    claim_ttl = services.WAKE_LEASE_TTL_SECS if live_workers is not None else cap
    lane = "work"
    if not dry_run:
        claim = services._post_json(
            f"{api_base}/api/agents/{candidate['agent_id']}/wake-claim",
            {
                "lease_ttl": claim_ttl,
                "kind": "ephemeral",
                "event": event,
                "lane": lane,
            },
        )
        if not (claim and claim.get("claimed")):
            reason = (claim or {}).get("reason", "claim failed (unreachable)")
            if not quiet:
                print(f"[notifier] skip {candidate['alias']} — single-flight: {reason}")
            return None

    auto_tasks = candidate.get("auto_start_task_ids") or []
    run_task_id = candidate.get("context_task_id") or (
        auto_tasks[0] if auto_tasks else candidate.get("wake_task_id")
    )
    resume_rendered = False
    if dry_run:
        persona = None
    else:
        persona_result = services._build_persona(
            api_base,
            candidate["agent_id"],
            task_id=run_task_id,
            self_wake={
                "injected": candidate.get("self_wake_injected"),
                "task_id": candidate.get("self_wake_task_id"),
            },
            return_resume_rendered=True,
        )
        if isinstance(persona_result, tuple):
            persona, resume_rendered = persona_result
        else:
            persona = persona_result

    headless_cwd = candidate.get("headless_cwd")
    log_path = None
    if headless_cwd and not dry_run:
        log_path = (
            services.pathlib.Path(headless_cwd)
            / ".claude"
            / ".orcha-wakes"
            / f"{candidate.get('alias', 'agent')}-{int(time.time())}.log"
        )
    worktree, branch, task_worktree = _worktree_for(
        candidate, auto_tasks, live_workers, dry_run, services
    )
    run_cwd = worktree or headless_cwd
    git_checker = getattr(services, "_is_git_repo", None)
    shared_git_checkout = False
    if not worktree and run_cwd and callable(git_checker):
        try:
            shared_git_checkout = bool(git_checker(run_cwd))
        except (OSError, TypeError, ValueError):
            shared_git_checkout = False
    if not dry_run and shared_git_checkout and live_workers is None:
        # ``notifier --once`` cannot retain a run row or reconcile a stopped
        # shared-main writer, so refuse before routing mutates the checkout.
        guidance = (
            "A one-shot notifier cannot safely track a shared-checkout writer "
            "through completion. Run the notifier daemon or enable worktrees; "
            "no files were routed and no worker was started."
        )
        services._post_json(
            f"{api_base}/api/agents/{candidate['agent_id']}/wake-ack",
            {
                "kind": "worker_checkout_tracking_unavailable",
                "release_lease": True,
                "lane": lane,
            },
        )
        return {
            "sent": False,
            "command": "checkout tracking unavailable",
            "resume_rendered": resume_rendered,
            "lane": lane,
            "handoff_failed": True,
            "handoff_code": "checkout_activity_tracking_unavailable",
            "handoff_guidance": guidance,
        }
    preparation = None
    handoff = None
    checkout_activity = None
    if not dry_run:
        preparation = prepare_checkout_start(
            api_base,
            candidate["agent_id"],
            run_cwd,
            services,
            shared_checkout=shared_git_checkout,
            task_id=run_task_id,
            lane="work",
            require_taskless=run_task_id is None,
            local_workers=live_workers,
        )
        handoff = preparation.handoff
        checkout_activity = preparation.activity
    carried = dry_run or bool(handoff)
    if not carried:
        handoff_code = getattr(handoff, "code", "handoff_failed")
        handoff_guidance = getattr(
            handoff,
            "guidance",
            "Orcha could not prove a safe checkout handoff; both checkouts were preserved.",
        )
        if run_task_id and _due(
            _HANDOFF_FAILURE_NOTICE_TS,
            (candidate["agent_id"], run_task_id),
            HANDOFF_FAILURE_NOTICE_INTERVAL_SECS,
        ):
            services._post_json(
                f"{api_base}/api/tasks/{run_task_id}/messages",
                {
                    "author_agent_id": candidate["agent_id"],
                    "body": (
                        "Run start paused because Orcha could not safely carry the "
                        "saved files into the checkout selected by the project setting. "
                        "Both checkouts remain preserved, and no worker was started. "
                        f"{handoff_guidance} "
                        f"Orcha retries every {int(HANDOFF_FAILURE_HOLD_SECS // 60)} "
                        "minutes unless the project owner resolves the saved-state conflict."
                    ),
                },
            )
        services._post_json(
            f"{api_base}/api/agents/{candidate['agent_id']}/wake-ack",
            {
                "kind": "worker_routing_handoff_failed",
                "release_lease": True,
                "lane": lane,
            },
        )
        # Taskless wakes provision a fresh disposable checkout before routing
        # can be inspected. Retire a still-clean destination when the handoff
        # fails; safe teardown preserves it if any file unexpectedly changed.
        if worktree and not task_worktree:
            services._safe_teardown_worktree(headless_cwd, worktree, branch)
        if not quiet:
            print(
                f"[notifier] wake for {candidate.get('alias')} paused: saved files "
                "could not be carried into the selected checkout",
                file=sys.stderr,
            )
        return {
            "sent": False,
            "command": "checkout handoff failed",
            "resume_rendered": resume_rendered,
            "lane": lane,
            "handoff_failed": True,
            "handoff_code": handoff_code,
            "handoff_guidance": handoff_guidance,
        }
    if not dry_run:
        try:
            _advise_shared_checkout(
                api_base, candidate, run_task_id, live_workers, services
            )
        except Exception:
            # No child exists yet, so this reservation can be archived safely.
            if checkout_activity is not None:
                services._release_checkout_activity(
                    run_cwd, activity=checkout_activity
                )
            raise
    try:
        token = (
            None
            if dry_run
            else services._mint_embodiment_token(
                api_base, candidate["agent_id"], lane, "headless"
            )
        )
    except Exception:
        if checkout_activity is not None:
            services._release_checkout_activity(
                run_cwd, activity=checkout_activity
            )
        raise
    _spawn_info: dict = {}
    try:
        sent, command, process = services.spawn_headless(
            run_cwd,
            prompt,
            candidate.get("headless_flags"),
            dry_run,
            alias=candidate.get("alias"),
            system_prompt=persona,
            model=candidate.get("model"),
            reasoning_effort=candidate.get("reasoning_effort"),
            runtime=candidate.get("model_runtime"),
            log_path=log_path,
            run_token=token,
            conversation=False,
            spawn_info=_spawn_info,
            checkout_activity=checkout_activity,
        )
    except Exception:
        # A transport exception may occur after it created a child but before it
        # returned the process handle. Keep the durable reservation in place;
        # releasing it here would permit an untracked concurrent writer.
        services._revoke_or_defer(api_base, token)
        raise
    if sent and process is not None and checkout_activity is not None:
        try:
            bound = services._bind_checkout_activity(
                checkout_activity,
                pid=getattr(process, "pid", None),
                sandbox_container_id=_spawn_info.get("sandbox_container_id"),
            )
        except Exception:
            bound = False
        if not bound:
            evidence = _stop_unregistered_worker(
                api_base,
                candidate,
                process=process,
                token=token,
                worktree=worktree,
                branch=branch,
                task_worktree=task_worktree,
                run_task_id=run_task_id,
                log_path=log_path,
                sandbox_container_id=_spawn_info.get("sandbox_container_id"),
                services=services,
            )
            if evidence is not None and bool(evidence):
                services._release_checkout_activity(
                    run_cwd, activity=checkout_activity
                )
            return {
                "sent": False,
                "command": command,
                "resume_rendered": resume_rendered,
                "lane": lane,
                "run_registration_failed": True,
                "handoff_code": "checkout_activity_bind_failed",
            }
    # Issue #75: the box-wide concurrency cap deferred this spawn (ground-truth count
    # ≥ budget at decision time). NOT a failure — release everything we speculatively
    # claimed (lease, worktree) so the candidate re-competes cleanly on a later tick in
    # the SAME server-side ORDER BY created_at order (oldest agent first = fairness, no
    # starvation), and log the cap ONCE for this deferral (per tick, not per second).
    if _spawn_info.get("deferred"):
        if checkout_activity is not None:
            services._release_checkout_activity(
                run_cwd, activity=checkout_activity
            )
        if worktree:
            services._safe_teardown_worktree(headless_cwd, worktree, branch)
        if not dry_run:
            services._revoke_or_defer(api_base, token)
        if not quiet:
            print(
                f"[notifier] cap-deferred wake for {candidate.get('alias')}: "
                f"{command} — stays eligible next tick"
            )
        return None
    if sent and process is not None and live_workers is not None:
        _run_payload = {
            "wake_kind": "ephemeral",
            "wake_event": event,
            "task_id": run_task_id,
            "log_path": str(log_path) if log_path else None,
            "pid": getattr(process, "pid", None),
            "runtime": candidate.get("model_runtime"),
            "worktree": worktree,
            "branch": branch,
            "base_cwd": headless_cwd,
            "lane": lane,
            "token_id": token,
        }
        # Remote-runner §3.3c: a sandbox wake stamps its container name (and wake_kind)
        # so re-adoption by label + container-runtime metering work off the run row.
        if _spawn_info.get("sandbox_container_id"):
            _run_payload["sandbox_container_id"] = _spawn_info["sandbox_container_id"]
            _run_payload["wake_kind"] = "sandbox"
        try:
            run = services._post_json(
                f"{api_base}/api/agents/{candidate['agent_id']}/runs",
                _run_payload,
            )
        except Exception:
            evidence = _stop_unregistered_worker(
                api_base,
                candidate,
                process=process,
                token=token,
                worktree=worktree,
                branch=branch,
                task_worktree=task_worktree,
                run_task_id=run_task_id,
                log_path=log_path,
                sandbox_container_id=_spawn_info.get("sandbox_container_id"),
                services=services,
            )
            if (
                checkout_activity is not None
                and evidence is not None
                and bool(evidence)
            ):
                services._release_checkout_activity(
                    run_cwd, activity=checkout_activity
                )
            raise
        run_id = (run or {}).get("run_id")
        if not run_id:
            evidence = _stop_unregistered_worker(
                api_base,
                candidate,
                process=process,
                token=token,
                worktree=worktree,
                branch=branch,
                task_worktree=task_worktree,
                run_task_id=run_task_id,
                log_path=log_path,
                sandbox_container_id=_spawn_info.get("sandbox_container_id"),
                services=services,
            )
            if (
                checkout_activity is not None
                and evidence is not None
                and bool(evidence)
            ):
                services._release_checkout_activity(
                    run_cwd, activity=checkout_activity
                )
            if not quiet:
                print(
                    f"[notifier] worker start for {candidate.get('alias')} stopped: "
                    "the durable run record could not be created; files preserved "
                    f"(safety evidence {getattr(evidence, 'code', 'unavailable')})",
                    file=sys.stderr,
                )
            return {
                "sent": False,
                "command": command,
                "resume_rendered": resume_rendered,
                "lane": lane,
                "run_registration_failed": True,
                "handoff_code": getattr(evidence, "code", None),
            }
        activity_bound = True
        if checkout_activity is not None:
            try:
                activity_bound = services._bind_checkout_activity(
                    checkout_activity,
                    run_id=run_id,
                    pid=getattr(process, "pid", None),
                    sandbox_container_id=_spawn_info.get("sandbox_container_id"),
                )
            except Exception:
                activity_bound = False
        if not activity_bound:
            # The run row exists, so keep it as the durable recovery identity.
            # Stop the process and leave both the row and reservation registered;
            # the ordinary reaper will snapshot, archive, and release them.  A
            # notifier crash in this branch therefore remains fail-closed.
            services._kill_worker(process, graceful=True)
            live_workers[candidate["agent_id"]] = _worker_state(
                candidate,
                process=process,
                run_id=run_id,
                log_path=log_path,
                worktree=worktree,
                branch=branch,
                task_worktree=task_worktree,
                cap=cap,
                event=event,
                run_task_id=run_task_id,
                token=token,
                prompt=prompt,
                sandbox_container_id=_spawn_info.get("sandbox_container_id"),
                checkout_activity=checkout_activity,
            )
            return {
                "sent": False,
                "command": command,
                "resume_rendered": resume_rendered,
                "lane": lane,
                "run_registration_failed": True,
                "handoff_code": "checkout_activity_bind_failed",
            }
        live_workers[candidate["agent_id"]] = _worker_state(
            candidate,
            process=process,
            run_id=run_id,
            log_path=log_path,
            worktree=worktree,
            branch=branch,
            task_worktree=task_worktree,
            cap=cap,
            event=event,
            run_task_id=run_task_id,
            token=token,
            prompt=prompt,
            sandbox_container_id=_spawn_info.get("sandbox_container_id"),
            checkout_activity=checkout_activity,
        )
    elif worktree and not sent:
        services._safe_teardown_worktree(headless_cwd, worktree, branch)
        services._revoke_or_defer(api_base, token)
    elif not sent and not dry_run:
        if checkout_activity is not None:
            services._release_checkout_activity(
                run_cwd, activity=checkout_activity
            )
        services._revoke_or_defer(api_base, token)
    return {
        "sent": sent,
        "command": command,
        "resume_rendered": resume_rendered,
        "lane": lane,
    }
