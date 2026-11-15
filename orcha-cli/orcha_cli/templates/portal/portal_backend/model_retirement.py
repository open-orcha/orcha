"""Persist explicit model retirements only when no launch or worker owns the agent.

The graph lock serializes this with wake claims, run registration and Workflow
reservation. Reads from a browser do not call this maintenance hook. Callers own
the transaction; the saved preference, history and audit commit together.
"""

from portal_backend import sql
from portal_backend.agent_config_history_routes import config_before, record_config_change
from portal_backend.agent_status import log_event
from portal_backend.model_policy import (
    DEFAULT_MODEL, RETIRED_MODEL_IDS, resolve_model, resolve_model_runtime, resolve_reasoning_effort,
)
from portal_backend.workflow_service import lock_container_graph


def migrate_retired_models(cur, cid, *, agent_id=None, admitting_execution_id=None):
    """Return migrated IDs. Busy agents stay pending until the next idle boundary."""
    extra = " AND id=%s" if agent_id else ""
    params = (cid, sql.list_param(RETIRED_MODEL_IDS)) + ((agent_id,) if agent_id else ())
    cur.execute(
        f"SELECT id FROM agents WHERE container_id=%s AND {sql.in_list('model')} "
        "AND kind='ai' AND terminated_at IS NULL" + extra + " ORDER BY id", params,
    )
    pending = cur.fetchall()
    if not pending:
        return []
    lock_container_graph(cur, cid)
    cur.execute("SELECT status FROM containers WHERE id=%s", (cid,))
    if cur.fetchone()["status"] != "active":
        return []
    migrated = []
    for row in pending:
        aid = str(row["id"])
        before = config_before(cur, aid)
        if not before or before["model"] not in RETIRED_MODEL_IDS:
            continue  # another serialized caller already migrated or selected a model
        cur.execute(
            "SELECT 1 FROM worker_runs WHERE agent_id=%s "
            "AND status IN ('running','reserved') LIMIT 1", (aid,),
        )
        if cur.fetchone():
            continue
        # A lease can represent a process being launched but not yet registered,
        # or a warm/live terminal that has no in-flight turn row. Protect both lanes.
        cur.execute(
            "SELECT 1 FROM agent_wake_state WHERE agent_id=%s "
            "AND (wake_lease_until > now() OR conv_lease_until > now())", (aid,),
        )
        if cur.fetchone():
            continue
        execution_filter = " AND id<>%s" if admitting_execution_id else ""
        cur.execute(
            "SELECT 1 FROM workflow_executions WHERE claimant_id=%s "
            "AND worker_stopped_at IS NULL "
            "AND state IN ('reserved','running','awaiting_review','stopping','recovery_needed')"
            + execution_filter + " LIMIT 1",
            (aid,) + ((admitting_execution_id,) if admitting_execution_id else ()),
        )
        if cur.fetchone():
            continue  # a terminal run status alone cannot prove this worker stopped
        effort = resolve_reasoning_effort(before["reasoning_effort"], DEFAULT_MODEL)
        cur.execute("UPDATE agents SET model=%s,reasoning_effort=%s WHERE id=%s", (DEFAULT_MODEL, effort, aid))
        # Only current idle pins change. Closed conversations and every historical
        # run, output, token count and cost remain untouched.
        cur.execute(
            "UPDATE conversations SET session_id=NULL WHERE agent_id=%s "
            "AND status='active' AND session_id IS NOT NULL RETURNING id", (aid,),
        )
        cold_reset = [str(c["id"]) for c in cur.fetchall()]
        record_config_change(cur, aid, before, source="model_retired")
        log_event(cur, cid, "system", None, "agent", aid, "model_changed", {
            "model": DEFAULT_MODEL, "previous_model": before["model"],
            "reason": "model_retired", "reasoning_effort": effort,
            "previous_reasoning_effort": before["reasoning_effort"],
            "cold_reset_conversations": cold_reset,
        })
        migrated.append(aid)
    return migrated


def launch_model_state(cur, aid):
    """Fresh launch selection, including a cold boot when an old pin is unusable."""
    cur.execute("SELECT kind,model,reasoning_effort FROM agents WHERE id=%s", (aid,))
    agent = cur.fetchone()
    if agent["kind"] == "human":
        return {}  # live terminals for people retain their existing no-model behavior
    model = resolve_model(agent["model"])
    cur.execute("SELECT session_id FROM conversations WHERE agent_id=%s AND status='active'", (aid,))
    sessions = cur.fetchall()
    return {
        "model": model, "model_runtime": resolve_model_runtime(model),
        "reasoning_effort": resolve_reasoning_effort(agent["reasoning_effort"], model),
        "cold_required": agent["model"] in RETIRED_MODEL_IDS or not any(c["session_id"] for c in sessions),
    }
