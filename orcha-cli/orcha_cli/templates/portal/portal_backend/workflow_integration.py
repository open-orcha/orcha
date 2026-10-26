"""Production adapters joining Workflows to task authority, evidence and workers."""

from uuid import uuid4

from portal_backend.task_approval_policy import ApprovalPhase
from portal_backend.task_autonomy_service import completion_submission, record_approval
from portal_backend.workflow_evidence_service import (
    capture_import_evidence,
    capture_owner_evidence,
    validate_workflow_evidence,
)
from portal_backend.workflow_graph import conflict
from portal_backend.workflow_service import WorkflowHooks


class IntegratedWorkflowHooks(WorkflowHooks):
    evidence_read_available = True

    def availability(self, cur, task):
        cur.execute(
            """SELECT a.id FROM agent_tasks at JOIN agents a ON a.id=at.agent_id
               WHERE at.task_id=%s AND at.assignment_status<>'done'
                 AND a.kind='ai' AND a.terminated_at IS NULL LIMIT 1""",
            (task["id"],),
        )
        if not cur.fetchone():
            return {"available": False, "reason": "Choose an available assignee."}
        return {"available": True, "reason": None}

    def validate_evidence(self, cur, task, reference):
        return validate_workflow_evidence(cur, task, reference)

    def completion_permission(self, cur, task, actor):
        if not actor:
            return {"allowed": False, "reason": "verified_member_required"}
        if actor["kind"] == "human":
            return {"allowed": True, "reason": None}
        cur.execute(
            """SELECT 1 FROM agent_tasks WHERE task_id=%s AND agent_id=%s
               AND assignment_status<>'done' LIMIT 1""",
            (task["id"], actor["id"]),
        )
        assigned = cur.fetchone() is not None
        allowed = (
            actor["kind"] == "ai"
            and assigned
            and task.get("autonomy") == "on"
            and not task.get("is_root")
        )
        return {
            "allowed": allowed,
            "reason": None if allowed else "human_approval_required",
        }

    def authorize_completion(self, cur, task, actor, reference):
        verdict = self.completion_permission(cur, task, actor)
        if not verdict["allowed"]:
            conflict(
                verdict["reason"],
                "A person must approve this task while task autonomy is OFF.",
                status=403,
            )
        permission = record_approval(
            cur,
            task,
            str(actor["id"]),
            ApprovalPhase.COMPLETION,
            completion_submission(task),
            human_review_authorized=actor["kind"] == "human",
            permission_source=(
                "workflow_human_acceptance"
                if actor["kind"] == "human"
                else "workflow_task_autonomy"
            ),
        )
        return {
            "autonomy": permission.autonomy.value,
            "autonomy_revision": permission.autonomy_revision,
        }

    def request_stop(self, cur, execution, actor, origin, reason):
        from portal_backend.workflow_evidence_service import (
            terminalize_workflow_run_with_evidence,
        )
        from portal_backend.workflow_worker_stops import release_lost, stop_execution

        if origin == "lost_release":
            return release_lost(
                cur,
                execution,
                actor_id=actor.id,
                reason=reason,
                terminalize=terminalize_workflow_run_with_evidence,
            )
        return stop_execution(
            cur,
            execution,
            origin=origin,
            actor_id=actor.id,
            reason=reason,
            operation_key=str(uuid4()),
        )

    def capture_outside(self, cur, task, evidence, execution):
        return capture_owner_evidence(
            cur,
            task,
            evidence["evidence"],
            execution,
            captured_by=evidence["submitted_by"],
            source="outside",
        )

    def capture_owner(self, cur, task, evidence, execution, actor):
        return capture_owner_evidence(
            cur,
            task,
            evidence,
            execution,
            captured_by=actor.id,
            source="owner",
        )

    def capture_import(
        self, cur, task, evidence, execution, actor, reviewed_result_digest
    ):
        return capture_import_evidence(
            cur,
            task,
            evidence,
            execution,
            captured_by=actor.id,
            reviewed_result_digest=reviewed_result_digest,
        )
