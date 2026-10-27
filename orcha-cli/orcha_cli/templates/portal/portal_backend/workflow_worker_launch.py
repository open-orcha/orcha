"""Single-use workflow launch capabilities. All transitions use caller transactions.

The scheduling adapter acquires graph/workflow/task locks before these functions.
Only reserve_execution decides eligibility; activation consumes an existing turn.
"""

import hashlib
import hmac
import json
import os
import secrets
from datetime import timedelta
from uuid import uuid4

from portal_backend import sql
from portal_backend.event_acknowledgement import _ack_events_handled
from portal_backend.workflow_graph import conflict
from portal_backend.workflow_scheduling import _time

LOCAL_RUNNER = "orcha-local"


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def require_runner(cur, aid):
    """The launcher is this Orcha server's own scheduler, not a caller-held credential.

    No token is read from the request: the same trust boundary as an ordinary wake claim
    applies (portal/LAN protections stay in front of every route). What is still checked is
    identity: ``aid`` must be an active AI teammate. Its launcher row is Orcha's own
    bookkeeping (permits reference it) and is created on first use; a person can still
    revoke it, which blocks launching for that agent until they clear it.
    """
    cur.execute("SELECT container_id FROM agents WHERE id=%s AND kind='ai' AND terminated_at IS NULL", (aid,))
    agent = cur.fetchone()
    if not agent:
        conflict("runner_agent_invalid", "Only an active AI teammate can start Workflow work.", status=403)
    key = digest(f"orcha-local-workflow-runner:{agent['container_id']}:{aid}")
    cur.execute("SELECT * FROM workflow_runner_credentials WHERE token_sha256=%s AND agent_id=%s", (key, aid))
    row = cur.fetchone()
    if not row:
        cur.execute("""INSERT INTO workflow_runner_credentials (id,container_id,agent_id,runner_instance,token_sha256)
                       VALUES (%s,%s,%s,%s,%s) ON CONFLICT (token_sha256) DO NOTHING""",
                    (str(uuid4()), agent["container_id"], aid, LOCAL_RUNNER, key))
        cur.execute("SELECT * FROM workflow_runner_credentials WHERE token_sha256=%s AND agent_id=%s", (key, aid))
        row = cur.fetchone()
    if row["revoked_at"]:
        conflict("runner_revoked", "Launching Workflow work for this agent was turned off by a person.", status=403)
    return row


def _permit(runner, run_id):
    # Reproducible on reserve receipt replay without storing a recoverable permit. The permit
    # binds one bootstrap to one reservation (single use); it is not a caller credential.
    key = (runner["token_sha256"] + (os.environ.get("ORCHA_SECRET_KEY") or "")).encode()
    return hmac.new(key, ("workflow-launch:" + str(run_id)).encode(), hashlib.sha256).hexdigest()


def _result(row, runner):
    return {"run_id": str(row["run_id"]), "execution_id": str(row["execution_id"]),
            "task_id": str(row["task_id"]), "generation": row["generation"],
            "permit": _permit(runner, row["run_id"]), "expires_at": _time(row["expires_at"]).isoformat()}


