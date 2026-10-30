"""Exact-run checks for managed writes; a generic work token is insufficient.

Callers own the transaction. These checks grant no detached-process authority:
that requires the supervisor's separately confirmed, finite deadline. In
particular a successful message poll must never be treated as lease renewal.
"""

from fastapi import HTTPException

from portal_backend import sql
from portal_backend.task_autonomy_service import task_completion_blockers
from portal_backend.worker_auth import require_work_lane
from portal_backend.workflow_evidence_service import _lock_context
from portal_backend.workflow_service import lock_container_graph
from portal_backend.workflow_worker_auth import require_current_generation


def conflict(code):
    raise HTTPException(409, {"code": code, "message": code.replace("_", " ")})


def lock_agent_runs(cur, aid, lane):
    """Graph -> workflow/task/execution/run -> lane, shared with lifecycle writes."""
    cur.execute("SELECT container_id FROM agents WHERE id=%s", (aid,))
    agent = cur.fetchone()
    if not agent:
        raise HTTPException(404, "Agent not found")
    lock_container_graph(cur, agent["container_id"])
    cur.execute("SELECT run_id FROM worker_runs WHERE agent_id=%s AND lane=%s "
                "AND status='running' ORDER BY run_id", (aid, lane))
    runs = [_lock_context(cur, row["run_id"])[0] for row in cur.fetchall()]
    cur.execute("SELECT * FROM agent_wake_state WHERE agent_id=%s" + sql.for_update(), (aid,))
    return runs, cur.fetchone()


def require_managed_run(cur, tid, token, request, *, allow_lapsed=False, enrol=True, allow_frozen=False):
    if not token:
        raise HTTPException(403, "work-lane token required")
    cur.execute("SELECT * FROM embodiment_tokens WHERE run_token=%s", (token,))
    binding = cur.fetchone()
    if not binding or binding["revoked_at"] or binding["lane"] != "work":
        raise HTTPException(403, "active work-lane token required")
    if not binding["run_id"]:
        conflict("run_binding_pending")
    run, task, execution = _lock_context(cur, binding["run_id"])
    aid = str(binding["agent_id"])
    cur.execute("SELECT * FROM agent_wake_state WHERE agent_id=%s" + sql.for_update(), (aid,))
    lane = cur.fetchone()
    cur.execute("SELECT * FROM embodiment_tokens WHERE run_token=%s" + sql.for_update(), (token,))
    current = cur.fetchone()
    if (not current or current["revoked_at"] or current["lane"] != "work"
            or str(current["run_id"]) != str(run["run_id"])
            or str(current["agent_id"]) != str(run["agent_id"])):
        raise HTTPException(403, "worker token no longer owns this run")
    if (run["status"] != "running" or run["lane"] != "work"
            or not task or str(task["id"]) != tid):
        conflict("worker_no_longer_owns_task")
    if run["wake_kind"] not in {"ephemeral", "sandbox"} and not (
            run["wake_kind"] == "workflow" and task.get("workflow_id") and execution):
        conflict("managed_commands_require_one_shot_worker")
    require_work_lane(cur, aid, token, request)
    cur.execute("SELECT a.terminated_at,a.container_id,c.status AS container_status "
                "FROM agents a JOIN containers c ON c.id=a.container_id WHERE a.id=%s", (aid,))
    agent = cur.fetchone()
    if (agent["terminated_at"] or agent["container_status"] != "active"
            or str(agent["container_id"]) != str(task["container_id"])):
        conflict("worker_project_unavailable")
    if run["stop_requested_at"]:
        conflict("worker_stop_requested")
    blockers = task_completion_blockers(task)
    if task.get("human_hold_by") or task.get("awaiting_loop_decision"):
        conflict("task_on_hold")
    if blockers:
        conflict(blockers[0])
    cur.execute("SELECT 1 FROM agent_tasks WHERE task_id=%s AND agent_id=%s "
                "AND assignment_status IN ('assigned','accepted','working')", (tid, aid))
    if not cur.fetchone():
        conflict("worker_task_unassigned")
    if task.get("workflow_id"):
        require_current_generation(cur, aid, token, tid)
        cur.execute("SELECT status FROM workflows WHERE id=%s", (task["workflow_id"],))
        if cur.fetchone()["status"] != "active" or execution["state"] != "running":
            conflict("workflow_work_on_hold")
    elif not lane or str(lane["work_run_id"]) != str(run["run_id"]):
        conflict("worker_lane_owner_changed")
    elif not lane["wake_lease_until"] or (not allow_lapsed and lane["wake_lease_until"] <= sql.utcnow()):
        conflict("worker_lease_lapsed")
    elif lane["lease_kind"] != "ephemeral":
        conflict("managed_commands_require_one_shot_worker")
    # Enrol old one-shot launchers on first managed use. From here on a header-less
    # alias-only scheduling call cannot release or extend this managed lane.
    # Once published, fixed caps also fence receipts and other managed effects.
    cur.execute("SELECT * FROM managed_run_limits WHERE run_id=%s", (run["run_id"],))
    limits = cur.fetchone()
    if limits and limits["controls_frozen"] and not allow_frozen:
        conflict("managed_worker_controls_frozen")
    if limits and min(d for d in (limits["run_until"], limits["sandbox_until"]) if d) <= sql.utcnow():
        conflict("worker_runtime_limit_reached")
    if enrol and not run["managed_commands"]:
        cur.execute("UPDATE worker_runs SET managed_commands=true WHERE run_id=%s", (run["run_id"],))
    return run, task


def scheduling_run_matches(cur, runs, lane_row, lane, run_id, *, allow_terminal=False):
    column = "conv_run_id" if lane == "conversation" else "work_run_id"
    owner = lane_row.get(column) if lane_row else None
    if run_id is not None:
        if str(owner) != str(run_id):
            return False
        if allow_terminal:
            return True  # finishing precedes lease release in the notifier
        return len(runs) == 1 and str(runs[0]["run_id"]) == str(run_id)
    if owner:
        cur.execute("SELECT managed_commands FROM worker_runs WHERE run_id=%s", (owner,))
        current = cur.fetchone()
        if current and current["managed_commands"]:
            return False
    return not any(run["managed_commands"] for run in runs)
