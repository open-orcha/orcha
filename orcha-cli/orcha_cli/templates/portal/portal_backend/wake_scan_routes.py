"""Expose the notifier's read-only wake discovery scan."""

from fastapi import HTTPException, Query, Request

from portal_backend.application import app
from portal_backend.budget_routes import apply_budget_gate
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.identity_routes import proxy_login, require_member_read
from portal_backend.model_setting_routes import _resolve_use_case_model
from portal_backend.provider_keys import (
    agent_keys_enc,
    effective_use_case_provider,
    provider_key_enc,
)
from portal_backend.wake_backoff import apply_wake_backoff
from portal_backend.wake_candidate_builder import build_wake_candidate
from portal_backend.wake_scan_queries import list_wake_agents

_compatibility = None


def configure_compatibility(**interfaces):
    """Bind facade-owned compatibility seams used while building candidates."""
    global _compatibility
    _compatibility = interfaces


@app.get("/api/containers/{cid}/wake-scan")
def wake_scan(
    cid: str,
    request: Request,
    cooldown: float = Query(default=15.0, ge=0),
    min_idle: float = Query(default=30.0, ge=0),
):
    """Epic A: the notifier daemon's read-only scan — who needs an out-of-band wake.

    The wake DECISION lives here (server-side, single source of truth, testable via
    the API), so the host-side daemon stays a thin transport executor and the
    design invariant 'only the API touches the DB' holds. For every AI agent it
    reports pending unacked events, assigned-and-ready tasks (auto-start targets),
    reachability, and a `should_wake` verdict with the inputs behind it.

    should_wake = wake_enabled AND container active AND (pending events OR an
    assigned ready task OR a clock-driven auto-wake is due) AND the agent looks idle
    (heartbeat older than `min_idle`, or never beat) AND it isn't inside the per-agent
    `cooldown` window. Wakes are fully suppressed while the container is paused
    (respects /orcha-pause). #266: the auto-wake term is per-agent opt-in
    (auto_wake_interval_secs, NULL=off) and fires off the last_woken_at clock — see the
    auto_wake_due computation below. (GH#39 removed the turns_used<turn_budget gate.)
    """
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        container = require_container(cur, cid)
        # PS-08: project isolation before ANY write/read (the scan stamps + fires notices).
        require_member_read(cur, request, cid)
        # PS-38: only the header-less daemon poll counts as "the wake service". A
        # browser (trusted login) read is a pure preview: it never stamps
        # last_wake_scan_at (that would fake the 'Running' signal) and never commits
        # the backoff bookkeeping below.
        browser = proxy_login(request) is not None
        # Multi-project (mig 037): stamp the notifier's poll, so the portal knows WHICH
        # container a host-side daemon actually serves (containers.last_wake_scan_at —
        # the project switcher's honest wakes-capability signal). Only the daemon calls
        # this endpoint on a cadence. Throttled to one write/15s (and committed alone,
        # before the read work below) so the scan stays effectively read-only.
        if not browser:
            cur.execute(
                """UPDATE containers SET last_wake_scan_at = now()
                    WHERE id=%s AND (last_wake_scan_at IS NULL
                                     OR last_wake_scan_at < now() - interval '15 seconds')""",
                (cid,),
            )
            if cur.rowcount:
                conn.commit()
        cur.execute(
            "SELECT wakes_enabled, autonomy_level, autonomy_enforced, worktrees_disabled "
            "FROM containers WHERE id=%s",
            (cid,),
        )
        settings = cur.fetchone()
        wakes_enabled = bool(settings["wakes_enabled"])
        autonomy_enforced = bool(settings["autonomy_enforced"])
        triage_model = _resolve_use_case_model(cur, cid, "triage")
        ack_model = _resolve_use_case_model(cur, cid, "ack")
        triage_key_enc = provider_key_enc(
            cur, cid, effective_use_case_provider(triage_model, "triage")
        )
        ack_key_enc = provider_key_enc(
            cur, cid, effective_use_case_provider(ack_model, "ack")
        )
        # Agent runs on an API key (migration 071): the sealed key per agent runtime whose
        # provider key is opted in (use_for_agents); None = leave the worker on its subscription.
        agent_key_blobs = agent_keys_enc(cur, cid)
        candidates = [
            build_wake_candidate(
                cur,
                agent,
                cid,
                container["status"],
                wakes_enabled,
                min_idle,
                collect_directed_messages=_compatibility["collect_directed_messages"],
                earliest_actionable_answer_ts=_compatibility[
                    "earliest_actionable_answer_ts"
                ],
                notification_manifest=_compatibility["notification_manifest"],
                triage_hint_for=_compatibility["triage_hint_for"],
                valid_uuid=valid_uuid,
                resolve_model=_compatibility["resolve_model"],
                resolve_model_runtime=_compatibility["resolve_model_runtime"],
                container_autonomy_level=settings["autonomy_level"],
                container_autonomy_enforced=autonomy_enforced,
                worktrees_disabled=settings["worktrees_disabled"],
            )
            for agent in list_wake_agents(cur, cid, cooldown)
        ]
        # Budget hard stop (budget_routes): a paused agent keeps its candidate but loses
        # should_wake, so the daemon starts no NEW run. Never touches in-flight work.
        candidates = apply_budget_gate(cur, cid, candidates)
        # No-progress wake circuit breaker (server-side, DB-backed — see wake_backoff.py):
        # strike-account each should_wake candidate against its agent's own recent completed
        # runs, suppress a candidate whose trigger keeps firing with no progress, and surface it
        # to the human once suppression gets serious. NEVER cancels work or touches task state —
        # only paces the wake cadence. Runs on this same cursor so its writes land in the same
        # commit as the scan's own bookkeeping below.
        candidates = apply_wake_backoff(cur, cid, candidates)
        if browser:
            conn.rollback()  # PS-38: a browser read leaves no trace
        else:
            conn.commit()
    return {
        "container_id": cid,
        "container_status": container["status"],
        "active": container["status"] == "active",
        "wakes_enabled": wakes_enabled,
        "autonomy_level": settings["autonomy_level"],
        "autonomy_enforced": autonomy_enforced,
        "worktrees_disabled": bool(settings["worktrees_disabled"]),
        "triage_model": triage_model,
        # PS-08: the sealed provider keys are for the host daemon (header-less lane) only;
        # never hand ciphertext to a browser session, member or not.
        "triage_key_enc": None if browser else triage_key_enc,
        "ack_key_enc": None if browser else ack_key_enc,
        # Same discipline: ciphertext, header-less daemon lane only. The daemon opens it in memory
        # at spawn time and puts it in the agent subprocess env (never logs it).
        "agent_keys_enc": (
            {runtime: None for runtime in agent_key_blobs} if browser else agent_key_blobs
        ),
        "ack_model": ack_model,
        "candidates": candidates,
    }