def launch_receipt(cur, runner, operation_key, payload):
    """Check BEFORE making another reservation, including after a lost response."""
    fingerprint = digest(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    cur.execute("""SELECT p.*, wr.task_id FROM workflow_launch_permits p
                   JOIN worker_runs wr ON wr.run_id=p.run_id
                   WHERE p.runner_credential_id=%s AND p.operation_key=%s""", (runner["id"], operation_key))
    row = cur.fetchone()
    if row:
        if row["payload_sha256"] != fingerprint:
            conflict("idempotency_conflict", "This launch receipt belongs to another request.")
        if row["revoked_at"]:
            conflict("launch_revoked", "This launch was revoked.")
        return _result(row, runner)
    return None


def preallocate_run(cur, execution, runner, *, operation_key, payload, now=None):
    """Bind a scheduler-created reservation to its sole inert bootstrap.

    The runner route has checked launch_receipt before scheduling. No shell or
    network action takes place while the transaction owns the reservation.
    """
    if execution["state"] != "reserved" or execution.get("generation_revoked_at"):
        conflict("reservation_not_launchable", "This task turn cannot start a new worker.")
    if str(execution["claimant_id"]) != str(runner["agent_id"]):
        conflict("wrong_runner", "This reservation belongs to another agent.", status=403)
    now = now or sql.utcnow()
    run_id = str(execution.get("run_id") or uuid4())
    cur.execute("SELECT run_id FROM worker_runs WHERE run_id=%s", (run_id,))
    if cur.fetchone():
        conflict("launch_exists", "Replay the original launch receipt instead of creating another worker.")
    permit = _permit(runner, run_id)
    cur.execute("""INSERT INTO worker_runs (run_id,agent_id,task_id,wake_kind,lane,status)
                   VALUES (%s,%s,%s,'workflow','work','reserved')""",
                (run_id, runner["agent_id"], execution["task_id"]))
    cur.execute("INSERT INTO worker_run_tasks (run_id,task_id) VALUES (%s,%s) ON CONFLICT DO NOTHING", (run_id, execution["task_id"]))
    cur.execute("""INSERT INTO workflow_launch_permits
                   (run_id,execution_id,generation,runner_credential_id,operation_key,payload_sha256,permit_sha256,expires_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                (run_id, execution["id"], execution["generation"], runner["id"], operation_key,
                 digest(json.dumps(payload, sort_keys=True, separators=(",", ":"))), digest(permit), now + timedelta(minutes=2)))
    row = cur.fetchone()
    row["task_id"] = execution["task_id"]
    cur.execute("UPDATE workflow_executions SET run_id=%s WHERE id=%s", (run_id, execution["id"]))
    return _result(row, runner)


def activate(cur, execution, *, aid, run_id, permit, process_key, pid, run_details=None, now=None):
    """Consume once; a retry by the SAME bootstrap returns its SAME credential."""
    now = now or sql.utcnow()
    if not process_key or len(process_key) < 32 or pid <= 0:
        conflict("invalid_process_identity", "A bootstrap process identity is required.", status=422)
    cur.execute("""SELECT p.*, rc.revoked_at AS runner_revoked_at, rc.agent_id
                   FROM workflow_launch_permits p JOIN workflow_runner_credentials rc ON rc.id=p.runner_credential_id
                   WHERE p.run_id=%s""", (run_id,))
    row = cur.fetchone()
    if not row or not hmac.compare_digest(row["permit_sha256"], digest(permit)) or str(row["agent_id"]) != str(aid):
        conflict("invalid_launch_permit", "The launch permit is invalid.", status=403)
    if (str(row["execution_id"]) != str(execution["id"]) or row["generation"] != execution["generation"]
            or str(execution.get("run_id")) != str(run_id) or execution.get("generation_revoked_at")
            or row["revoked_at"] or row["runner_revoked_at"]):
        conflict("stale_generation", "This worker no longer owns the task turn.")
    cur.execute("SELECT status, launch_enabled FROM workflows WHERE id=%s", (execution["workflow_id"],))
    workflow = cur.fetchone()
    cur.execute("SELECT status, work_revision, awaiting_owner_decision FROM tasks WHERE id=%s", (execution["task_id"],))
    task = cur.fetchone()
    cur.execute("SELECT status,ended_at FROM worker_runs WHERE run_id=%s", (run_id,))
    run = cur.fetchone()
    if (workflow["status"] not in {"active", "paused"} or not workflow["launch_enabled"]
            or task["status"] != "in_progress" or task["work_revision"] != execution["work_revision"]
            or task["awaiting_owner_decision"] or not run or run["ended_at"]
            or run["status"] not in {"reserved", "running"}):
        conflict("launch_revoked", "The task or workflow no longer permits this launch.")
    if row["consumed_at"]:
        if row["process_key"] != process_key or row["pid"] != pid:
            conflict("permit_consumed", "Another bootstrap already consumed this permit.")
        cur.execute("SELECT run_token FROM embodiment_tokens WHERE run_id=%s AND revoked_at IS NULL", (run_id,))
        token = cur.fetchone()
        if not token or execution["state"] != "running":
            conflict("stale_generation", "This worker credential is no longer active.")
        return {"run_token": token["run_token"], "run_id": str(run_id), "task_id": str(execution["task_id"]), "generation": execution["generation"]}
    if execution["state"] != "reserved" or now >= _time(row["expires_at"]):
        conflict("permit_expired", "The worker must obtain a fresh reservation before launching.")
    token = secrets.token_urlsafe(32)
    cur.execute("""UPDATE workflow_launch_permits SET consumed_at=%s,process_key=%s,pid=%s
                   WHERE run_id=%s AND consumed_at IS NULL AND revoked_at IS NULL""", (now, process_key, pid, run_id))
    if cur.rowcount != 1:
        conflict("permit_consumed", "Another bootstrap already consumed this permit.")
    cur.execute("""INSERT INTO embodiment_tokens (run_token,agent_id,lane,kind,run_id,pid)
                   VALUES (%s,%s,'work','headless',%s,%s)""", (token, aid, run_id, pid))
    cur.execute("UPDATE worker_runs SET status='running',pid=%s WHERE run_id=%s", (pid, run_id))
    # Task 4dab637d: without these the orphan sweep cannot tell a finished worker from a
    # crashed one (no log) or capture its checkout after a notifier restart.
    details = run_details or {}
    cur.execute("""UPDATE worker_runs SET log_path=%s, worktree=%s, branch=%s, base_cwd=%s, runtime=%s
                   WHERE run_id=%s""",
                (details.get("log_path"), details.get("worktree"), details.get("branch"),
                 details.get("base_cwd"), details.get("runtime"), run_id))
    cur.execute("UPDATE workflow_executions SET state='running',last_runner_contact_at=%s WHERE id=%s", (now, execution["id"]))
    # Activation is this task's claim, the same seam as /next: consume the assignee's
    # "task ready" and assignment wakes, or they re-wake the agent with no task after exit.
    for event_name in ("task_assigned", "task_ready"):
        _ack_events_handled(cur, aid, event_name, "task_id", str(execution["task_id"]))
    return {"run_token": token, "run_id": str(run_id), "task_id": str(execution["task_id"]), "generation": execution["generation"]}


def abort_launch(cur, execution, *, run_id, terminalize, now=None):
    """Only an unconsumed permit proves no task work happened. Never trust a flag."""
    cur.execute("SELECT * FROM workflow_launch_permits WHERE run_id=%s", (run_id,))
    permit = cur.fetchone()
    if (not permit or str(execution.get("run_id")) != str(run_id)
            or permit["generation"] != execution["generation"]):
        conflict("stale_generation", "This launch belongs to an earlier worker.")
    if execution["state"] == "aborted":
        return {"state": "aborted"}
    if permit["consumed_at"] or execution["state"] not in {"reserved", "stopping"}:
        conflict("launch_uncertain", "Confirm the worker stopped before releasing its place.")
    from portal_backend.workflow_worker_stops import fence_execution
    now = now or sql.utcnow()
    fence_execution(cur, execution, now=now)
    terminalize(cur, run_id, "failed", cause="abort_launch")
    cur.execute("UPDATE workflow_executions SET state='aborted',released_at=%s,worker_stopped_at=%s WHERE id=%s", (now, now, execution["id"]))
    cur.execute("UPDATE workflow_stop_intents SET satisfied_at=%s WHERE execution_id=%s AND generation=%s", (now, execution["id"], execution["generation"]))
    # A racing Stop/Cancel retains its task outcome and owner-decision gate.
    cur.execute("UPDATE tasks SET status='pending' WHERE id=%s AND status='in_progress' AND awaiting_owner_decision IS NULL", (execution["task_id"],))
    return {"state": "aborted"}


def continue_turn(cur, execution, runner, *, operation_key, payload, now=None):
    receipt = launch_receipt(cur, runner, operation_key, payload)
    if receipt:
        return receipt
    if payload.get("previous_run_id") and str(execution.get("run_id")) != payload["previous_run_id"]:
        conflict("stale_generation", "This continuation refers to an earlier worker.")
    cur.execute("SELECT status,launch_enabled,container_id FROM workflows WHERE id=%s", (execution["workflow_id"],))
    workflow = cur.fetchone()
    cur.execute("SELECT status,work_revision,awaiting_owner_decision FROM tasks WHERE id=%s", (execution["task_id"],))
    task = cur.fetchone()
    cur.execute("SELECT status FROM containers WHERE id=%s", (workflow["container_id"],))
    project = cur.fetchone()
    cur.execute("SELECT id FROM workflow_stop_intents WHERE execution_id=%s AND generation=%s LIMIT 1", (execution["id"], execution["generation"]))
    stop = cur.fetchone()
    cur.execute("""SELECT at.task_id FROM agent_tasks at JOIN agents a ON a.id=at.agent_id
                   WHERE at.task_id=%s AND at.agent_id=%s AND at.assignment_status IN ('assigned','accepted','working')
                     AND a.terminated_at IS NULL AND a.kind='ai'""", (execution["task_id"], runner["agent_id"]))
    assignment = cur.fetchone()
    # First failing gate wins, so the refusal names the real reason (shown on the task).
    gates = (
        (stop or execution.get("first_stop_at"), "A stop was requested for this task."),
        (execution["state"] not in {"running", "recovery_needed"}, "The task's turn has already ended."),
        (str(execution["claimant_id"]) != str(runner["agent_id"]), "This turn belongs to another agent."),
        (not assignment, "The agent is no longer assigned to this task."),
        (project["status"] != "active", "The project is not active."),
        (workflow["status"] not in {"active", "paused"}, "The workflow is not active."),
        (not workflow["launch_enabled"], "Waiting for the owner to Start the workflow."),
        (task["status"] != "in_progress", "This task is no longer in progress."),
        (task["awaiting_owner_decision"], "This task is waiting for the owner to decide."),
        (task["work_revision"] != execution["work_revision"], "The task was changed after this turn started."),
        (not execution.get("worker_stopped_at"), "The previous worker has not stopped yet."),
    )
    refused = next((message for failed, message in gates if failed), None)
    if refused:
        conflict("continuation_not_allowed", "This task turn cannot continue with another worker: " + refused)
    cur.execute("UPDATE workflow_launch_permits SET revoked_at=COALESCE(revoked_at,%s) WHERE execution_id=%s AND generation=%s", (now or sql.utcnow(), execution["id"], execution["generation"]))
    cur.execute("""UPDATE workflow_executions SET state='reserved',generation=generation+1,run_id=NULL,
                   worker_stopped_at=NULL,last_runner_contact_at=NULL,generation_revoked_at=NULL,
                   current_evidence_set_id=NULL,evidence_state='pending' WHERE id=%s RETURNING *""", (execution["id"],))
    return preallocate_run(cur, cur.fetchone(), runner, operation_key=operation_key, payload=payload, now=now)
