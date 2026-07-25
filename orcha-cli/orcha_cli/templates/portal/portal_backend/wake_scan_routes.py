"""Expose the notifier's read-only wake discovery scan."""

from fastapi import HTTPException, Query

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.model_setting_routes import _resolve_use_case_model
from portal_backend.provider_keys import effective_use_case_provider, provider_key_enc
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
    with db_cursor() as (_, cur):
        container = require_container(cur, cid)
        cur.execute(
            "SELECT wakes_enabled, autonomy_level FROM containers WHERE id=%s", (cid,)
        )
        settings = cur.fetchone()
        wakes_enabled = bool(settings["wakes_enabled"])
        triage_model = _resolve_use_case_model(cur, cid, "triage")
        ack_model = _resolve_use_case_model(cur, cid, "ack")
        triage_key_enc = provider_key_enc(
            cur, cid, effective_use_case_provider(triage_model, "triage")
        )
        ack_key_enc = provider_key_enc(
            cur, cid, effective_use_case_provider(ack_model, "ack")
        )
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
            )
            for agent in list_wake_agents(cur, cid, cooldown)
        ]
    return {
        "container_id": cid,
        "container_status": container["status"],
        "active": container["status"] == "active",
        "wakes_enabled": wakes_enabled,
        "autonomy_level": settings["autonomy_level"],
        "triage_model": triage_model,
        "triage_key_enc": triage_key_enc,
        "ack_key_enc": ack_key_enc,
        "ack_model": ack_model,
        "candidates": candidates,
    }
