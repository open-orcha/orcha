"""Reservation ownership and liveness, including refused late worker requests."""

from portal_backend import sql
from portal_backend.workflow_graph import conflict
from portal_backend.workflow_service import WorkflowService, lock_container_graph


def lock_run(cur, run_id):
    """Discover first, then acquire the common graph -> workflow -> task -> turn order."""
    cur.execute("SELECT execution_id FROM workflow_launch_permits WHERE run_id=%s", (run_id,))
    permit = cur.fetchone()
    if not permit:
        conflict("workflow_run_unavailable", "Workflow worker not found.", status=404)
    cur.execute("SELECT workflow_id,task_id FROM workflow_executions WHERE id=%s", (permit["execution_id"],))
    ids = cur.fetchone()
    service = WorkflowService(cur)
    workflow = service.lock(str(ids["workflow_id"]))
    task = service.task(str(ids["workflow_id"]), str(ids["task_id"]))
    cur.execute("SELECT * FROM workflow_executions WHERE id=%s" + sql.for_update(), (permit["execution_id"],))
    return workflow, task, cur.fetchone()


def token_execution(cur, token):
    if not token:
        return None
    cur.execute("""SELECT et.run_id,et.agent_id,et.revoked_at,p.generation,p.execution_id
                   FROM embodiment_tokens et JOIN workflow_launch_permits p ON p.run_id=et.run_id
                   WHERE et.run_token=%s AND et.lane='work'""", (token,))
    return cur.fetchone()


def record_runner_contact(cur, token, *, now=None):
    """Call in a separately committed middleware transaction before route rejection.

    A known revoked token still proves contact with its own generation. Once a new
    generation exists, an earlier process cannot extend that successor's deadline.
    """
    binding = token_execution(cur, token)
    if not binding:
        return None
    workflow, task, execution = lock_run(cur, binding["run_id"])
    if (execution["generation"] == binding["generation"]
            and str(execution.get("run_id")) == str(binding["run_id"])
            and execution["state"] not in {"released", "released_lost", "aborted"}):
        now = now or sql.utcnow()
        cur.execute("""UPDATE workflow_executions SET last_runner_contact_at=%s WHERE id=%s
                       AND (last_runner_contact_at IS NULL OR last_runner_contact_at<%s)""", (now, execution["id"], now))
    return {"binding": binding, "workflow": workflow, "task": task, "execution": execution}


def require_current_generation(cur, aid, token, task_id=None):
    binding = token_execution(cur, token)
    if not binding or str(binding["agent_id"]) != str(aid):
        conflict("workflow_reservation_required", "Workflow work needs an activated reservation.", status=403)
    workflow, task, execution = lock_run(cur, binding["run_id"])
    if (binding["revoked_at"] or execution["generation_revoked_at"]
            or execution["generation"] != binding["generation"]
            or str(execution.get("run_id")) != str(binding["run_id"])
            or execution["state"] not in {"running", "awaiting_review"}
            or execution["worker_stopped_at"]
            or workflow["status"] not in {"active", "paused"}
            or task["work_revision"] != execution["work_revision"]):
        conflict("stale_generation", "This worker no longer owns the task turn.")
    if task_id is not None and str(task["id"]) != str(task_id):
        conflict("wrong_reserved_task", "This worker may work only on its reserved task.")
    return task


def bound_next(cur, aid, token):
    """None means standalone coordination; a bound worker never claims other work."""
    if not token_execution(cur, token):
        return None
    task = require_current_generation(cur, aid, token)
    return {"task": {k: task[k] for k in ("id", "title", "description", "definition_of_done", "priority", "protocol")},
            "workflow_id": str(task["workflow_id"]), "work_revision": task["work_revision"]}


def refuse_legacy_workflow_run(cur, task_id, aid):
    """Call before recording a legacy run, including lazy task attribution."""
    cur.execute("SELECT container_id FROM agents WHERE id=%s", (aid,))
    agent = cur.fetchone()
    lock_container_graph(cur, str(agent["container_id"]))
    if task_id:
        cur.execute("SELECT workflow_id,status FROM tasks WHERE id=%s", (task_id,))
        task = cur.fetchone()
        if task and task["status"] in {"completed", "cancelled"}:
            conflict("terminal_task", "Finished or cancelled work cannot launch a worker.")
        if task and task["workflow_id"]:
            conflict("workflow_reservation_required", "Use the workflow runner reservation before launching a worker.")
