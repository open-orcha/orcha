"""Grade, deliver, and acknowledge one notifier wake candidate."""

from __future__ import annotations

from . import notifier_wake_worker


def _skipped_record(candidate, event, *, command, tier):
    """Describe a candidate handled without a full worker boot."""
    return {
        "agent_id": candidate["agent_id"],
        "alias": candidate["alias"],
        "kind": "skipped",
        "sent": False,
        "command": command,
        "reason": candidate["reason"],
        "pending_events": candidate.get("pending_events"),
        "auto_start_task_ids": candidate.get("auto_start_task_ids"),
        "event": event,
        "suppressed": tier,
    }


def _grade_ephemeral(api_base, candidate, event, context, quiet, services):
    """Return a skipped result when grading can safely avoid a full boot."""
    verdict = services.decide_wake_tier(
        candidate, triage_fn=context["triage"]
    )
    tier = verdict.get("tier")
    if tier in ("structural", "llm"):
        services._suppress_wake(
            api_base, candidate, event, verdict, quiet=quiet
        )
        if not quiet:
            print(
                f"[notifier] suppressed wake for {candidate['alias']} "
                f"({tier}: {verdict.get('reason', '')}) — no spawn"
            )
        return _skipped_record(
            candidate,
            event,
            command=f"suppressed ({tier}): {verdict.get('reason', '')}",
            tier=tier,
        )
    if tier != "act":
        return None
    acted = (
        services._apply_wake_act(
            api_base,
            candidate,
            event,
            verdict,
            quiet=quiet,
            ack_config=context["ack_config"],
            ack_api_key=context["ack_key"],
        )
        if context["t2_enabled"]
        else False
    )
    services._log_graded_wake(
        verdict, context["autonomy_level"], acted
    )
    if not acted:
        return None
    if not quiet:
        print(
            f"[notifier] T2 cheap-act for {candidate['alias']} "
            f"({verdict.get('action')}) — no spawn"
        )
    return _skipped_record(
        candidate,
        event,
        command=f"acted (T2 {verdict.get('action')}) — no spawn",
        tier="act",
    )


def _ack_delivery(
    api_base,
    candidate,
    *,
    kind,
    event,
    sent,
    lane,
    resume_rendered,
    live_workers,
    services,
):
    """Advance only events actually handled by this delivery path."""
    ephemeral_reaped = (
        kind == "ephemeral"
        and sent
        and live_workers is not None
        and candidate["agent_id"] in live_workers
    )
    if sent and not ephemeral_reaped and candidate.get("pending_events"):
        services._post_json(
            f"{api_base}/api/agents/{candidate['agent_id']}"
            "/events/ack-handled",
            {"event_ids": candidate.get("handled_event_ids") or []},
        )
    release_lease = kind == "ephemeral" and not sent
    ack_kind = (
        kind
        if sent
        else (f"{kind}_failed" if kind != "unreachable" else "unreachable")
    )
    body = {
        "delivered_ts": None,
        "kind": ack_kind,
        "event": event,
        "release_lease": release_lease,
        "lane": lane,
    }
    body.update(
        services.self_wake_ack_fields(
            candidate,
            kind=kind,
            sent=sent,
            resume_rendered=resume_rendered,
        )
    )
    services._post_json(
        f"{api_base}/api/agents/{candidate['agent_id']}/wake-ack", body
    )


def _held(candidate, context, quiet):
    """Apply and eventually clear an agent's rate-limit hold-down."""
    agent_id = candidate.get("agent_id")
    hold = context["agent_hold_until"].get(agent_id)
    if hold is None:
        return False
    if context["hold_now"] < hold:
        if not quiet:
            remaining = hold - context["hold_now"]
            print(
                f"[notifier] skip {candidate.get('alias')} "
                f"— rate-limit hold-down ({remaining:.0f}s left)"
            )
        return True
    context["agent_hold_until"].pop(agent_id, None)
    return False


def process_candidate(
    api_base,
    candidate,
    *,
    context,
    dry_run,
    quiet,
    lease_ttl,
    live_workers,
    services,
):
    """Process one eligible candidate, returning its public wake record."""
    if not candidate.get("should_wake") or _held(candidate, context, quiet):
        return None
    prompt = services.build_wake_prompt(candidate)
    kind = services.select_transport(candidate)
    event = services.derive_wake_event(candidate)
    if kind == "ephemeral" and not dry_run:
        skipped = _grade_ephemeral(
            api_base, candidate, event, context, quiet, services
        )
        if skipped is not None:
            return skipped

    resume_rendered = False
    lane = "work"
    if kind == "tmux":
        sent, command = services.send_tmux(
            candidate["tmux_target"], prompt, dry_run
        )
    elif kind == "ephemeral":
        spawned = notifier_wake_worker.spawn(
            api_base,
            candidate,
            prompt=prompt,
            event=event,
            dry_run=dry_run,
            quiet=quiet,
            lease_ttl=lease_ttl,
            live_workers=live_workers,
            services=services,
        )
        if spawned is None:
            return None
        sent = spawned["sent"]
        command = spawned["command"]
        resume_rendered = spawned["resume_rendered"]
        lane = spawned["lane"]
    else:
        sent = False
        command = "(no tmux pane / headless cwd recorded — unreachable)"

    record = {
        "agent_id": candidate["agent_id"],
        "alias": candidate["alias"],
        "kind": kind,
        "sent": sent,
        "command": command,
        "reason": candidate["reason"],
        "pending_events": candidate.get("pending_events"),
        "auto_start_task_ids": candidate.get("auto_start_task_ids"),
        "event": event,
    }
    if not quiet:
        tag = (
            "DRY-RUN would wake"
            if dry_run
            else ("woke" if sent else f"could not wake ({kind})")
        )
        print(
            f"[notifier] {tag} {candidate['alias']} "
            f"via {kind}: {candidate['reason']}"
        )
        if dry_run:
            print(f"             → {command}")
    if not dry_run:
        _ack_delivery(
            api_base,
            candidate,
            kind=kind,
            event=event,
            sent=sent,
            lane=lane,
            resume_rendered=resume_rendered,
            live_workers=live_workers,
            services=services,
        )
    return record
