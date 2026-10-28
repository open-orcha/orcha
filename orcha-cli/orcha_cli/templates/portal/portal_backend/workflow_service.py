"""Transactional Workflows model and lifecycle, with fail-closed integration seams.

No function commits or starts a process. Callers own db_cursor() and must acquire
the container graph guard BEFORE existing task/assignment locks. The capability is
deliberately not configurable by environment until legacy entry paths, runtime
fencing, verified identity and durable evidence have been integrated and reviewed.
"""

import hashlib
import json
from dataclasses import dataclass
from uuid import UUID, uuid4

from fastapi import HTTPException

from portal_backend import sql
from portal_backend.events import publish_event
from portal_backend.schemas.workflows import WorkflowDetail
from portal_backend.workflow_graph import (
    conflict,
    dependency_closure,
    descendants,
    validate_graph,
)
from portal_backend import workflow_routing as routing
from portal_backend.workflow_scheduling import (
    LIVE_EXECUTIONS,
    accepted,
    progress_and_completion,
    release_deadline,
    stored_status,
    task_display,
    workflow_eligibility,
)

WORKFLOWS_INTEGRATED = True
# Task 4dab637d: when the turn's run ended, so the display and the Release action can
# tell a worker that ended without a confirmed exit from one that is still running.
RUN_ENDED_AT = (
    "(SELECT wr.ended_at FROM worker_runs wr WHERE wr.run_id=workflow_executions.run_id"
    " AND wr.status<>'running') AS run_ended_at"
)


def require_capability():
    if not WORKFLOWS_INTEGRATED:
        conflict(
            "integration_required",
            "Workflows are being prepared and cannot run yet.",
            status=503,
        )


def _id():
    return str(uuid4())


def _json(value):
    return json.dumps(value, sort_keys=True, default=str, separators=(",", ":"))


def _digest(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def result_digest(result):
    """sha256 of the canonical JSON of the stored tasks.result; None if nothing was saved."""
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except ValueError:
            pass
    body = result.get("result") if isinstance(result, dict) else result
    if body is None or body in ({}, []) or (isinstance(body, str) and not body.strip()):
        return None
    return _digest(result)


def saved_result(result):
    """(text, by_agent_id) a reviewer reads, from the same value result_digest hashes."""
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except ValueError:
            pass
    body, by = result, None
    if isinstance(result, dict):
        body, by = result.get("result"), result.get("by_agent_id")
    if body is None:
        return None, None
    return (body if isinstance(body, str) else _json(body)), (str(by) if by else None)


def _row(row):
    # psycopg UUIDs must compare identically to API strings and SQLite UUIDs.
    return {k: str(v) if isinstance(v, UUID) else v for k, v in dict(row).items()}


@dataclass(frozen=True)
class WorkflowActor:
    id: str
    verified: bool
    work_lane: bool = False


class WorkflowHooks:
    """Installed by the integrated runtime; never take these facts from an API body."""

    evidence_read_available = False

    def availability(self, cur, task):
        return {
            "available": False,
            "reason": "Worker scheduling is not integrated yet.",
        }

    def validate_evidence(self, cur, task, reference):
        conflict(
            "evidence_not_saved", "Durable evidence validation is not integrated yet."
        )

    def authorize_completion(self, cur, task, actor, reference):
        conflict(
            "approval_integration_required", "Task approval is not integrated yet."
        )

    def completion_permission(self, cur, task, actor):
        """Read-only twin of authorize_completion for available_actions.

        Must apply the same task permission and autonomy rule, without evidence.
        """
        return {"allowed": False, "reason": "approval_integration_required"}

    def request_stop(self, cur, execution, actor, origin, reason):
        conflict("stop_integration_required", "Worker stopping is not integrated yet.")

    def capture_outside(self, cur, task, evidence, execution):
        conflict(
            "evidence_not_saved", "Durable outside evidence is not integrated yet."
        )

    def capture_owner(self, cur, task, evidence, execution, actor):
        conflict("evidence_not_saved", "Durable owner evidence is not integrated yet.")

    def capture_import(
        self, cur, task, evidence, execution, actor, reviewed_result_digest
    ):
        """Snapshot a completed standalone task's existing result for import.

        Must verify reviewed_result_digest == result_digest(task["result"]) and
        refuse when the result or required bytes are missing (no reconstruction).
        """
        conflict("evidence_not_saved", "Durable import evidence is not integrated yet.")


def lock_container_graph(cur, cid):
    cur.execute(
        "INSERT INTO container_task_graph_guard(container_id) VALUES (%s) ON CONFLICT DO NOTHING",
        (cid,),
    )
    cur.execute(
        "SELECT revision FROM container_task_graph_guard WHERE container_id=%s"
        + sql.for_update(),
        (cid,),
    )
    return cur.fetchone()["revision"]


# §14.1: standalone not_ready/blocked imports become human-held with these reasons.
RELEASABLE_IMPORTS = frozenset({"pending", "ready"})
IMPORT_HOLD_REASONS = {
    "not_ready": "On hold before it joined this workflow",
    "blocked": "Blocked before it joined this workflow",
}


class WorkflowService:
    def __init__(self, cur, hooks=None):
        self.cur = cur
        self.hooks = hooks or WorkflowHooks()
        self.created_task_ids = {}

    def one(self, query, params=()):
        self.cur.execute(query, params)
        row = self.cur.fetchone()
        return _row(row) if row else None

    def rows(self, query, params=()):
        self.cur.execute(query, params)
        return [_row(row) for row in self.cur.fetchall()]

    def actor(self, actor, cid):
        row = self.one(
            "SELECT * FROM agents WHERE id=%s AND container_id=%s AND terminated_at IS NULL",
            (actor.id, cid),
        )
        if not actor.verified or not row or row.get("member_role") == "viewer":
            conflict(
                "verified_member_required",
                "Verified project membership is required.",
                status=403,
            )
        if row["kind"] == "ai" and not actor.work_lane:
            conflict(
                "work_lane_required",
                "An authenticated work session is required.",
                status=403,
            )
        return row

    def workflow(self, wid):
        row = self.one("SELECT * FROM workflows WHERE id=%s", (wid,))
        if not row:
            conflict("workflow_unavailable", "Workflow not found.", status=404)
        return row

    def lock(self, wid, expected=None):
        before = self.workflow(wid)  # discover container only; do not lock a task first
        lock_container_graph(self.cur, before["container_id"])
        row = self.one("SELECT * FROM workflows WHERE id=%s" + sql.for_update(), (wid,))
        if expected is not None and row["revision"] != expected:
            conflict(
                "revision_changed",
                "The workflow changed. Refresh before continuing.",
                revision=row["revision"],
            )
        return row

    def task(self, wid, tid, expected=None):
        task = self.one(
            "SELECT * FROM tasks WHERE id=%s AND workflow_id=%s" + sql.for_update(),
            (tid, wid),
        )
        if not task:
            conflict("task_unavailable", "Task not found in this workflow.", status=404)
        if expected is not None and task["work_revision"] != expected:
            conflict(
                "work_revision_changed",
                "The task's work changed. Refresh before continuing.",
            )
        return task

    def owner(self, workflow, actor, *, project_owner=False):
        person = self.actor(actor, workflow["container_id"])
        if person["kind"] != "human" or (
            person["id"] != workflow["owner_human_id"]
            and not (project_owner and person.get("member_role") == "owner")
        ):
            conflict(
                "workflow_owner_required",
                "Only the workflow owner can do this.",
                status=403,
            )
        return person

    def active(self, workflow, *, allow_paused=False):
        project = self.one(
            "SELECT status FROM containers WHERE id=%s", (workflow["container_id"],)
        )
        if workflow["status"] not in (
            {"active", "paused"} if allow_paused else {"active"}
        ):
            conflict("workflow_not_active", "This workflow does not allow that change.")
        if project["status"] != "active":
            conflict("project_not_active", "Resume the project first.")

    def no_turn(self, tid):
        if self.live_turn(tid):
            conflict("reservation_live", "Wait for the existing turn to be released.")

    def live_turn(self, tid, lock=False):
        # lock=True only after the workflow and task locks (workflow -> task -> reservation).
        return self.one(
            "SELECT *, " + RUN_ENDED_AT + " FROM workflow_executions WHERE task_id=%s AND state IN "
            "('reserved','running','awaiting_review','stopping','recovery_needed')"
            + (sql.for_update() if lock else ""),
            (tid,),
        )

    def never_started(self, task):
        if task["started_at"] or self.one(
            "SELECT id FROM workflow_executions WHERE task_id=%s LIMIT 1", (task["id"],)
        ):
            conflict(
                "task_already_started",
                "Started work is retained as history. Add a new task instead.",
            )
        self.no_turn(task["id"])

    def snapshot(self, wid):
        w = self.workflow(wid)
        project = self.one(
            "SELECT status FROM containers WHERE id=%s", (w["container_id"],)
        )
        w["container_status"] = project["status"]
        owner = self.one(
            "SELECT kind, member_role FROM agents WHERE id=%s AND container_id=%s AND terminated_at IS NULL",
            (w["owner_human_id"], w["container_id"]),
        )
        w["owner_live"] = bool(
            owner and owner["kind"] == "human" and owner["member_role"] != "viewer"
        )
        w["flexible_enabled"] = routing.flexible_enabled()
        w["paused_group_tasks"] = {}
        if w.get("semantics_version", 1) == 2:
            for g in self.rows(
                "SELECT g.name,g.state,m.task_id,a.alias FROM workflow_repeat_groups g JOIN workflow_repeat_group_members m ON m.group_id=g.id LEFT JOIN agents a ON a.id=g.escalation_owner_id WHERE g.workflow_id=%s AND g.state IN ('limit_reached','stalled','awaiting_owner')",
                (wid,),
            ):
                w["paused_group_tasks"][g["task_id"]] = (
                    f"The loop {g['name']} is waiting for {g['alias'] or 'the owner'} to decide."
                )
        tasks = {
            t["id"]: t
            for t in self.rows(
                "SELECT * FROM tasks WHERE workflow_id=%s ORDER BY priority, created_at, id",
                (wid,),
            )
        }
        deps = {tid: [] for tid in tasks}
        for row in self.rows(
            "SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.workflow_id=%s",
            (wid,),
        ):
            deps[row["task_id"]].append(row["depends_on_id"])
        executions = self.rows(
            "SELECT *, " + RUN_ENDED_AT + " FROM workflow_executions WHERE workflow_id=%s ORDER BY generation",
            (wid,),
        )
        acceptances = {}
        for a in self.rows(
            "SELECT a.* FROM workflow_task_acceptances a JOIN tasks t ON t.id=a.task_id AND t.work_revision=a.work_revision WHERE a.workflow_id=%s",
            (wid,),
        ):
            a["evidence_valid"] = self.evidence_valid(
                tasks[a["task_id"]],
                {"evidence_set_id": a["evidence_set_id"], "items": a["evidence_items"]},
            )
            acceptances[a["task_id"]] = a
        outside = {
            e["task_id"]: e
            for e in self.rows(
                "SELECT * FROM task_outside_evidence WHERE workflow_id=%s AND state IN ('pending','admitted')",
                (wid,),
            )
        }
        objectives = self.rows(
            "SELECT * FROM workflow_objectives WHERE workflow_id=%s ORDER BY id", (wid,)
        )
        for o in objectives:
            o["evidence_valid"] = self.basis_valid(o["evidence"], tasks)
        w["goal_evidence_valid"] = self.basis_valid(w["goal_evidence"], tasks)
        rounds = self.rows(
            "SELECT * FROM workflow_review_rounds WHERE workflow_id=%s", (wid,)
        )
        availability = {
            tid: self.hooks.availability(self.cur, t) for tid, t in tasks.items()
        }
        from portal_backend.workflow_review_handoff import active_handoff
        handoff = active_handoff(self.cur, wid)
        if handoff:
            w['review_handoff_target'] = (handoff['review_task_id'] if handoff['phase'] == 'review'
                else handoff['source_task_id'] if handoff['phase'] == 'correction' else 'waiting_for_stop')
        eligibility = workflow_eligibility(
            w, tasks, deps, acceptances, executions, outside, availability
        )
        progress, completion = progress_and_completion(
            w, tasks, acceptances, executions, objectives, rounds
        )
        return dict(
            workflow=w,
            tasks=tasks,
            dependencies=deps,
            acceptances=acceptances,
            executions=executions,
            outside_evidence=outside,
            objectives=objectives,
            review_rounds=rounds,
            eligibility=eligibility,
            progress=progress,
            completion=completion,
        )

    def evidence_valid(self, task, reference):
        try:
            self.hooks.validate_evidence(self.cur, task, reference)
            return True
        except HTTPException:
            return False

    def basis_valid(self, basis, tasks):
        if not basis or not str(basis.get("narrative", "")).strip():
            return False
        for tid, revision in basis.get("task_revisions", {}).items():
            if (
                tid not in tasks
                or tasks[tid]["work_revision"] != revision
                or tasks[tid].get("withdrawn_at")
            ):
                return False
        for ref in basis.get("evidence_sets", []):
            # A set may only be used when its owning task is explicitly in the basis.
            if not any(
                self.evidence_valid(tasks[tid], ref)
                for tid in basis.get("task_revisions", {})
            ):
                return False
        return True

    def detail(self, wid, actor=None):
        s = self.snapshot(wid)
        w = s["workflow"]
        tasks = []
        person = None
        if actor and WORKFLOWS_INTEGRATED:
            try:
                person = self.actor(actor, w["container_id"])
            except HTTPException:
                pass
        me = person["id"] if person else None
        human = bool(person and person["kind"] == "human")
        is_owner = human and me == w["owner_human_id"]
        project_owner = human and person.get("member_role") == "owner"
        participant = bool(
            person
            and person["kind"] == "ai"
            and self.one(
                "SELECT 1 AS present FROM agent_tasks a JOIN tasks t ON t.id=a.task_id WHERE t.workflow_id=%s AND a.agent_id=%s",
                (wid, me),
            )
        )
        can_write = is_owner
        reason = (
            None
            if can_write
            else (
                "integration_required"
                if not WORKFLOWS_INTEGRATED
                else "workflow_owner_required"
            )
        )
        # Who may act, mirroring owner()/actor() and each op_* guard exactly.
        allowed = {
            "workflow_owner": (is_owner, "workflow_owner_required"),
            "workflow_or_project_owner": (
                is_owner or project_owner,
                "workflow_owner_required",
            ),
            "verified_human": (human, "human_reviewer_required"),
            # The verified person who submitted an outside result may withdraw it.
            "workflow_owner_or_submitter": (is_owner, "workflow_owner_required"),
            "workflow_owner_or_participant": (
                is_owner or participant,
                (
                    "workflow_owner_required"
                    if human
                    else "workflow_participation_required"
                ),
            ),
            "task_approval": (bool(person), "completion_not_authorized"),
        }
        statuses = {
            "active": {"active"},  # self.active(w)
            "open": {"active", "paused"},  # self.active(w, allow_paused=True)
        }

        def lifecycle(kind):
            if kind in statuses:
                if w["status"] not in statuses[kind]:
                    return "workflow_not_active"
                if w["container_status"] != "active":
                    return "project_not_active"
            elif kind == "not_completed" and w["status"] == "completed":
                return "workflow_completed"
            elif kind == "not_terminal" and w["status"] in {"completed", "cancelled"}:
                return "workflow_terminal"
            elif kind == "terminal" and w["status"] not in {"completed", "cancelled"}:
                # GH #350 §4.14: hiding never stops work or evades Finish.
                return "workflow_not_finished"
            return None

        def action(
            name, permission, kind, blocked=None, task=None, submitter=None, **extra
        ):
            ok, denial = allowed[permission]
            ok = ok or bool(human and submitter and submitter == str(me))
            why = (
                "integration_required"
                if not WORKFLOWS_INTEGRATED
                else (
                    "verified_member_required"
                    if not person
                    else (None if ok else denial)
                )
            )
            why = why or lifecycle(kind) or blocked
            if not why and permission == "task_approval":
                # The integrated approval rule decides; absence is denial.
                verdict = self.hooks.completion_permission(self.cur, task, person)
                why = None if verdict["allowed"] else verdict["reason"]
            return dict(
                action=name,
                enabled=why is None,
                reason=why,
                permission=permission,
                **extra,
            )

        def first(*checks):
            return next((code for failed, code in checks if failed), None)

        ever_accepted = {
            r["task_id"]
            for r in self.rows(
                "SELECT task_id FROM workflow_task_acceptances WHERE workflow_id=%s",
                (wid,),
            )
        }
        outside_history = {
            r["task_id"]
            for r in self.rows(
                "SELECT task_id FROM task_outside_evidence WHERE workflow_id=%s",
                (wid,),
            )
        }
        remaining = sum(1 for t in s["tasks"].values() if not t.get("withdrawn_at"))
        executions_by_task = {tid: [] for tid in s["tasks"]}
        for e in s["executions"]:
            executions_by_task.setdefault(e["task_id"], []).append(e)

        def never_started(tid):
            return not s["tasks"][tid]["started_at"] and not executions_by_task[tid]

        names = {
            str(a["id"]): a["alias"]
            for a in self.rows(
                "SELECT id,alias FROM agents WHERE container_id=%s",
                (w["container_id"],),
            )
        }
        for tid, task in s["tasks"].items():
            executions = executions_by_task[tid]
            live = next((e for e in executions if e["state"] in LIVE_EXECUTIONS), None)
            last = live or (executions[-1] if executions else None)
            row = dict(task, **s["eligibility"][tid])
            row["depends_on"] = s["dependencies"][tid]
            row["assignee_ids"] = [
                a["agent_id"]
                for a in self.rows(
                    "SELECT agent_id FROM agent_tasks WHERE task_id=%s AND assignment_status<>'done'",
                    (tid,),
                )
            ]
            blockers = s["eligibility"][tid].get("blockers") or []
            row["display_state"] = task_display(
                task,
                last,
                s["outside_evidence"].get(tid),
                names=names,
                launch_enabled=w["launch_enabled"],
                waiting_on=[
                    (s["tasks"][pid]["title"], s["tasks"][pid]["status"])
                    for pid in s["dependencies"][tid]
                    if s["tasks"][pid]["status"] != "completed"
                ],
                evidence_reason=(
                    blockers[0]["message"].rstrip(".") if blockers else None
                ),
                lost_release=any(e["state"] == "released_lost" for e in executions),
                workflow_open=w["status"] in {"active", "paused"},
            )
            outside = s["outside_evidence"].get(tid)
            row["outside_result_id"] = outside["id"] if outside else None
            row["outside_result_state"] = outside["state"] if outside else None
            row["current_evidence_set_id"] = (
                last["current_evidence_set_id"] if last else None
            )
            row["evidence_state"] = last["evidence_state"] if last else None
            row["acceptance"] = s["acceptances"].get(tid)
            terminal = task["status"] in {"completed", "cancelled"}
            started = not never_started(tid)
            current = next(
                (
                    e
                    for e in reversed(executions)
                    if e["work_revision"] == task["work_revision"]
                ),
                None,
            )
            run_live = False
            if current and current["run_id"]:
                run = self.one(
                    "SELECT ended_at FROM worker_runs WHERE run_id=%s",
                    (current["run_id"],),
                )
                run_live = not run or not run["ended_at"]
            releasable = []
            if task["start_hold"] and is_owner and w["launch_enabled"]:
                releasable.append("start")
            if task["human_hold_by"] and (is_owner or me == task["human_hold_by"]):
                releasable.append("human")
            review = next(
                (r for r in s["review_rounds"] if r["review_task_id"] == tid), None
            )
            # A CLEAN handoff releases the worker slot before human acceptance.
            # Show the same exact stopped execution that op_accept permits.
            handoff_review = None
            if last and task['status'] == 'needs_verification' and last.get('release_reason') == 'review_handoff':
                handoff_review = self.one("SELECT id FROM workflow_review_handoffs WHERE phase='clean' AND (source_execution_id=%s OR review_execution_id=%s)", (last['id'],last['id']))
            verification_turn = live or (last if handoff_review else None)
            row["available_actions"] = [
                action(
                    "prepare",
                    "workflow_owner",
                    "active",
                    first(
                        (started, "task_already_started"), (terminal, "task_terminal")
                    ),
                ),
                action(
                    "hold",
                    "workflow_or_project_owner",
                    "open",
                    first(
                        (bool(live), "reservation_live"),
                        (
                            task["status"] not in {"not_ready", "pending", "ready"},
                            "task_not_waiting",
                        ),
                        (
                            bool(task["human_hold_by"] and task["human_hold_by"] != me),
                            "hold_exists",
                        ),
                    ),
                ),
                action(
                    "release",
                    "workflow_or_project_owner",
                    "active",
                    first(
                        (
                            task["preparation_state"] != "prepared" or terminal,
                            "task_not_prepared",
                        ),
                        (bool(live), "reservation_live"),
                        (
                            not (task["start_hold"] or task["human_hold_by"]),
                            "no_hold",
                        ),
                        (
                            is_owner
                            and not releasable
                            and not task["human_hold_by"]
                            and not w["launch_enabled"],
                            "workflow_not_started",
                        ),
                        (not releasable, "hold_owner_required"),
                    ),
                    holds=releasable,
                ),
                action(
                    "retry",
                    "workflow_owner",
                    "open",
                    first(
                        (bool(live), "reservation_live"),
                        (bool(task.get("withdrawn_at")), "task_withdrawn"),
                        (
                            task["status"] == "completed"
                            and not all(
                                never_started(child)
                                for child in descendants(tid, s["dependencies"])
                            ),
                            "task_already_started",
                        ),
                        (
                            task["status"] != "completed"
                            and not task["awaiting_owner_decision"]
                            and task["status"] != "cancelled",
                            "owner_decision_required",
                        ),
                        (bool(outside), "owner_evidence_pending"),
                    ),
                ),
                action(
                    "stop",
                    "workflow_owner",
                    "open",
                    first(
                        (
                            not live or live["source_kind"] != "worker",
                            "no_running_worker",
                        ),
                        (
                            bool(live and live["state"] == "stopping"),
                            "stop_already_requested",
                        ),
                    ),
                ),
                action(
                    "release_lost_worker",
                    "workflow_owner",
                    "not_completed",
                    first(
                        (not live, "already_released"),
                        (
                            not row["display_state"]["release_available"],
                            "release_not_yet_available",
                        ),
                    ),
                ),
                action(
                    "reissue_stop",
                    "workflow_owner",
                    "not_completed",
                    first(
                        (not live or live["state"] != "stopping", "stop_not_pending")
                    ),
                ),
                action(
                    "submit_outside_result",
                    "workflow_owner",
                    "open",
                    first(
                        (bool(live), "reservation_live"),
                        (
                            terminal or not task["definition_of_done"].strip(),
                            "outside_result_not_allowed",
                        ),
                        (bool(outside), "owner_evidence_pending"),
                    ),
                ),
                action(
                    "withdraw_evidence",
                    "workflow_owner_or_submitter",
                    "open",
                    first(
                        (not outside, "evidence_not_pending"),
                        (
                            bool(live and live["source_kind"] != "evidence_review"),
                            "reservation_live",
                        ),
                    ),
                    submitter=str(outside["submitted_by"]) if outside else None,
                ),
                action(
                    "add_evidence",
                    "workflow_owner",
                    "open",
                    first(
                        (terminal or bool(task.get("withdrawn_at")), "task_terminal"),
                        (
                            not current
                            or current["evidence_state"] != "missing"
                            or not current["current_evidence_set_id"],
                            "missing_evidence_required",
                        ),
                        (run_live, "worker_live"),
                    ),
                ),
                action(
                    "dependencies",
                    "workflow_owner",
                    "active",
                    first((started, "task_already_started")),
                ),
                action(
                    "withdraw",
                    "workflow_owner",
                    "open",
                    first(
                        (bool(live), "reservation_live"),
                        (
                            bool(task.get("withdrawn_at")) or tid in ever_accepted,
                            "withdrawal_not_allowed",
                        ),
                        (
                            any(
                                tid in s["dependencies"][other]
                                for other, t in s["tasks"].items()
                                if not t.get("withdrawn_at")
                            ),
                            "task_has_dependents",
                        ),
                        (remaining <= 1, "last_required_task"),
                    ),
                ),
                action(
                    "move",
                    "workflow_owner",
                    "active",
                    first(
                        (started, "task_already_started"),
                        (terminal or tid in outside_history, "task_history_present"),
                    ),
                ),
                action(
                    "accept",
                    "task_approval",
                    "open",
                    first(
                        (bool(handoff_review) and not human, "human_approval_required"),
                        (task["status"] != "needs_verification", "not_awaiting_review"),
                        (
                            not verification_turn
                            or verification_turn["work_revision"] != task["work_revision"]
                            or not verification_turn["current_evidence_set_id"],
                            "evidence_version_stale",
                        ),
                        (
                            bool(verification_turn) and verification_turn["evidence_state"] == "missing",
                            "evidence_missing",
                        ),
                        (
                            bool(verification_turn) and verification_turn["evidence_state"] != "saved",
                            "evidence_not_saved",
                        ),
                        (
                            bool(verification_turn)
                            and verification_turn["source_kind"] == "evidence_review"
                            and not human,
                            "human_approval_required",
                        ),
                    ),
                    task=task,
                ),
                action(
                    "reject",
                    "verified_human",
                    "open",
                    first(
                        (task["status"] != "needs_verification", "not_awaiting_review")
                    ),
                ),
                action(
                    "resolve_loop",
                    "workflow_owner",
                    "open",
                    first(
                        (
                            not review or review["outcome"] == "accepted",
                            "review_loop_unavailable",
                        )
                    ),
                ),
            ]
            tasks.append(row)
        guard = self.one(
            "SELECT revision FROM container_task_graph_guard WHERE container_id=%s",
            (w["container_id"],),
        )
        w["graph_revision"] = guard["revision"] if guard else 1
        live_turns = self.live_turns(wid)
        full = len(s["tasks"]) >= w["task_limit"]
        startable = any(
            t["preparation_state"] == "prepared"
            and t["status"] not in {"completed", "cancelled"}
            for t in s["tasks"].values()
        ) or (
            bool(s["tasks"])
            and all(accepted(t, s["acceptances"]) for t in s["tasks"].values())
        )
        agent = bool(person and person["kind"] == "ai")
        workflow_actions = [
            action(
                "start",
                "workflow_owner",
                "active",
                first(
                    (w["launch_enabled"], "already_started"),
                    (not startable, "prepared_selection_required"),
                ),
            ),
            action(
                "pause",
                "workflow_owner",
                "active",
                first((not w["launch_enabled"], "workflow_not_started")),
            ),
            action(
                "resume",
                "workflow_owner",
                "open",
                first((w["status"] != "paused", "workflow_not_paused")),
            ),
            action("cancel", "workflow_owner", "open"),
            action(
                "finish",
                "workflow_owner",
                "active",
                first((not s["completion"]["can_finish"], "workflow_incomplete")),
            ),
            action(
                "add_tasks",
                "workflow_owner_or_participant",
                "active",
                first(
                    (agent and not w["launch_enabled"], "workflow_not_started"),
                    (full, "task_limit"),
                ),
            ),
            action("import", "workflow_owner", "active", first((full, "task_limit"))),
            action("patch", "workflow_owner", "open"),
            action("accept_goal", "workflow_owner", "open"),
            action(
                "review_round",
                "workflow_owner_or_participant",
                "active",
                first((agent and not w["launch_enabled"], "workflow_not_started")),
            ),
            action("transfer_owner", "workflow_or_project_owner", "not_terminal"),
            action("move", "workflow_owner", "active"),
            # GH #350 §4.14: reversible deactivation. Hide needs a finished workflow with
            # no live worker turn; restore needs a hidden one and never starts work.
            action(
                "hide",
                "workflow_or_project_owner",
                "terminal",
                first(
                    (bool(w["hidden_at"]), "workflow_hidden"),
                    (bool(live_turns), "worker_live"),
                ),
            ),
            action(
                "restore",
                "workflow_or_project_owner",
                "any",
                first((not w["hidden_at"], "workflow_visible")),
            ),
        ]
        for o in s["objectives"]:
            o["available_actions"] = [
                action("accept_objective", "workflow_owner", "open"),
                action("edit_objective", "workflow_owner", "open"),
            ]
        activity = self.rows(
            "SELECT * FROM workflow_history WHERE workflow_id=%s ORDER BY created_at DESC,id DESC LIMIT 101",
            (wid,),
        )
        hidden_by = (
            self.one(
                "SELECT alias FROM agents WHERE id=%s", (w["hidden_by_human_id"],)
            )
            if w.get("hidden_by_human_id")
            else None
        )
        w.update(
            hidden=bool(w.get("hidden_at")),
            hidden_by_alias=hidden_by["alias"] if hidden_by else None,
            capability={
                "workflow_read": True,
                "workflow_human_write": can_write,
                "reason": reason,
            },
            available_actions=workflow_actions,
            progress=s["progress"],
            completion=s["completion"],
            tasks=tasks,
            objectives=s["objectives"],
            review_rounds=s["review_rounds"],
            activity=activity[:100],
            activity_truncated=len(activity) > 100,
            evidence_capability={
                "available": self.hooks.evidence_read_available,
                "reason": (
                    None
                    if self.hooks.evidence_read_available
                    else "integration_required"
                ),
            },
            created_task_ids=self.created_task_ids,
        )
        return WorkflowDetail.model_validate(w).model_dump(mode="json")

    def impact(self, wid, actor, kind, task_ids=(), holds=("start",)):
        """Read-only Start / release / cancellation preview (plan 8, 14.1).

        Simulates the mutation on a copy of the snapshot and reports, per
        task, what it would become; the mutation revalidates under lock.
        """
        out = self.detail(wid, actor)
        s = self.snapshot(wid)
        w, tasks, deps = s["workflow"], s["tasks"], s["dependencies"]
        live = [e for e in s["executions"] if e["state"] in LIVE_EXECUTIONS]
        impact = {
            "kind": kind,
            "revision": out["revision"],
            "graph_revision": out["graph_revision"],
            "scope_revision": out["scope_revision"],
            "task_revisions": {tid: t["work_revision"] for tid, t in tasks.items()},
            "holds": [] if kind == "cancellation" else list(holds),
            "tasks": [],
        }
        if kind == "cancellation":
            names = {
                str(a["id"]): a["alias"]
                for a in self.rows(
                    "SELECT id,alias FROM agents WHERE container_id=%s",
                    (w["container_id"],),
                )
            }
            counts = {}
            for t in tasks.values():
                counts[t["status"]] = counts.get(t["status"], 0) + 1
            impact["counts_by_state"] = counts
            impact["accepted_retained"] = sorted(s["acceptances"])
            impact["workers_to_stop"] = [
                {
                    "task_id": e["task_id"],
                    "agent_id": e["claimant_id"],
                    "name": names.get(str(e["claimant_id"])),
                }
                for e in live
                if e["source_kind"] == "worker"
            ]
            out["impact"] = impact
            return out
        person = None
        if actor and WORKFLOWS_INTEGRATED:
            try:
                person = self.actor(actor, w["container_id"])
            except HTTPException:
                pass
        if kind == "start" and not task_ids:
            task_ids = [
                tid
                for tid, t in tasks.items()
                if t["preparation_state"] == "prepared"
                and t["start_hold"]
                and t["status"] not in {"completed", "cancelled"}
            ]
        start_holds = kind == "start" or "start" in holds
        sim = {tid: dict(t) for tid, t in tasks.items()}
        refused = {}
        for tid in task_ids:
            t = sim.get(tid)
            reason = None
            if t is None:
                reason = ("task_not_in_workflow", "This task is not in the workflow.")
            elif t["preparation_state"] != "prepared" or t["status"] in {
                "completed",
                "cancelled",
            }:
                reason = (
                    "task_not_prepared",
                    "Only prepared unfinished tasks can be released.",
                )
            elif any(e["task_id"] == tid for e in live):
                reason = (
                    "reservation_live",
                    "Wait for the existing turn to be released.",
                )
            elif kind == "start" and w["launch_enabled"]:
                reason = ("already_started", "The workflow was already started.")
            elif (
                kind == "release"
                and start_holds
                and t["start_hold"]
                and not w["launch_enabled"]
            ):
                reason = (
                    "workflow_not_started",
                    "Use Start to release the first tasks.",
                )
            elif (
                kind == "release"
                and "human" in holds
                and t["human_hold_by"]
                and person
                and person["id"] not in {w["owner_human_id"], t["human_hold_by"]}
            ):
                reason = (
                    "hold_owner_required",
                    "A project owner may release only their own safety hold.",
                )
            if reason:
                refused[tid] = {"code": reason[0], "message": reason[1], "task_id": tid}
                continue
            if start_holds:
                t["start_hold"] = False
            if kind == "release" and "human" in holds:
                t["human_hold_by"] = None
        sim_w = dict(w, launch_enabled=True) if kind == "start" else w
        for t in sim.values():
            t["status"] = stored_status(
                t, deps, sim, s["acceptances"], s["outside_evidence"]
            )
        from portal_backend.workflow_review_handoff import active_handoff
        handoff = active_handoff(self.cur, wid)
        if handoff:
            sim_w['review_handoff_target'] = (handoff['review_task_id'] if handoff['phase'] == 'review'
                else handoff['source_task_id'] if handoff['phase'] == 'correction' else 'waiting_for_stop')
        eligibility = workflow_eligibility(
            sim_w,
            sim,
            deps,
            s["acceptances"],
            s["executions"],
            s["outside_evidence"],
            {tid: self.hooks.availability(self.cur, t) for tid, t in sim.items()},
        )
        for tid, t in sim.items():
            choice = eligibility[tid]
            gates = [
                b
                for b in choice["blockers"]
                if b["code"] not in {"workflow_turn", "prerequisites"}
            ]
            if tid in refused:
                result = "refused"
            elif t["status"] not in {"not_ready", "pending", "ready"}:
                result = "unchanged"
            elif t["status"] == "not_ready" or gates:
                result = "blocked"
            elif t["status"] == "pending":
                result = "waiting_for_prerequisites"
            else:
                result = "takes_turn_alone" if choice["exclusive"] else "ready"
            impact["tasks"].append(
                {
                    "task_id": tid,
                    "title": t["title"],
                    "work_revision": t["work_revision"],
                    "selected": tid in task_ids,
                    "current_status": tasks[tid]["status"],
                    "resulting_status": result,
                    "can_start": choice["can_start"] and tid not in refused,
                    "refusal": refused.get(tid),
                    "blockers": choice["blockers"],
                }
            )
        impact["tasks"] += [
            {
                "task_id": tid,
                "title": "",
                "work_revision": 0,
                "selected": True,
                "current_status": "unknown",
                "resulting_status": "refused",
                "can_start": False,
                "refusal": r,
                "blockers": [],
            }
            for tid, r in refused.items()
            if tid not in sim
        ]
        out["impact"] = impact
        return out

    def audit(self, w, person, event, detail, tid=None, *, scope=False):
        revision = w["revision"] + 1
        self.cur.execute(
            "UPDATE workflows SET revision=%s,updated_at=%s WHERE id=%s",
            (revision, sql.utcnow(), w["id"]),
        )
        if scope:
            self.cur.execute(
                "UPDATE workflows SET scope_revision=scope_revision+1,goal_accepted_revision=NULL,goal_accepted_scope_revision=NULL WHERE id=%s",
                (w["id"],),
            )
            self.cur.execute(
                "UPDATE container_task_graph_guard SET revision=revision+1 WHERE container_id=%s",
                (w["container_id"],),
            )
        self.cur.execute(
            "INSERT INTO workflow_history(id,workflow_id,task_id,actor_id,actor_kind,actor_alias,event,revision,detail) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                _id(),
                w["id"],
                tid,
                person["id"],
                person["kind"],
                person["alias"],
                event,
                revision,
                _json(detail),
            ),
        )
        publish_event(
            self.cur,
            w["container_id"],
            w["owner_human_id"],
            "workflow_changed",
            {"workflow_id": w["id"], "revision": revision, "event": event},
        )
        w["revision"] = revision

    def reconcile(self, wid):
        require_capability()
        w = self.lock(wid)
        # The host records worker termination before its follow-up
        # confirm-stopped call. If that follow-up is lost, retain the exclusive
        # turn but make the recovery state and owner attention durable. A quiet
        # heartbeat alone is deliberately not proof that a process stopped.
        self.cur.execute(
            """UPDATE workflow_executions SET state='recovery_needed'
                 WHERE workflow_id=%s
                   AND state IN ('reserved','running','awaiting_review')
                   AND worker_stopped_at IS NULL
                   AND run_id IN (
                       SELECT run_id FROM worker_runs WHERE ended_at IS NOT NULL
                   )""",
            (wid,),
        )
        from portal_backend.workflow_review_handoff import reconcile_handoff
        reconcile_handoff(self, w)
        s = self.snapshot(wid)
        for tid, task in s["tasks"].items():
            state = stored_status(
                task,
                s["dependencies"],
                s["tasks"],
                s["acceptances"],
                s["outside_evidence"].get(tid),
            )
            if state != task["status"]:
                self.cur.execute("UPDATE tasks SET status=%s WHERE id=%s", (state, tid))
            if s["eligibility"][tid]["can_start"]:
                kind = (
                    "workflow_evidence_waiting"
                    if s["eligibility"][tid]["source_kind"] == "evidence_review"
                    else "task_ready"
                )
                self.notice(s["workflow"], kind, tid, task["work_revision"])
        self.attention(s)
        self.forget_ready(s)
        if s["completion"]["can_finish"]:
            self.notice(
                s["workflow"],
                "workflow_ready_to_finish",
                "workflow",
                s["workflow"]["revision"],
            )

    def attention(self, s):
        """Owner attention beyond limit reached (plan 14.7): a turn needing
        recovery, a worker silent long enough to release, and a ready task
        with nobody assigned. One notice per task version and reason."""
        w = s["workflow"]
        now = sql.utcnow()
        for e in s["executions"]:
            task = s["tasks"].get(e["task_id"])
            if not task or e["work_revision"] != task["work_revision"]:
                continue
            if e["state"] == "recovery_needed":
                reason = "recovery_needed"
            elif e["state"] in LIVE_EXECUTIONS and (
                release_deadline(e) and now >= release_deadline(e)
            ):
                reason = "lost_worker"
            else:
                continue
            self.notice(
                w, "workflow_attention", e["task_id"], task["work_revision"], reason
            )
        if w["status"] != "active" or not w["launch_enabled"]:
            return
        for tid, task in s["tasks"].items():
            if (
                task["status"] == "ready"
                and s["eligibility"][tid]["source_kind"] == "worker"
                and not self.one(
                    "SELECT 1 AS n FROM agent_tasks WHERE task_id=%s AND assignment_status<>'done'",
                    (tid,),
                )
            ):
                self.notice(
                    w,
                    "workflow_attention",
                    tid,
                    task["work_revision"],
                    "choose_assignee",
                )

    def notice(self, w, kind, subject, revision, reason=None):
        self.cur.execute(
            "INSERT INTO workflow_notification_receipts(workflow_id,notice_kind,subject_key,subject_revision) VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING",
            (w["id"], kind, f"{subject}:{reason}" if reason else subject, revision),
        )
        if self.cur.rowcount:
            targets = [w["owner_human_id"]]
            verifier = (
                self.one("SELECT reviewer_agent_id FROM tasks WHERE id=%s", (subject,))
                if subject != "workflow"
                else None
            )
            if verifier and verifier["reviewer_agent_id"]:
                # §14.7: task notices go to the task's verifier where set. Attention
                # notices name owner-only decisions, so the owner keeps those too.
                targets = [str(verifier["reviewer_agent_id"])] + (
                    targets if kind == "workflow_attention" else []
                )
            if kind == "task_ready":
                targets = [
                    a["agent_id"]
                    for a in self.rows(
                        "SELECT agent_id FROM agent_tasks WHERE task_id=%s AND assignment_status<>'done'",
                        (subject,),
                    )
                ]
            for aid in targets:
                publish_event(
                    self.cur,
                    w["container_id"],
                    aid,
                    kind,
                    {
                        "workflow_id": w["id"],
                        "task_id": subject if subject != "workflow" else None,
                        "revision": revision,
                        **({"reason": reason} if reason else {}),
                    },
                )

    def forget_ready(self, s):
        """A worker wake lasts only while its task can start: once the task loses
        the turn (or is held, or waits again) the next time it can start wakes
        its worker again, even at the same work revision."""
        for tid, row in s["eligibility"].items():
            if not row["can_start"]:
                self.cur.execute(
                    "DELETE FROM workflow_notification_receipts WHERE workflow_id=%s AND notice_kind='task_ready' AND subject_key=%s",
                    (s["workflow"]["id"], str(tid)),
                )

    def receipt(self, cid, actor, operation, key):
        self.actor(actor, cid)
        row = self.one(
            "SELECT * FROM workflow_operation_receipts WHERE container_id=%s AND actor_id=%s AND operation=%s AND idempotency_key=%s",
            (cid, actor.id, operation, key),
        )
        return row

    def mutate(self, cid, actor, operation, body, *, wid=None, tid=None):
        require_capability()
        lock_container_graph(self.cur, cid)
        person = self.actor(actor, cid)
        digest = _digest({"workflow_id": wid, "task_id": tid, "body": body})
        prior = self.receipt(cid, actor, operation, body["idempotency_key"])
        if prior:
            if prior["payload_sha256"] != digest:
                conflict(
                    "idempotency_conflict",
                    "This save key was already used for different changes.",
                )
            return prior["result"]
        if operation == "create":
            wid = self.create(cid, actor, body)
        else:
            if operation == "move" and body.get("destination_workflow_id"):
                for lock_id in sorted({wid, body["destination_workflow_id"]}):
                    target = self.workflow(lock_id)
                    if target["container_id"] != cid:
                        conflict(
                            "workflow_unavailable", "Workflow not found.", status=404
                        )
                    self.lock(lock_id)
            w = self.lock(wid, body["expected_revision"])
            if w["container_id"] != cid:
                conflict("workflow_unavailable", "Workflow not found.", status=404)
            handler = getattr(self, "op_" + operation, None)
            if handler is None:
                conflict(
                    "unsupported_action",
                    "This workflow action is not available.",
                    status=422,
                )
            handler(w, actor, body, tid)
        self.reconcile(wid)
        result = self.detail(wid, actor)
        self.cur.execute(
            "INSERT INTO workflow_operation_receipts(id,container_id,workflow_id,actor_id,operation,idempotency_key,payload_sha256,result) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                _id(),
                cid,
                wid,
                person["id"],
                operation,
                body["idempotency_key"],
                digest,
                _json(result),
            ),
        )
        return result

    def preview_import(self, cid, task_ids, workflow=None):
        if len(set(task_ids)) != len(task_ids):
            conflict("duplicate_task", "Select each task once.", status=422)
        all_tasks = {
            t["id"]: t
            for t in self.rows("SELECT * FROM tasks WHERE container_id=%s", (cid,))
        }
        if any(tid not in all_tasks for tid in task_ids):
            conflict("task_unavailable", "A selected task is unavailable.", status=404)
        deps = {}
        for d in self.rows(
            "SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.container_id=%s",
            (cid,),
        ):
            deps.setdefault(d["task_id"], []).append(d["depends_on_id"])
        closed = dependency_closure(task_ids, deps)
        if not closed.issubset(all_tasks):
            conflict(
                "invalid_graph",
                "The selected group has an unavailable prerequisite.",
                status=422,
            )
        blockers = []
        for tid in sorted(closed):
            t = all_tasks[tid]
            if (
                t["is_root"]
                or t["workflow_id"]
                or t["status"]
                not in {"not_ready", "pending", "ready", "blocked", "completed"}
            ):
                blockers.append(
                    {
                        "code": "import_ineligible",
                        "message": t["title"]
                        + " cannot be imported in its current state.",
                        "task_id": tid,
                    }
                )
            if t["status"] == "completed" and not result_digest(t["result"]):
                blockers.append(
                    {
                        "code": "import_result_missing",
                        "message": t["title"]
                        + " has no saved result to review, so it cannot be imported.",
                        "task_id": tid,
                    }
                )
            live = self.one(
                "SELECT r.run_id FROM worker_runs r LEFT JOIN worker_run_tasks rt ON rt.run_id=r.run_id WHERE (r.task_id=%s OR rt.task_id=%s) AND r.ended_at IS NULL LIMIT 1",
                (tid, tid),
            )
            if live or self.live_turn(tid):
                blockers.append(
                    {
                        "code": "worker_live",
                        "message": t["title"] + " still has a worker or reservation.",
                        "task_id": tid,
                    }
                )
        if closed != set(task_ids):
            blockers.append(
                {
                    "code": "dependency_closure",
                    "message": "Confirm the complete connected group before importing.",
                }
            )
        validate_graph(closed, {tid: deps.get(tid, []) for tid in closed})
        guard = self.one(
            "SELECT revision FROM container_task_graph_guard WHERE container_id=%s",
            (cid,),
        )
        revision = guard["revision"] if guard else 1
        digest = _digest(
            {
                "revision": revision,
                "tasks": [all_tasks[t] for t in sorted(closed)],
                "dependencies": {t: sorted(deps.get(t, [])) for t in sorted(closed)},
            }
        )
        impacts = []
        for tid in sorted(closed):
            t = all_tasks[tid]
            assignees = [
                a["agent_id"]
                for a in self.rows(
                    "SELECT agent_id FROM agent_tasks WHERE task_id=%s AND assignment_status<>'done'",
                    (tid,),
                )
            ]
            complete = t["status"] == "completed"
            # Same rows as preview_digest: a changed result or criteria changes it.
            text, by = saved_result(t["result"]) if complete else (None, None)
            impacts.append(
                {
                    "id": tid,
                    "title": t["title"],
                    "status": t["status"],
                    "workflow_id": t["workflow_id"],
                    "eligible": not any(b.get("task_id") == tid for b in blockers),
                    "requires_acceptance": complete,
                    "result_digest": result_digest(t["result"]) if complete else None,
                    "description": t["description"],
                    "definition_of_done": t["definition_of_done"],
                    "completed_at": t["completed_at"] if complete else None,
                    "result_text": text,
                    "result_by_agent_id": by,
                    "preparation_state": (
                        "prepared"
                        if complete or (t["definition_of_done"].strip() and assignees)
                        else "draft"
                    ),
                    "start_hold": not complete,
                    "releasable": bool(
                        workflow
                        and workflow["status"] == "active"
                        and workflow["launch_enabled"]
                        and t["status"] in RELEASABLE_IMPORTS
                        and t["definition_of_done"].strip()
                        and assignees
                    ),
                    "human_hold_reason": IMPORT_HOLD_REASONS.get(t["status"]),
                    "assignee_ids": assignees,
                    "depends_on": deps.get(tid, []),
                }
            )
        return {
            "graph_revision": revision,
            "preview_digest": digest,
            "selected_task_ids": task_ids,
            "required_task_ids": sorted(closed - set(task_ids)),
            "blockers": blockers,
            "task_impacts": impacts,
            "save_starts_work": False,
        }

    def create(self, cid, actor, body):
        p = self.actor(actor, cid)
        if p["kind"] != "human":
            conflict(
                "human_required", "Only a person can create a workflow.", status=403
            )
        project = self.one("SELECT status FROM containers WHERE id=%s", (cid,))
        if project["status"] != "active":
            conflict("project_not_active", "Resume the project first.")
        if body.get("existing_task_ids") and not body.get("preview_digest"):
            conflict("preview_required", "Review the import preview before saving.")
        if (
            body.get("preview_digest")
            and body["preview_digest"]
            != self.preview_draft(cid, body)["preview_digest"]
        ):
            conflict(
                "preview_changed",
                "The workflow draft or imported work changed. Review it again.",
            )
        version = routing.semantics_for(body)
        wid = _id()
        self.cur.execute(
            "INSERT INTO workflows(id,container_id,owner_human_id,created_by_human_id,title,goal,execution_mode,semantics_version,turn_allowance) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                wid,
                cid,
                p["id"],
                p["id"],
                body["title"],
                body["goal"],
                body.get("execution_mode", "serial"),
                version,
                body.get("turn_allowance", 40),
            ),
        )
        w = self.workflow(wid)
        created = {"title": w["title"]}
        if body.get("existing_task_ids"):
            created["original_states"] = self._import(
                w,
                actor,
                body["existing_task_ids"],
                self.preview_import(cid, body["existing_task_ids"])["preview_digest"],
                body.get("import_acceptances", {}),
            )
        ids = self._add(w, actor, body.get("tasks", []))
        if routing.wants_flow(body):
            self._save_flow(
                w, *routing.draft_flow(body.get("tasks", []), body.get("repeat_groups", []), ids)
            )
        for o in body.get("objectives", []):
            self.cur.execute(
                "INSERT INTO workflow_objectives(id,workflow_id,title,criteria) VALUES (%s,%s,%s,%s)",
                (_id(), wid, o["title"], o["criteria"]),
            )
        self.audit(w, p, "workflow_created", created, scope=True)
        return wid

    def preview_draft(self, cid, body):
        from portal_backend.schemas.workflows import WorkflowDraft

        draft = WorkflowDraft.model_validate(
            {k: v for k, v in body.items() if k in WorkflowDraft.model_fields}
        ).model_dump(mode="json")
        preview = self.preview_import(cid, draft["existing_task_ids"])
        keys = [t["client_key"] for t in draft["tasks"]]
        if len(set(keys)) != len(keys) or set(keys) & set(draft["existing_task_ids"]):
            conflict(
                "duplicate_client_key",
                "Each task needs a distinct local key.",
                status=422,
            )
        ids = (
            set(keys)
            | set(draft["existing_task_ids"])
            | set(preview["required_task_ids"])
        )
        deps = {t["client_key"]: t["depends_on"] for t in draft["tasks"]}
        for row in self.rows(
            "SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.container_id=%s",
            (cid,),
        ):
            if row["task_id"] in ids:
                deps.setdefault(row["task_id"], []).append(row["depends_on_id"])
        validate_graph(ids, deps)
        routing.semantics_for(draft)
        if routing.wants_flow(draft):
            outcomes, routes, groups = routing.draft_flow(
                draft["tasks"], draft["repeat_groups"]
            )
            routing.check_flow(ids, deps, outcomes, routes, groups)
        preview["preview_digest"] = _digest(
            {"draft": draft, "import_digest": preview["preview_digest"]}
        )
        return preview

    def assign(self, task, aid):
        a = self.one(
            "SELECT * FROM agents WHERE id=%s AND container_id=%s AND terminated_at IS NULL",
            (aid, task["container_id"]),
        )
        if not a or a["kind"] != "ai":
            conflict(
                "assignee_unavailable",
                "Choose an available agent in this project.",
                status=422,
            )
        self.cur.execute(
            "UPDATE agent_tasks SET assignment_status='done' WHERE task_id=%s",
            (task["id"],),
        )
        self.cur.execute(
            "INSERT INTO agent_tasks(agent_id,task_id,assignment_status) VALUES (%s,%s,'assigned') ON CONFLICT (agent_id,task_id) DO UPDATE SET assignment_status='assigned',assigned_at=excluded.assigned_at",
            (aid, task["id"]),
        )

    def _save_flow(self, w, outcomes, routes, groups):
        """Validate the workflow's complete flow (stored plus proposed) and store it."""
        s = self.snapshot(w["id"])
        routing.check_flow(s["tasks"], s["dependencies"], outcomes, routes, groups)
        for g in groups:
            owner = g.get("escalation_owner_id")
            if owner and not self.one(
                "SELECT 1 AS present FROM agents WHERE id=%s AND container_id=%s AND kind='human' AND terminated_at IS NULL",
                (owner, w["container_id"]),
            ):
                conflict(
                    "escalation_owner_unavailable",
                    "Choose a person in this project to decide when a loop needs help.",
                    status=422,
                )
        routing.save_flow(self, w, outcomes, routes, groups)

    def _add(self, w, actor, specs):
        self.active(w)
        p = self.actor(actor, w["container_id"])
        if p["kind"] == "human":
            self.owner(w, actor)
        else:
            if not w["launch_enabled"]:
                conflict(
                    "workflow_not_started",
                    "Agents can add tasks after the owner starts the workflow.",
                )
            if not self.one(
                "SELECT 1 AS present FROM agent_tasks a JOIN tasks t ON t.id=a.task_id WHERE t.workflow_id=%s AND a.agent_id=%s",
                (w["id"], p["id"]),
            ):
                conflict(
                    "workflow_participation_required",
                    "This agent does not participate in the workflow.",
                    status=403,
                )
        existing = self.rows("SELECT * FROM tasks WHERE workflow_id=%s", (w["id"],))
        if len(existing) + len(specs) > w["task_limit"]:
            conflict("task_limit", "The task limit would be exceeded.")
        keys = [s["client_key"] for s in specs]
        if len(set(keys)) != len(keys) or any(
            k in {t["id"] for t in existing} for k in keys
        ):
            conflict(
                "duplicate_client_key",
                "Each new task needs a distinct local key.",
                status=422,
            )
        ids = {k: _id() for k in keys}
        for spec in specs:
            complete = bool(
                spec.get("definition_of_done", "").strip() and spec.get("assignee_id")
            )
            if p["kind"] == "ai" and not complete:
                conflict(
                    "prepared_task_required",
                    "Agent-created tasks need completion criteria and an assignee.",
                    status=422,
                )
            tid = ids[spec["client_key"]]
            self.cur.execute(
                "INSERT INTO tasks(id,container_id,workflow_id,title,description,definition_of_done,priority,status,created_by_agent_id,preparation_state,start_hold) VALUES (%s,%s,%s,%s,%s,%s,%s,'not_ready',%s,%s,%s)",
                (
                    tid,
                    w["container_id"],
                    w["id"],
                    spec["title"],
                    spec.get("description", ""),
                    spec.get("definition_of_done", ""),
                    spec.get("priority", 100),
                    p["id"],
                    "prepared" if p["kind"] == "ai" else "draft",
                    p["kind"] == "human",
                ),
            )
            if spec.get("assignee_id"):
                self.assign(self.task(w["id"], tid), spec["assignee_id"])
        s = self.snapshot(w["id"])
        for spec in specs:
            tid = ids[spec["client_key"]]
            s["dependencies"][tid] = [ids.get(x, x) for x in spec.get("depends_on", [])]
        validate_graph(s["tasks"], s["dependencies"])
        for spec in specs:
            tid = ids[spec["client_key"]]
            for prerequisite in s["dependencies"][tid]:
                self.cur.execute(
                    "INSERT INTO task_dependencies(task_id,depends_on_id) VALUES (%s,%s)",
                    (tid, prerequisite),
                )
        self.created_task_ids.update(ids)
        return ids

    def _import(self, w, actor, ids, digest, acceptances, release=()):
        preview = self.preview_import(w["container_id"], ids)
        if preview["blockers"]:
            conflict(
                "import_blocked",
                "The selected tasks cannot be imported.",
                blockers=preview["blockers"],
            )
        if preview["preview_digest"] != digest:
            conflict(
                "preview_changed",
                "The selected group changed. Review a fresh import preview.",
            )
        existing = self.one(
            "SELECT count(*) AS n FROM tasks WHERE workflow_id=%s", (w["id"],)
        )["n"]
        if existing + len(ids) > w["task_limit"]:
            conflict("task_limit", "The workflow task limit would be exceeded.")
        release = set(release)
        if len(release) != len(set(release) & set(ids)):
            conflict(
                "release_not_selected",
                "Only imported tasks can be released.",
                status=422,
            )
        if release and not w["launch_enabled"]:
            conflict("workflow_not_started", "Use Start to release the first tasks.")
        original = {}
        for tid in sorted(ids):
            t = self.one("SELECT * FROM tasks WHERE id=%s" + sql.for_update(), (tid,))
            original[str(tid)] = t["status"]
            completed = t["status"] == "completed"
            held = t["status"] in {"not_ready", "blocked"}
            assigned = bool(
                self.one(
                    "SELECT 1 AS n FROM agent_tasks WHERE task_id=%s AND assignment_status<>'done'",
                    (tid,),
                )
            )
            prepared = completed or bool(t["definition_of_done"].strip() and assigned)
            if tid in release and not (prepared and t["status"] in RELEASABLE_IMPORTS):
                conflict(
                    "release_not_allowed",
                    "Only a prepared task that was waiting can start when it joins.",
                    task_id=tid,
                )
            self.cur.execute(
                "UPDATE tasks SET workflow_id=%s,preparation_state=%s,start_hold=%s,human_hold_by=%s,human_hold_at=%s,human_hold_reason=%s,status=%s WHERE id=%s AND workflow_id IS NULL AND status=%s",
                (
                    w["id"],
                    "prepared" if prepared else "draft",
                    not completed and tid not in release,
                    actor.id if held else None,
                    sql.utcnow() if held else None,
                    IMPORT_HOLD_REASONS.get(t["status"]),
                    "completed" if completed else "not_ready",
                    tid,
                    t["status"],
                ),
            )
            if self.cur.rowcount != 1:
                conflict("import_changed", "A selected task changed during import.")
            if completed:
                self._accept_import(w, actor, tid, acceptances.get(tid))
        return original

    def _accept_import(self, w, actor, tid, acceptance):
        """Explicit human acceptance of an imported completed result, same transaction.

        Never treats completed status or legacy Full autonomy as acceptance.
        """
        if not acceptance:
            conflict(
                "import_acceptance_required",
                "Review and explicitly accept the imported result.",
                task_id=tid,
            )
        person = self.actor(actor, w["container_id"])
        if person["kind"] != "human":
            conflict(
                "human_approval_required",
                "A person must accept imported results.",
                status=403,
            )
        task = self.task(w["id"], tid)
        current = result_digest(task["result"])
        if not current:
            conflict(
                "import_result_missing",
                "This task has no saved result to review.",
                task_id=tid,
            )
        if acceptance["reviewed_result_digest"] != current:
            conflict(
                "import_result_changed",
                "The task result changed. Review it again.",
                task_id=tid,
            )
        if not self.basis_valid(
            acceptance["evidence"], self.snapshot(w["id"])["tasks"]
        ):
            conflict(
                "evidence_version_stale",
                "The supporting evidence changed or is unavailable.",
            )
        eid = _id()
        generation = self.one(
            "SELECT COALESCE(MAX(generation),0)+1 AS n FROM workflow_executions WHERE task_id=%s",
            (tid,),
        )["n"]
        self.cur.execute(
            "INSERT INTO workflow_executions(id,workflow_id,task_id,generation,work_revision,claimant_id,run_id,source_kind,exclusive,state) VALUES (%s,%s,%s,%s,%s,%s,NULL,'import_review',false,'awaiting_review')",
            (eid, w["id"], tid, generation, task["work_revision"], person["id"]),
        )
        execution = self.one("SELECT * FROM workflow_executions WHERE id=%s", (eid,))
        reference = self.hooks.capture_import(
            self.cur,
            task,
            acceptance["evidence"],
            execution,
            person,
            acceptance["reviewed_result_digest"],
        )
        now = sql.utcnow()
        self.cur.execute(
            "UPDATE workflow_executions SET current_evidence_set_id=%s,evidence_state='saved',worker_stopped_at=%s,state='released',released_at=%s,release_reason='imported result accepted' WHERE id=%s",
            (reference["evidence_set_id"], now, now, eid),
        )
        self._record_acceptance(task, actor, reference, "import")

    def op_add_tasks(self, w, actor, b, tid):
        ids = self._add(w, actor, b["tasks"])
        if any(t.get("outcomes") or t.get("routes") for t in b["tasks"]):
            if w.get("semantics_version", 1) != 2:
                conflict(
                    "flexible_disabled",
                    "Outcomes and next-step rules need the newer workflow version.",
                    status=422,
                )
            outcomes, routes, groups = routing.load_flow(self, w["id"])
            added_outcomes, added_routes, _ = routing.draft_flow(b["tasks"], [], ids)
            self._save_flow(
                w, {**outcomes, **added_outcomes}, {**routes, **added_routes}, groups
            )
        self.audit(
            w,
            self.actor(actor, w["container_id"]),
            "workflow_tasks_added",
            {"tasks": ids},
            scope=True,
        )

    def op_import(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w)
        original = self._import(
            w,
            actor,
            b["task_ids"],
            b["preview_digest"],
            b.get("acceptances", {}),
            b.get("release_task_ids", []),
        )
        self.audit(
            w,
            p,
            "workflow_tasks_imported",
            {
                "task_ids": b["task_ids"],
                "original_states": original,
                "released_task_ids": sorted(b.get("release_task_ids", [])),
            },
            scope=True,
        )

    def op_prepare(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w)
        t = self.task(w["id"], tid, b["expected_work_revision"])
        self.never_started(t)
        if t["status"] in {"completed", "cancelled"}:
            conflict("task_terminal", "This task cannot be prepared.")
        for field in ("title", "description", "definition_of_done"):
            if b.get(field) is not None:
                self.cur.execute(
                    f"UPDATE tasks SET {field}=%s WHERE id=%s", (b[field], tid)
                )
        if b.get("assignee_id"):
            self.assign(t, b["assignee_id"])
        t = self.task(w["id"], tid)
        if not t["definition_of_done"].strip() or not self.one(
            "SELECT 1 AS n FROM agent_tasks WHERE task_id=%s AND assignment_status<>'done'",
            (tid,),
        ):
            conflict(
                "task_incomplete",
                "Add completion criteria and choose an assignee first.",
            )
        # Start released the tasks that were prepared when it was pressed. A task the
        # owner prepares for the first time after that is their own go-ahead, so it
        # needs no second Release click. A task prepared before Start and left unselected
        # (or re-prepared later) keeps its hold, and a person's hold is never touched.
        released = bool(
            w["launch_enabled"]
            and t["start_hold"]
            and t["preparation_state"] != "prepared"
        )
        self.cur.execute(
            "UPDATE tasks SET preparation_state='prepared',work_revision=work_revision+1,start_hold=%s WHERE id=%s",
            (t["start_hold"] and not released, tid),
        )
        self.audit(
            w,
            p,
            "workflow_task_prepared",
            {
                "work_revision": t["work_revision"] + 1,
                **({"released": True} if released else {}),
            },
            tid,
            scope=True,
        )

    def _release(self, w, actor, b, *, start=False):
        p = self.owner(w, actor, project_owner=not start)
        self.active(w)
        if start and w["launch_enabled"]:
            conflict("already_started", "The workflow was already started.")
        ids = b["task_ids"]
        if len(set(ids)) != len(ids):
            conflict("duplicate_task", "Select each task once.", status=422)
        if start and not ids:
            s = self.snapshot(w["id"])
            if not s["tasks"] or not all(
                accepted(t, s["acceptances"]) for t in s["tasks"].values()
            ):
                conflict(
                    "prepared_selection_required", "Select at least one prepared task."
                )
        holds = ["start"] if start else b.get("holds", ["start"])
        for tid in sorted(ids):
            t = self.task(w["id"], tid, b["task_revisions"].get(tid))
            if tid not in b["task_revisions"]:
                conflict("task_revision_required", "Refresh the release preview.")
            if t["preparation_state"] != "prepared" or t["status"] in {
                "completed",
                "cancelled",
            }:
                conflict(
                    "task_not_prepared",
                    "Only prepared unfinished tasks can be released.",
                )
            self.no_turn(tid)
            if "start" in holds:
                self.owner(w, actor)
                if not start and not w["launch_enabled"] and t["start_hold"]:
                    # §14.1: Start performs the first release of start holds.
                    conflict(
                        "workflow_not_started",
                        "Use Start to release the first tasks.",
                    )
                self.cur.execute(
                    "UPDATE tasks SET start_hold=false WHERE id=%s", (tid,)
                )
            if "human" in holds and t["human_hold_by"]:
                if p["id"] != w["owner_human_id"] and p["id"] != t["human_hold_by"]:
                    conflict(
                        "hold_owner_required",
                        "A project owner may release only their own safety hold.",
                        status=403,
                    )
                self.cur.execute(
                    "UPDATE tasks SET human_hold_by=NULL,human_hold_at=NULL,human_hold_reason=NULL WHERE id=%s",
                    (tid,),
                )
        if start:
            self.cur.execute(
                "UPDATE workflows SET launch_enabled=true WHERE id=%s", (w["id"],)
            )
        self.audit(
            w,
            p,
            "workflow_started" if start else "workflow_task_released",
            {"task_ids": ids, "holds": holds},
        )

    def op_start(self, w, actor, b, tid):
        self._release(w, actor, b, start=True)
        if w.get("semantics_version", 1) == 2:
            outcomes, routes, groups = routing.load_flow(self, w["id"])
            s = self.snapshot(w["id"])
            routing.check_flow(s["tasks"], s["dependencies"], outcomes, routes, groups)
            for g in groups:
                self._start_round(w, g, "initial", g["member_tasks"], {})
            self._record_definition(w, actor, "start")

    def _assignees(self, wid):
        found = {}
        for r in self.rows(
            "SELECT a.task_id,a.agent_id FROM agent_tasks a JOIN tasks t ON t.id=a.task_id WHERE t.workflow_id=%s AND a.assignment_status='assigned'",
            (wid,),
        ):
            found.setdefault(r["task_id"], []).append(r["agent_id"])
        return found

    def _record_definition(self, w, actor, reason):
        w = self.workflow(w["id"])
        flow = routing.load_flow(self, w["id"])
        body = routing.definition_snapshot(
            self.snapshot(w["id"]), *flow, self._assignees(w["id"])
        )
        p = self.actor(actor, w["container_id"])
        return routing.record_definition_version(self, w, p["id"], reason, body)

    def _start_round(self, w, g, trigger, task_ids, inputs, **detail):
        """Open the next round of a repeat group for `task_ids` at their current work
        revisions. The caller has already bumped revisions for a repeat round."""
        number = (g.get("current_round") or 0) + 1
        rid = _id()
        self.cur.execute(
            "INSERT INTO workflow_group_rounds(id,group_id,workflow_id,round_number,trigger_kind,return_from_task_id,return_to_task_id,reason,inputs) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                rid,
                g["id"],
                w["id"],
                number,
                trigger,
                detail.get("return_from"),
                detail.get("return_to"),
                detail.get("reason"),
                _json(inputs),
            ),
        )
        for tid in task_ids:
            t = self.one("SELECT work_revision FROM tasks WHERE id=%s", (tid,))
            self.cur.execute(
                "INSERT INTO workflow_step_instances(task_id,work_revision,group_round_id) VALUES (%s,%s,%s) ON CONFLICT (task_id,work_revision) DO UPDATE SET group_round_id=excluded.group_round_id",
                (tid, t["work_revision"], rid),
            )
        self.cur.execute(
            "UPDATE workflow_repeat_groups SET current_round=%s,state='open' WHERE id=%s",
            (number, g["id"]),
        )
        g["current_round"], g["state"] = number, "open"
        return rid

    def op_release(self, w, actor, b, tid):
        self._release(w, actor, b)

    def op_hold(self, w, actor, b, tid):
        p = self.owner(w, actor, project_owner=True)
        self.active(w, allow_paused=True)
        t = self.task(w["id"], tid, b["expected_work_revision"])
        self.no_turn(tid)
        if t["status"] not in {"not_ready", "pending", "ready"}:
            conflict("task_not_waiting", "Only waiting tasks can be put on hold.")
        if t["human_hold_by"] and t["human_hold_by"] != p["id"]:
            conflict("hold_exists", "Another person's hold is already in place.")
        self.cur.execute(
            "UPDATE tasks SET human_hold_by=%s,human_hold_at=%s,human_hold_reason=%s,status='not_ready' WHERE id=%s",
            (p["id"], sql.utcnow(), b["reason"], tid),
        )
        self.audit(w, p, "workflow_task_held", {"reason": b["reason"]}, tid)

    def op_pause(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w)
        if not w["launch_enabled"]:
            conflict("workflow_not_started", "A preparing workflow cannot be paused.")
        self.cur.execute("UPDATE workflows SET status='paused' WHERE id=%s", (w["id"],))
        self.audit(w, p, "workflow_paused", {})

    def op_resume(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w, allow_paused=True)
        if w["status"] != "paused":
            conflict("workflow_not_paused", "This workflow is not paused.")
        self.cur.execute("UPDATE workflows SET status='active' WHERE id=%s", (w["id"],))
        self.audit(w, p, "workflow_resumed", {})

    def op_patch(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w, allow_paused=True)
        s = self.snapshot(w["id"])
        if (
            b.get("execution_mode")
            and b["execution_mode"] != w["execution_mode"]
            and any(e["state"] in LIVE_EXECUTIONS for e in s["executions"])
        ):
            conflict(
                "turns_not_drained",
                "Wait for all current turns before changing how work runs.",
            )
        if b.get("task_limit") and b["task_limit"] < len(s["tasks"]):
            conflict("task_limit", "The limit cannot be below the current task count.")
        if b.get("round_limit") and b["round_limit"] < max(
            (r["round_number"] for r in s["review_rounds"]), default=0
        ):
            conflict(
                "round_limit", "The limit cannot be below the current review round."
            )
        for field in (
            "title",
            "goal",
            "execution_mode",
            "task_limit",
            "round_limit",
            "turn_allowance",
        ):
            if b.get(field) is not None:
                self.cur.execute(
                    f"UPDATE workflows SET {field}=%s WHERE id=%s", (b[field], w["id"])
                )
        if b.get("goal") and b["goal"] != w["goal"]:
            self.cur.execute(
                "UPDATE workflows SET goal_revision=goal_revision+1 WHERE id=%s",
                (w["id"],),
            )
        # The gate clears only once the limit that was reached is raised: the
        # same test that set it (next round, or one more correction/review pair)
        # must now pass against the new limits.
        rounds = max((r["round_number"] for r in s["review_rounds"]), default=0)
        task_limit = b.get("task_limit") or w["task_limit"]
        round_limit = b.get("round_limit") or w["round_limit"]
        if (
            w["limit_reached"]
            and rounds < round_limit
            and len(s["tasks"]) + 2 <= task_limit
        ):
            self.cur.execute(
                "UPDATE workflows SET limit_reached=false WHERE id=%s", (w["id"],)
            )
        self.audit(w, p, "workflow_changed", b, scope=bool(b.get("goal")))

    def op_dependencies(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w)
        t = self.task(w["id"], tid, b["expected_work_revision"])
        self.never_started(t)
        s = self.snapshot(w["id"])
        s["dependencies"][tid] = b["depends_on"]
        validate_graph(s["tasks"], s["dependencies"])
        if any(s["tasks"][pid].get("withdrawn_at") for pid in b["depends_on"]):
            conflict(
                "withdrawn_dependency", "A withdrawn task cannot be a prerequisite."
            )
        self.cur.execute("DELETE FROM task_dependencies WHERE task_id=%s", (tid,))
        for pid in b["depends_on"]:
            self.cur.execute(
                "INSERT INTO task_dependencies(task_id,depends_on_id) VALUES (%s,%s)",
                (tid, pid),
            )
        self.cur.execute(
            "UPDATE tasks SET work_revision=work_revision+1 WHERE id=%s", (tid,)
        )
        self.audit(w, p, "workflow_dependencies_changed", b, tid, scope=True)

    def reserve_turn(self, tid, actor, run_id=None):
        require_capability()
        t = self.one("SELECT workflow_id FROM tasks WHERE id=%s", (tid,))
        if not t or not t["workflow_id"]:
            conflict("workflow_task_required", "A workflow task is required.")
        w = self.lock(t["workflow_id"])
        task = self.task(w["id"], tid)
        p = self.actor(actor, w["container_id"])
        s = self.snapshot(w["id"])
        choice = s["eligibility"][tid]
        if not choice["can_start"]:
            conflict(
                "not_eligible",
                "The task cannot take a turn yet.",
                blockers=choice["blockers"],
            )
        from portal_backend.workflow_review_handoff import guard_review_claim
        guard_review_claim(self, w['id'], tid, p['id'])
        assigned = p["kind"] == "ai" and self.one(
            "SELECT 1 AS n FROM agent_tasks WHERE task_id=%s AND agent_id=%s AND assignment_status<>'done'",
            (tid, p["id"]),
        )
        is_owner = p["kind"] == "human" and p["id"] == w["owner_human_id"]
        # A worker claim and an outside-result admission compete for one turn;
        # the claimant whose path is not the current one lost (plan 16.1).
        lost = None
        if choice["source_kind"] == "worker" and is_owner:
            lost = ("evidence_not_pending", "No outside result is waiting for review.")
        elif choice["source_kind"] == "evidence_review" and assigned:
            lost = (
                "owner_evidence_pending",
                "An outside result is waiting for review.",
            )
        if lost:
            conflict(
                "not_eligible",
                "The task cannot take a turn yet.",
                blockers=[{"code": lost[0], "message": lost[1], "task_id": tid}],
            )
        if choice["source_kind"] == "worker":
            if not assigned:
                conflict(
                    "assignee_required",
                    "Only the authenticated assigned worker can take this turn.",
                    status=403,
                )
            if not run_id:
                conflict(
                    "reserved_run_required",
                    "The runner must preallocate a run before reserving work.",
                )
        else:
            self.owner(w, actor)
            if run_id is not None:
                conflict(
                    "review_only_run", "An outside result does not launch a worker."
                )
        if choice["source_kind"] == "evidence_review" and (
            # Submitted against an older version of the task (criteria or
            # dependencies edited since), or its supporting evidence changed.
            s["outside_evidence"][tid]["work_revision"] != task["work_revision"]
            or not self.basis_valid(s["outside_evidence"][tid]["evidence"], s["tasks"])
        ):
            conflict(
                "evidence_version_stale",
                "The supporting outside evidence changed. Review it again.",
            )
        generation = self.one(
            "SELECT COALESCE(max(generation),0)+1 AS n FROM workflow_executions WHERE task_id=%s",
            (tid,),
        )["n"]
        eid = _id()
        if choice["source_kind"] == "evidence_review":
            self.cur.execute(
                "UPDATE tasks SET work_revision=work_revision+1 WHERE id=%s", (tid,)
            )
            task = self.task(w["id"], tid)
            self.cur.execute(
                "UPDATE task_outside_evidence SET work_revision=%s WHERE id=%s",
                (task["work_revision"], s["outside_evidence"][tid]["id"]),
            )
        self.cur.execute(
            "INSERT INTO workflow_executions(id,workflow_id,task_id,generation,work_revision,claimant_id,run_id,source_kind,exclusive,state) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                eid,
                w["id"],
                tid,
                generation,
                task["work_revision"],
                p["id"],
                run_id,
                choice["source_kind"],
                choice["exclusive"],
                "reserved" if run_id else "awaiting_review",
            ),
        )
        if choice["source_kind"] == "worker" and w.get("semantics_version", 1) == 2:
            # The run's turn allowance counts worker turns only (reviews do not).
            self.cur.execute(
                "UPDATE workflows SET turns_used=turns_used+1 WHERE id=%s", (w["id"],)
            )
        execution = self.one("SELECT * FROM workflow_executions WHERE id=%s", (eid,))
        if not run_id:
            evidence = s["outside_evidence"][tid]
            reference = self.hooks.capture_outside(self.cur, task, evidence, execution)
            self.cur.execute(
                "UPDATE workflow_executions SET current_evidence_set_id=%s,evidence_state='saved',worker_stopped_at=%s WHERE id=%s",
                (reference["evidence_set_id"], sql.utcnow(), eid),
            )
            self.cur.execute(
                "UPDATE task_outside_evidence SET state='admitted',execution_id=%s WHERE id=%s",
                (eid, evidence["id"]),
            )
            state = "needs_verification"
        else:
            state = "in_progress"
            self.cur.execute(
                "UPDATE agent_tasks SET assignment_status='working' WHERE task_id=%s AND agent_id=%s",
                (tid, p["id"]),
            )
        self.cur.execute(
            "UPDATE tasks SET status=%s,started_at=COALESCE(started_at,%s) WHERE id=%s",
            (state, sql.utcnow(), tid),
        )
        self.audit(
            w,
            p,
            "workflow_turn_reserved",
            {
                "execution_id": eid,
                "generation": generation,
                "source_kind": choice["source_kind"],
            },
            tid,
            scope=not run_id,
        )
        if not run_id:
            self.notice(
                w, "workflow_task_awaiting_acceptance", tid, task["work_revision"]
            )
        self.forget_ready(self.snapshot(w["id"]))
        return self.one("SELECT * FROM workflow_executions WHERE id=%s", (eid,))

    def submit_for_review(self, tid, execution_id, generation, reference):
        require_capability()
        t = self.one("SELECT workflow_id FROM tasks WHERE id=%s", (tid,))
        if not t or not t["workflow_id"]:
            conflict("workflow_task_required", "A workflow task is required.")
        w = self.lock(t["workflow_id"])
        task = self.task(w["id"], tid)
        e = self.live_turn(tid, lock=True)
        # Fence first: a revoked worker gets stale_generation even after cancel (§16.2).
        if (
            not e
            or e["id"] != execution_id
            or e["generation"] != generation
            or e["generation_revoked_at"]
            or e["work_revision"] != task["work_revision"]
            or e["state"] not in {"running", "awaiting_review"}
        ):
            conflict("stale_generation", "This worker no longer owns the task turn.")
        self.active(w, allow_paused=True)
        from portal_backend.workflow_review_handoff import require_clean
        require_clean(self, task)
        # Capture adapter has already bound the exact pending/saved set to this execution.
        if (
            not reference.get("evidence_set_id")
            or reference["evidence_set_id"] != e["current_evidence_set_id"]
        ):
            conflict(
                "evidence_version_stale",
                "The result is not bound to the current evidence set.",
            )
        self.cur.execute(
            "UPDATE tasks SET status='needs_verification' WHERE id=%s", (tid,)
        )
        self.cur.execute(
            "UPDATE workflow_executions SET state='awaiting_review' WHERE id=%s",
            (e["id"],),
        )
        self.notice(w, "workflow_task_awaiting_acceptance", tid, task["work_revision"])

    def _record_acceptance(self, task, actor, reference, source="verification"):
        p = self.actor(actor, task["container_id"])
        exact = self.hooks.validate_evidence(self.cur, task, reference)
        permission = self.hooks.authorize_completion(self.cur, task, p, exact)
        mode = permission["autonomy"]
        revision = permission["autonomy_revision"]
        if (
            mode not in {"off", "on"}
            or type(revision) is not int
            or revision < 1
            or (p["kind"] == "ai" and mode != "on")
        ):
            conflict(
                "completion_not_authorized",
                "This task completion is not authorized.",
                status=403,
            )
        self.cur.execute(
            "INSERT INTO workflow_task_acceptances(id,workflow_id,task_id,work_revision,actor_id,actor_kind,actor_alias,autonomy_at_acceptance,autonomy_revision,acceptance_source,evidence_set_id,evidence_items) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                _id(),
                task["workflow_id"],
                task["id"],
                task["work_revision"],
                p["id"],
                p["kind"],
                p["alias"],
                mode,
                revision,
                source,
                exact["evidence_set_id"],
                _json(exact["items"]),
            ),
        )
        return exact

    def accept_task(
        self,
        tid,
        actor,
        reference,
        *,
        expected_revision,
        expected_work_revision,
        idempotency_key,
    ):
        """Legacy verify/done adapter; exact revision + evidence + receipt, no shortcut."""
        t = self.one("SELECT container_id,workflow_id FROM tasks WHERE id=%s", (tid,))
        if not t or not t["workflow_id"]:
            conflict("workflow_task_required", "A workflow task is required.")
        return self.mutate(
            t["container_id"],
            actor,
            "accept",
            {
                "expected_revision": expected_revision,
                "expected_work_revision": expected_work_revision,
                "idempotency_key": idempotency_key,
                "evidence": reference,
            },
            wid=t["workflow_id"],
            tid=tid,
        )

    def reject_task(
        self,
        tid,
        actor,
        reason,
        *,
        expected_revision,
        expected_work_revision,
        idempotency_key,
    ):
        t = self.one("SELECT container_id,workflow_id FROM tasks WHERE id=%s", (tid,))
        if not t or not t["workflow_id"]:
            conflict("workflow_task_required", "A workflow task is required.")
        return self.mutate(
            t["container_id"],
            actor,
            "reject",
            {
                "expected_revision": expected_revision,
                "expected_work_revision": expected_work_revision,
                "idempotency_key": idempotency_key,
                "reason": reason,
            },
            wid=t["workflow_id"],
            tid=tid,
        )

    def op_accept(self, w, actor, b, tid):
        self.active(w, allow_paused=True)
        p = self.actor(actor, w["container_id"])
        t = self.task(w["id"], tid, b["expected_work_revision"])
        if t["status"] != "needs_verification":
            conflict("not_awaiting_review", "This task is not awaiting review.")
        from portal_backend.workflow_review_handoff import require_clean, acceptance_turn
        h = require_clean(self, t)
        if h and p['kind'] != 'human':
            conflict('human_approval_required', 'A person verifies the finished review loop.', status=403)
        e = self.live_turn(tid, lock=True) or acceptance_turn(self, t)
        if (
            not e
            or e["work_revision"] != t["work_revision"]
            or e["current_evidence_set_id"] != b["evidence"]["evidence_set_id"]
        ):
            conflict(
                "evidence_version_stale", "Refresh the current result and evidence."
            )
        if e["evidence_state"] == "missing":
            conflict(
                "evidence_missing", "Evidence is missing - add it before accepting."
            )
        if e["evidence_state"] != "saved":
            conflict(
                "evidence_not_saved", "The evidence for this result is not saved yet."
            )
        if e["source_kind"] == "evidence_review" and p["kind"] != "human":
            # §16.1: an outside result is accepted by a person, whatever the task autonomy.
            conflict(
                "human_approval_required",
                "A person must accept an outside result.",
                status=403,
            )
        exact = self._record_acceptance(t, actor, b["evidence"])
        self.cur.execute(
            "UPDATE tasks SET status='completed',completed_at=%s,awaiting_owner_decision=NULL,owner_decision_at=NULL WHERE id=%s",
            (sql.utcnow(), tid),
        )
        self.cur.execute(
            "UPDATE task_outside_evidence SET state='accepted',decided_by=%s,decided_at=%s WHERE task_id=%s AND state='admitted'",
            (p["id"], sql.utcnow(), tid),
        )
        self.cur.execute(
            "UPDATE agent_tasks SET assignment_status='done' WHERE task_id=%s", (tid,)
        )
        if e["worker_stopped_at"] or e["source_kind"] == "evidence_review":
            self._release_execution(e, "accepted")
        supplier = next(
            (
                item
                for item in exact["items"]
                if item.get("source") in {"owner", "outside"}
            ),
            None,
        )
        self.audit(
            w,
            p,
            "workflow_task_accepted",
            {
                "evidence": b["evidence"],
                "work_revision": t["work_revision"],
                "supplier_id": supplier.get("captured_by") if supplier else None,
                "supplier_alias": supplier.get("captured_by_alias") if supplier else None,
                "supplier_kind": supplier.get("captured_by_kind") if supplier else None,
                "same_person_supplier": bool(
                    supplier and str(supplier.get("captured_by")) == str(p["id"])
                ),
            },
            tid,
        )
        self._apply_route(w, self.task(w["id"], tid), p)

    # ---- Flexible workflows (semantics version 2): outcomes and routes ----------

    def op_report_outcome(self, w, actor, b, tid):
        self.active(w, allow_paused=True)
        if w.get("semantics_version", 1) != 2:
            conflict(
                "flexible_disabled",
                "This workflow does not use outcomes.",
                status=422,
            )
        p = self.actor(actor, w["container_id"])
        t = self.task(w["id"], tid, b["expected_work_revision"])
        e = self.live_turn(tid)
        if p["kind"] != "human" and (not e or e["claimant_id"] != p["id"]):
            conflict(
                "reporter_ineligible",
                "Only the step's current worker or a person can report its outcome.",
                status=403,
            )
        if t["status"] not in {"in_progress", "needs_verification"}:
            conflict(
                "not_reportable",
                "Report an outcome while the step is running or awaiting review.",
            )
        preview = routing.resolve(
            self.snapshot(w["id"]), routing.load_flow(self, w["id"]), tid, b["outcome"]
        )
        prior = self.one(
            "SELECT r.id,d.applied_at FROM workflow_outcome_reports r LEFT JOIN workflow_route_decisions d ON d.report_id=r.id WHERE r.task_id=%s AND r.work_revision=%s",
            (tid, t["work_revision"]),
        )
        if prior and prior["applied_at"]:
            conflict("route_applied", "This result's next step was already applied.")
        if prior:
            self.cur.execute(
                "DELETE FROM workflow_outcome_reports WHERE id=%s", (prior["id"],)
            )
        report_id = _id()
        self.cur.execute(
            "INSERT INTO workflow_outcome_reports(id,workflow_id,task_id,work_revision,generation,reporter_id,reporter_kind,outcome_name,findings,note,evidence_set_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                report_id,
                w["id"],
                tid,
                t["work_revision"],
                e["generation"] if e else None,
                p["id"],
                p["kind"],
                preview["outcome"],
                _json(b.get("findings", [])),
                b.get("note") or None,
                e["current_evidence_set_id"] if e else None,
            ),
        )
        group = self.one(
            "SELECT id FROM workflow_repeat_groups WHERE review_task_id=%s", (tid,)
        )
        self.cur.execute(
            "INSERT INTO workflow_route_decisions(id,workflow_id,report_id,destination_kind,destination_task_id,group_id,preview) VALUES (%s,%s,%s,%s,%s,%s,%s)",
            (
                _id(),
                w["id"],
                report_id,
                preview["destination"],
                preview["destination_task_id"],
                group["id"] if group else None,
                _json(preview),
            ),
        )
        self.audit(
            w,
            p,
            "workflow_outcome_reported",
            {
                "outcome": preview["outcome"],
                "work_revision": t["work_revision"],
                "findings": len(b.get("findings", [])),
                "route": preview["message"],
            },
            tid,
        )

    def routing_preview(self, tid, outcome, expected_work_revision):
        t = self.one("SELECT workflow_id FROM tasks WHERE id=%s", (tid,))
        if not t or not t["workflow_id"]:
            conflict("workflow_task_required", "A workflow task is required.", status=404)
        task = self.task(t["workflow_id"], tid, expected_work_revision)
        return routing.resolve(
            self.snapshot(task["workflow_id"]),
            routing.load_flow(self, task["workflow_id"]),
            tid,
            outcome,
        )

    def _apply_route(self, w, t, p):
        """Apply the route an accepted step's outcome selected, once (D4)."""
        if w.get("semantics_version", 1) != 2:
            return
        d = self.one(
            "SELECT d.*,r.outcome_name,r.findings,r.note FROM workflow_route_decisions d JOIN workflow_outcome_reports r ON r.id=d.report_id WHERE r.task_id=%s AND r.work_revision=%s",
            (t["id"], t["work_revision"]),
        )
        if not d:
            if self.one(
                "SELECT 1 AS present FROM workflow_step_outcomes WHERE task_id=%s LIMIT 1",
                (t["id"],),
            ):
                self.cur.execute(
                    "UPDATE tasks SET awaiting_loop_decision='missing_outcome' WHERE id=%s",
                    (t["id"],),
                )
                self.audit(w, p, "workflow_outcome_missing", {}, t["id"])
            return
        if d["applied_at"]:
            return
        flow = routing.load_flow(self, w["id"])
        preview = routing.resolve(self.snapshot(w["id"]), flow, t["id"], d["outcome_name"])
        result = self._route(w, t, p, preview, flow, d)
        self.cur.execute(
            "UPDATE workflow_route_decisions SET applied_at=%s,result=%s,preview=%s WHERE id=%s",
            (sql.utcnow(), result, _json(preview), d["id"]),
        )
        self.audit(
            w,
            p,
            "workflow_route_applied",
            {"outcome": d["outcome_name"], "result": result, "route": preview["message"]},
            t["id"],
        )

    def _route(self, w, t, p, preview, flow, d):
        for tid in preview["not_selected"]:
            self.cur.execute(
                "UPDATE tasks SET route_state='not_selected' WHERE id=%s", (tid,)
            )
        kind = preview["destination"]
        group = next((g for g in flow[2] if g["review_task"] == t["id"]), None)
        if kind == "ask_owner":
            self._loop_wait(t, group, "ask_owner", "awaiting_owner")
            return "ask_owner"
        if group and kind in {"exit_group", "stop", "next", "step"}:
            state = "stopped" if kind == "stop" else "exited"
            self._end_round(group, "stopped" if kind == "stop" else "exit")
            self.cur.execute(
                "UPDATE workflow_repeat_groups SET state=%s WHERE id=%s",
                (state, group["id"]),
            )
        if kind != "return":
            return kind
        if preview["blocked_by"] == "limit":
            self._end_round(group, "limit")
            self._loop_wait(t, group, "limit_reached", "limit_reached")
            return "limit_reached"
        stall = self._stall(group, d)
        if stall:
            self._end_round(group, "stall", stall)
            self._loop_wait(t, group, "stalled", "stalled")
            return "stalled"
        self._repeat(w, t, group, preview, d)
        return "new_round"

    def _loop_wait(self, t, group, decision, state):
        self.cur.execute(
            "UPDATE tasks SET awaiting_loop_decision=%s WHERE id=%s", (decision, t["id"])
        )
        if group:
            self.cur.execute(
                "UPDATE workflow_repeat_groups SET state=%s WHERE id=%s",
                (state, group["id"]),
            )

    def _end_round(self, group, reason, stall=None):
        self.cur.execute(
            "UPDATE workflow_group_rounds SET end_reason=%s,ended_at=%s,stall=%s WHERE group_id=%s AND round_number=%s AND ended_at IS NULL",
            (
                reason,
                sql.utcnow(),
                _json(stall) if stall else None,
                group["id"],
                group["current_round"],
            ),
        )

    def _stall(self, group, d):
        """Same findings and unchanged reviewed work as the previous round's review."""
        if group["stall_rule"] == "off" or (group["current_round"] or 0) < 2:
            return None
        previous = self.one(
            "SELECT r.findings,r.work_revision FROM workflow_outcome_reports r JOIN workflow_step_instances i ON i.task_id=r.task_id AND i.work_revision=r.work_revision JOIN workflow_group_rounds g ON g.id=i.group_round_id WHERE r.task_id=%s AND g.group_id=%s AND g.round_number=%s",
            (group["review_task"], group["id"], group["current_round"] - 1),
        )
        if not previous:
            return None

        def texts(findings):
            findings = json.loads(findings) if isinstance(findings, str) else findings
            return sorted(" ".join(f["text"].casefold().split()) for f in findings or [])

        if not texts(d["findings"]) or texts(d["findings"]) != texts(previous["findings"]):
            return None
        artifacts = []
        for rnd in (group["current_round"] - 1, group["current_round"]):
            artifacts.append(
                sorted(
                    (i["deliverable_id"], i["deliverable_version"])
                    for a in self.rows(
                        "SELECT a.evidence_items FROM workflow_task_acceptances a JOIN workflow_step_instances i ON i.task_id=a.task_id AND i.work_revision=a.work_revision JOIN workflow_group_rounds g ON g.id=i.group_round_id WHERE g.group_id=%s AND g.round_number=%s AND a.task_id<>%s",
                        (group["id"], rnd, group["review_task"]),
                    )
                    for i in (
                        json.loads(a["evidence_items"])
                        if isinstance(a["evidence_items"], str)
                        else a["evidence_items"]
                    )
                )
            )
        if artifacts[0] != artifacts[1]:
            return None
        return {
            "compared_rounds": [group["current_round"] - 1, group["current_round"]],
            "unchanged_findings": texts(d["findings"]),
            "artifact_unchanged": True,
            "method": "finding text and file versions",
        }

    def op_loop_decision(self, w, actor, b, tid):
        """Owner decisions at a round limit, a stall, a missing outcome or ask-the-owner."""
        p = self.owner(w, actor)
        self.active(w, allow_paused=True)
        tid = b["task_id"]
        t = self.task(w["id"], tid)
        waiting = t.get("awaiting_loop_decision")
        if not waiting:
            conflict("no_loop_decision", "This step is not waiting for a decision.")
        allowed = {
            "limit_reached": {"raise_limit", "reassign_continue", "accept_override", "stop"},
            "stalled": {"resume_stalled", "reassign_continue", "accept_override", "stop"},
            "missing_outcome": {"pick_outcome", "stop"},
            "ask_owner": {"pick_outcome", "stop"},
        }[waiting]
        kind = b["kind"]
        if kind not in allowed:
            conflict(
                "decision_not_available",
                "That choice is not available for this decision.",
                status=422,
                options=sorted(allowed),
            )
        flow = routing.load_flow(self, w["id"])
        group = next((g for g in flow[2] if g["review_task"] == tid), None)
        d = self.one(
            "SELECT d.*,r.outcome_name,r.findings,r.note FROM workflow_route_decisions d JOIN workflow_outcome_reports r ON r.id=d.report_id WHERE r.task_id=%s AND r.work_revision=%s",
            (tid, t["work_revision"]),
        )
        original = d["outcome_name"] if d else None
        self.cur.execute(
            "UPDATE tasks SET awaiting_loop_decision=NULL WHERE id=%s", (tid,)
        )
        if kind == "stop":
            s = self.snapshot(w["id"])
            for child in descendants(tid, s["dependencies"]):
                if s["tasks"][child]["status"] not in routing.STARTED:
                    self.cur.execute(
                        "UPDATE tasks SET route_state='not_selected' WHERE id=%s",
                        (child,),
                    )
            if group:
                self._end_round(group, "stopped")
                self.cur.execute(
                    "UPDATE workflow_repeat_groups SET state='stopped' WHERE id=%s",
                    (group["id"],),
                )
        elif kind == "accept_override":
            self._end_round(group, "accepted_override")
            self.cur.execute(
                "UPDATE workflow_repeat_groups SET state='exited' WHERE id=%s",
                (group["id"],),
            )
        elif kind == "pick_outcome":
            if not b.get("outcome"):
                conflict("outcome_required", "Choose an outcome.", status=422)
            preview = routing.resolve(self.snapshot(w["id"]), flow, tid, b["outcome"])
            if preview["destination"] == "ask_owner":
                conflict(
                    "decision_not_available",
                    "Choose an outcome that decides what happens next.",
                    status=422,
                )
            if d:
                self.cur.execute(
                    "DELETE FROM workflow_outcome_reports WHERE id=%s", (d["report_id"],)
                )
            report_id = _id()
            self.cur.execute(
                "INSERT INTO workflow_outcome_reports(id,workflow_id,task_id,work_revision,reporter_id,reporter_kind,outcome_name,findings,note) VALUES (%s,%s,%s,%s,%s,'human',%s,%s,%s)",
                (
                    report_id,
                    w["id"],
                    tid,
                    t["work_revision"],
                    p["id"],
                    preview["outcome"],
                    d["findings"] if d and isinstance(d["findings"], str) else _json(d["findings"] if d else []),
                    b.get("note") or (d["note"] if d else None),
                ),
            )
            self.cur.execute(
                "INSERT INTO workflow_route_decisions(id,workflow_id,report_id,destination_kind,destination_task_id,group_id,preview) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (
                    _id(),
                    w["id"],
                    report_id,
                    preview["destination"],
                    preview["destination_task_id"],
                    group["id"] if group else None,
                    _json(preview),
                ),
            )
            self._apply_route(w, self.task(w["id"], tid), p)
        else:
            if kind == "raise_limit":
                if not b.get("new_max_rounds") or b["new_max_rounds"] <= group["current_round"]:
                    conflict(
                        "round_limit",
                        "Raise the limit above the rounds already used.",
                        status=422,
                    )
                group["max_rounds"] = b["new_max_rounds"]
            elif kind == "reassign_continue":
                group["max_rounds"] = max(group["max_rounds"], group["current_round"] + 1)
            self.cur.execute(
                "UPDATE workflow_repeat_groups SET max_rounds=%s WHERE id=%s",
                (group["max_rounds"], group["id"]),
            )
            preview = routing.resolve(self.snapshot(w["id"]), flow, tid, original)
            if preview["destination"] != "return":
                conflict(
                    "decision_not_available",
                    "Only a send-back can continue the loop.",
                    status=422,
                )
            if kind == "reassign_continue" and b.get("assignee_id"):
                self.assign(
                    self.task(w["id"], preview["destination_task_id"]), b["assignee_id"]
                )
            self.cur.execute(
                "UPDATE workflow_route_decisions SET applied_at=COALESCE(applied_at,%s) WHERE id=%s",
                (sql.utcnow(), d["id"]),
            )
            self._repeat(
                w,
                t,
                group,
                preview,
                d,
                trigger={
                    "raise_limit": "owner_raise_limit",
                    "reassign_continue": "owner_reassign",
                    "resume_stalled": "owner_resume",
                }[kind],
                note=b.get("note") or None,
            )
        self.cur.execute(
            "INSERT INTO workflow_owner_decisions(id,workflow_id,task_id,group_id,subject_kind,chosen,original_outcome,detail,reason,decided_by) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                _id(),
                w["id"],
                tid,
                group["id"] if group else None,
                waiting,
                kind,
                original,
                _json(
                    {
                        k: b.get(k)
                        for k in ("new_max_rounds", "assignee_id", "outcome", "note")
                        if b.get(k)
                    }
                ),
                b.get("reason") or None,
                p["id"],
            ),
        )
        self.audit(
            w,
            p,
            "workflow_loop_decided",
            {"subject": waiting, "chosen": kind, "original_outcome": original},
            tid,
        )

    def _reopen(self, tid):
        latest = self.one(
            "SELECT agent_id FROM agent_tasks WHERE task_id=%s ORDER BY assigned_at DESC, agent_id DESC LIMIT 1",
            (tid,),
        )
        if latest:
            self.cur.execute(
                "UPDATE agent_tasks SET assignment_status='assigned' WHERE task_id=%s AND agent_id=%s",
                (tid, latest["agent_id"]),
            )
        self.cur.execute(
            "UPDATE tasks SET status='not_ready',work_revision=work_revision+1,awaiting_owner_decision=NULL,owner_decision_at=NULL,awaiting_loop_decision=NULL,completed_at=NULL WHERE id=%s",
            (tid,),
        )

    def _repeat(self, w, t, group, preview, d, trigger="return", note=None):
        """Start the next round: the repeat set gets new work revisions (D3), so their
        old acceptances go stale on their own; later steps that already used the old
        work are stopped and reopened too."""
        self._end_round(group, "return")
        for tid in preview["stale"]:
            e = self.live_turn(tid, lock=True)
            if e:
                self._release_execution(e, "stale_round")
        for tid in list(preview["repeats"]) + list(preview["stale"]):
            self._reopen(tid)
        findings = d["findings"]
        findings = json.loads(findings) if isinstance(findings, str) else findings
        self._start_round(
            w,
            group,
            trigger,
            preview["repeats"],
            {
                "outcome": d["outcome_name"],
                "findings": findings or [],
                "note": d.get("note"),
                "owner_note": note,
                "from_task_id": t["id"],
                "to_task_id": preview["destination_task_id"],
            },
            return_from=t["id"],
            return_to=preview["destination_task_id"],
            reason=d["outcome_name"],
        )

    def _release_execution(self, e, reason, lost=False):
        from portal_backend.workflow_review_handoff import interrupt_handoff
        w = self.one('SELECT * FROM workflows WHERE id=%s', (e['workflow_id'],))
        interrupt_handoff(self, w, reason, e['task_id'])
        self.cur.execute(
            "UPDATE workflow_executions SET state=%s,released_at=%s,release_reason=%s,generation_revoked_at=COALESCE(generation_revoked_at,%s) WHERE id=%s",
            (
                "released_lost" if lost else "released",
                sql.utcnow(),
                reason,
                sql.utcnow(),
                e["id"],
            ),
        )

    def _stop(self, w, t, actor, origin, reason):
        from portal_backend.workflow_review_handoff import interrupt_handoff
        interrupt_handoff(self, w, origin, t['id'])
        e = self.live_turn(t["id"], lock=True)
        if not e:
            return
        if e["source_kind"] == "evidence_review" or e["worker_stopped_at"]:
            self._release_execution(e, origin)
        else:
            self.hooks.request_stop(self.cur, e, actor, origin, reason)
            # Runtime hook persists the durable intent and revokes worker credentials.
            self.cur.execute(
                "UPDATE workflow_executions SET state='stopping',first_stop_at=COALESCE(first_stop_at,%s),generation_revoked_at=COALESCE(generation_revoked_at,%s) WHERE id=%s",
                (sql.utcnow(), sql.utcnow(), e["id"]),
            )

    def op_reject(self, w, actor, b, tid):
        p = self.actor(actor, w["container_id"])
        if p["kind"] != "human":
            conflict(
                "human_reviewer_required",
                "A verified human reviewer is required.",
                status=403,
            )
        self.active(w, allow_paused=True)
        t = self.task(w["id"], tid, b["expected_work_revision"])
        if t["status"] != "needs_verification":
            conflict("not_awaiting_review", "This task is not awaiting review.")
        if not b["reason"].strip():
            conflict("feedback_required", "Explain what needs to change.", status=422)
        self.cur.execute(
            "UPDATE tasks SET status='not_ready',awaiting_owner_decision='changes_requested',owner_decision_at=%s WHERE id=%s",
            (sql.utcnow(), tid),
        )
        self.cur.execute(
            "UPDATE task_outside_evidence SET state='rejected',decided_by=%s,decided_at=%s,decision_reason=%s WHERE task_id=%s AND state='admitted'",
            (p["id"], sql.utcnow(), b["reason"], tid),
        )
        self._stop(w, t, actor, "rejection", b["reason"])
        self.audit(
            w,
            p,
            "workflow_task_rejected",
            {"reason": b["reason"], "work_revision": t["work_revision"]},
            tid,
        )

    def op_stop(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w, allow_paused=True)
        t = self.task(w["id"], tid, b["expected_work_revision"])
        e = self.live_turn(tid)
        if not e or e["source_kind"] != "worker":
            conflict("no_running_worker", "Nothing is running; use On hold.")
        if e["state"] == "stopping":
            conflict("stop_already_requested", "A stop is already requested.")
        if t["status"] not in {"completed", "cancelled"}:
            self.cur.execute(
                "UPDATE tasks SET status='not_ready',awaiting_owner_decision='stopped_by_owner',owner_decision_at=%s WHERE id=%s",
                (sql.utcnow(), tid),
            )
        self._stop(w, t, actor, "task_stop", b["reason"])
        self.audit(w, p, "workflow_task_stop_requested", {"reason": b["reason"]}, tid)

    def release_confirmed(self, execution_id, generation, reason):
        """Final result/stop only, after evidence capture AND actual shutdown proof.

        Checkpoint exits use the runtime's confirm_stopped/continue_turn path and
        retain the same turn. They MUST NOT call this final-release adapter.
        """
        require_capability()
        e = self.one("SELECT * FROM workflow_executions WHERE id=%s", (execution_id,))
        if not e:
            conflict("execution_unavailable", "Task turn not found.", status=404)
        w = self.lock(e["workflow_id"])
        t = self.task(w["id"], e["task_id"])
        e = self.one(
            "SELECT * FROM workflow_executions WHERE id=%s" + sql.for_update(),
            (execution_id,),
        )
        if e["generation"] != generation:
            conflict("stale_generation", "The task turn changed.")
        if e["state"] not in LIVE_EXECUTIONS:
            return e
        self.cur.execute(
            "UPDATE workflow_executions SET worker_stopped_at=%s WHERE id=%s",
            (sql.utcnow(), e["id"]),
        )
        if t["status"] == "needs_verification" and e["state"] not in {
            "stopping",
            "recovery_needed",
        }:
            self.cur.execute(
                "UPDATE workflow_executions SET state='awaiting_review' WHERE id=%s",
                (e["id"],),
            )
        else:
            # A turn on an older work revision (a loop already started the next round)
            # ends without asking the owner anything.
            if (
                t["status"] not in {"completed", "cancelled"}
                and not t["awaiting_owner_decision"]
                and e["work_revision"] == t["work_revision"]
            ):
                self.cur.execute(
                    "UPDATE tasks SET status='not_ready',awaiting_owner_decision='worker_released',owner_decision_at=%s WHERE id=%s",
                    (sql.utcnow(), t["id"]),
                )
            self._release_execution(e, reason)
        self.audit(
            w,
            {"id": None, "kind": "system", "alias": "Worker runtime"},
            "workflow_worker_stop_confirmed",
            {"execution_id": e["id"], "generation": generation, "reason": reason},
            t["id"],
        )
        self.reconcile(w["id"])
        return self.one("SELECT * FROM workflow_executions WHERE id=%s", (e["id"],))

    def op_release_lost_worker(self, w, actor, b, tid):
        p = self.owner(w, actor)
        if w["status"] == "completed":
            conflict("workflow_completed", "Completed workflows are read-only.")
        t = self.task(w["id"], tid, b["expected_work_revision"])
        # Decide against the current deadline under the reservation lock (§17.2).
        e = self.live_turn(tid, lock=True)
        if not e:
            conflict("already_released", "This turn has already been released.")
        deadline = release_deadline(e)
        if not deadline or sql.utcnow() < deadline:
            conflict(
                "release_not_yet_available",
                "The worker has not been silent long enough.",
                release_available_at=sql.ts(deadline) if deadline else None,
            )
        # Integration MUST terminalize/capture evidence and fence before releasing capacity.
        self.hooks.request_stop(self.cur, e, actor, "lost_release", b["reason"])
        self._release_execution(e, b["reason"], lost=True)
        if (
            t["status"] not in {"completed", "cancelled"}
            and not t["awaiting_owner_decision"]
        ):
            self.cur.execute(
                "UPDATE tasks SET status='not_ready',awaiting_owner_decision='worker_released',owner_decision_at=%s WHERE id=%s",
                (sql.utcnow(), tid),
            )
        self.audit(
            w,
            p,
            "workflow_worker_released_lost",
            {"reason": b["reason"], "shutdown_confirmed": False},
            tid,
        )

    def op_reissue_stop(self, w, actor, b, tid):
        p = self.owner(w, actor)
        if w["status"] == "completed":
            conflict("workflow_completed", "Completed workflows are read-only.")
        t = self.task(w["id"], tid, b["expected_work_revision"])
        e = self.live_turn(tid, lock=True)
        if not e or e["state"] != "stopping":
            conflict("stop_not_pending", "There is no unconfirmed stop to send again.")
        self.hooks.request_stop(self.cur, e, actor, "recovery_reissue", b["reason"])
        self.audit(w, p, "workflow_stop_reissued", {"reason": b["reason"]}, tid)

    def op_retry(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w, allow_paused=True)
        t = self.task(w["id"], tid, b["expected_work_revision"])
        self.no_turn(tid)
        if t["withdrawn_at"]:
            conflict(
                "task_withdrawn", "Withdrawn tasks cannot be retried. Add a new task."
            )
        if t["status"] == "completed":
            s = self.snapshot(w["id"])
            for child in descendants(tid, s["dependencies"]):
                self.never_started(s["tasks"][child])
        elif not t["awaiting_owner_decision"] and t["status"] != "cancelled":
            conflict(
                "owner_decision_required", "This task does not need retry or reopening."
            )
        if self.one(
            "SELECT id FROM task_outside_evidence WHERE task_id=%s AND state IN ('pending','admitted')",
            (tid,),
        ):
            conflict(
                "owner_evidence_pending", "Withdraw the outside result before retrying."
            )
        if b.get("assignee_id"):
            self.assign(t, b["assignee_id"])
        else:
            # Restore only the latest assignee; agents replaced earlier stay done.
            latest = self.one(
                "SELECT agent_id FROM agent_tasks WHERE task_id=%s ORDER BY assigned_at DESC, agent_id DESC LIMIT 1",
                (tid,),
            )
            if latest:
                self.cur.execute(
                    "UPDATE agent_tasks SET assignment_status='assigned' WHERE task_id=%s AND agent_id=%s",
                    (tid, latest["agent_id"]),
                )
        self.cur.execute(
            "UPDATE tasks SET status='not_ready',work_revision=work_revision+1,awaiting_owner_decision=NULL,owner_decision_at=NULL,completed_at=NULL WHERE id=%s",
            (tid,),
        )
        self.audit(
            w,
            p,
            "workflow_task_retried",
            {"previous_work_revision": t["work_revision"]},
            tid,
            scope=True,
        )

    def op_withdraw(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w, allow_paused=True)
        t = self.task(w["id"], tid, b["expected_work_revision"])
        self.no_turn(tid)
        if not b["reason"].strip():
            conflict(
                "reason_required",
                "Explain why this task leaves the workflow's scope.",
                status=422,
            )
        if t["withdrawn_at"] or self.one(
            "SELECT id FROM workflow_task_acceptances WHERE task_id=%s", (tid,)
        ):
            conflict(
                "withdrawal_not_allowed",
                "Accepted or previously withdrawn work cannot be withdrawn.",
            )
        if self.one(
            "SELECT 1 AS n FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE d.depends_on_id=%s AND t.withdrawn_at IS NULL",
            (tid,),
        ):
            conflict(
                "task_has_dependents",
                "Change the unfinished dependents' prerequisites first.",
            )
        if (
            self.one(
                "SELECT count(*) AS n FROM tasks WHERE workflow_id=%s AND withdrawn_at IS NULL",
                (w["id"],),
            )["n"]
            <= 1
        ):
            conflict(
                "last_required_task", "Keep at least one required task in the workflow."
            )
        self.cur.execute(
            "UPDATE tasks SET status='cancelled',withdrawn_at=%s,withdrawn_by=%s,withdrawn_reason=%s,awaiting_owner_decision=NULL,owner_decision_at=NULL WHERE id=%s",
            (sql.utcnow(), p["id"], b["reason"], tid),
        )
        self.cur.execute(
            "UPDATE task_outside_evidence SET state='withdrawn',decided_by=%s,decided_at=%s,decision_reason=%s WHERE task_id=%s AND state='pending'",
            (p["id"], sql.utcnow(), b["reason"], tid),
        )
        self.audit(
            w, p, "workflow_task_withdrawn", {"reason": b["reason"]}, tid, scope=True
        )

    def op_external_result(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w, allow_paused=True)
        t = self.task(w["id"], tid, b["expected_work_revision"])
        self.no_turn(tid)
        if (
            t["status"] in {"completed", "cancelled"}
            or not t["definition_of_done"].strip()
        ):
            conflict(
                "outside_result_not_allowed",
                "Provide criteria for an unfinished task first.",
            )
        if self.one(
            "SELECT id FROM task_outside_evidence WHERE task_id=%s AND state IN ('pending','admitted')",
            (tid,),
        ):
            conflict("owner_evidence_pending", "An outside result is already waiting.")
        if not self.basis_valid(b["evidence"], self.snapshot(w["id"])["tasks"]):
            conflict(
                "evidence_version_stale",
                "The supporting evidence changed or is unavailable.",
            )
        eid = _id()
        self.cur.execute(
            "INSERT INTO task_outside_evidence(id,workflow_id,task_id,work_revision,submitted_by,evidence,produced_by,state,gate_reason_at_submit) VALUES (%s,%s,%s,%s,%s,%s,%s,'pending',%s)",
            (
                eid,
                w["id"],
                tid,
                t["work_revision"],
                p["id"],
                _json(b["evidence"]),
                b.get("produced_by"),
                t["awaiting_owner_decision"],
            ),
        )
        self.audit(
            w, p, "workflow_outside_result_submitted", {"outside_evidence_id": eid}, tid
        )
        self.notice(w, "workflow_evidence_waiting", tid, t["work_revision"])

    def op_withdraw_evidence(self, w, actor, b, tid):
        p = self.actor(actor, w["container_id"])
        self.active(w, allow_paused=True)
        t = self.task(w["id"], tid, b["expected_work_revision"])
        e = self.one(
            "SELECT * FROM task_outside_evidence WHERE id=%s AND task_id=%s AND state IN ('pending','admitted')",
            (b["evidence_id"], tid),
        )
        # The workflow owner or the verified person who submitted it (plan 16.1).
        if str(p["id"]) not in {str(w["owner_human_id"]), str(e and e["submitted_by"])}:
            self.owner(w, actor)
        if not e:
            conflict(
                "evidence_not_pending", "This outside result is no longer pending."
            )
        turn = self.live_turn(tid)
        if turn:
            if turn["source_kind"] != "evidence_review":
                conflict("reservation_live", "A worker still owns this turn.")
            self._release_execution(turn, "outside result withdrawn")
        self.cur.execute(
            "UPDATE task_outside_evidence SET state='withdrawn',decided_by=%s,decided_at=%s,decision_reason=%s WHERE id=%s",
            (p["id"], sql.utcnow(), b["reason"], e["id"]),
        )
        self.cur.execute(
            "UPDATE tasks SET status='not_ready',awaiting_owner_decision=%s,owner_decision_at=%s WHERE id=%s",
            (e["gate_reason_at_submit"] or "evidence_withdrawn", sql.utcnow(), tid),
        )
        self.audit(
            w,
            p,
            "workflow_outside_result_withdrawn",
            {"evidence_id": e["id"], "reason": b["reason"]},
            tid,
        )

    def op_cancel(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w, allow_paused=True)
        if not b["reason"].strip():
            conflict(
                "reason_required",
                "Explain why the workflow is being cancelled.",
                status=422,
            )
        s = self.snapshot(w["id"])
        self.cur.execute(
            "UPDATE workflows SET status='cancelled',cancelled_at=%s,cancelled_by_human_id=%s,cancellation_reason=%s WHERE id=%s",
            (sql.utcnow(), p["id"], b["reason"], w["id"]),
        )
        for task in s["tasks"].values():
            if task["id"] not in s["acceptances"]:
                self.cur.execute(
                    "UPDATE tasks SET status='cancelled',completed_at=%s,awaiting_owner_decision=NULL,owner_decision_at=NULL WHERE id=%s",
                    (sql.utcnow(), task["id"]),
                )
                self.cur.execute(
                    "UPDATE task_outside_evidence SET state='withdrawn',decided_at=%s,decided_by=%s,decision_reason=%s WHERE task_id=%s AND state IN ('pending','admitted')",
                    (sql.utcnow(), p["id"], b["reason"], task["id"]),
                )
            self._stop(w, task, actor, "workflow_cancel", b["reason"])
            self.cur.execute(
                "UPDATE agent_tasks SET assignment_status='done' WHERE task_id=%s",
                (task["id"],),
            )
            # Cancellation is a stop-work boundary. A scheduled task wake must
            # not revive the worker after the workflow has been cancelled.
            self.cur.execute(
                "DELETE FROM agent_self_wake WHERE task_id=%s", (task["id"],)
            )
        self.audit(w, p, "workflow_cancelled", {"reason": b["reason"]})

    def live_turns(self, wid):
        """Open worker turns (reserved/running/awaiting_review/stopping/recovery_needed)."""
        row = self.one(
            "SELECT count(*) AS n FROM workflow_executions WHERE workflow_id=%s AND state IN "
            "('reserved','running','awaiting_review','stopping','recovery_needed')",
            (wid,),
        )
        return int(row["n"]) if row else 0

    def visibility_check(self, wid):
        """GH #350 §4.14: fresh, read-only Hide / Restore eligibility with exact blockers.
        Hiding is a presentation change for FINISHED work only: it never stops a worker,
        never cancels, and never bypasses Finish. Restore never starts anything."""
        w = self.workflow(wid)
        task_count = self.one(
            "SELECT count(*) AS n FROM tasks WHERE workflow_id=%s", (wid,)
        )["n"]
        live = self.live_turns(wid)
        hidden = bool(w["hidden_at"])
        blockers = []
        if hidden:
            blockers.append(
                {"code": "workflow_hidden", "message": "This workflow is already hidden."}
            )
        if w["status"] not in {"completed", "cancelled"}:
            blockers.append(
                {
                    "code": "workflow_not_finished",
                    "message": "Finish or cancel the workflow before hiding it. "
                    "Hiding never stops work.",
                }
            )
        if live:
            blockers.append(
                {
                    "code": "worker_live",
                    "message": f"{live} worker turn(s) are still open. Wait for them to "
                    "stop before hiding this workflow.",
                }
            )
        return {
            "revision": w["revision"],
            "title": w["title"],
            "status": w["status"],
            "hidden": hidden,
            "task_count": int(task_count),
            "live_turns": live,
            "can_hide": not blockers,
            "can_restore": hidden,
            "blockers": blockers,
        }

    def op_hide(self, w, actor, b, tid):
        p = self.owner(w, actor, project_owner=True)
        check = self.visibility_check(w["id"])
        if not check["can_hide"]:
            first = check["blockers"][0]
            conflict(first["code"], first["message"])
        self.cur.execute(
            "UPDATE workflows SET hidden_at=%s,hidden_by_human_id=%s,hidden_reason=%s WHERE id=%s",
            (sql.utcnow(), p["id"], b.get("reason") or None, w["id"]),
        )
        # Presentation only: no task, dependency, evidence or execution row changes.
        self.audit(w, p, "workflow_hidden", {"reason": b.get("reason") or ""})

    def op_restore(self, w, actor, b, tid):
        p = self.owner(w, actor, project_owner=True)
        if not w["hidden_at"]:
            conflict("workflow_visible", "This workflow is not hidden.")
        self.cur.execute(
            "UPDATE workflows SET hidden_at=NULL,hidden_by_human_id=NULL,hidden_reason=NULL WHERE id=%s",
            (w["id"],),
        )
        # Status stays completed/cancelled, so restoring can never start a worker.
        self.audit(w, p, "workflow_restored", {"reason": b.get("reason") or ""})

    def op_accept_goal(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w, allow_paused=True)
        s = self.snapshot(w["id"])
        if not self.basis_valid(b["evidence"], s["tasks"]):
            conflict(
                "evidence_version_stale",
                "The goal evidence has changed or is unavailable.",
            )
        self.cur.execute(
            "UPDATE workflows SET goal_evidence=%s,goal_accepted_revision=goal_revision,goal_accepted_scope_revision=scope_revision,goal_accepted_by=%s,goal_accepted_at=%s WHERE id=%s",
            (_json(b["evidence"]), p["id"], sql.utcnow(), w["id"]),
        )
        self.audit(w, p, "workflow_goal_accepted", {"evidence": b["evidence"]})

    def op_accept_objective(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w, allow_paused=True)
        o = self.one(
            "SELECT * FROM workflow_objectives WHERE id=%s AND workflow_id=%s",
            (b["objective_id"], w["id"]),
        )
        if not o:
            conflict("objective_unavailable", "Objective not found.", status=404)
        if not self.basis_valid(b["evidence"], self.snapshot(w["id"])["tasks"]):
            conflict(
                "evidence_version_stale",
                "The objective evidence has changed or is unavailable.",
            )
        self.cur.execute(
            "UPDATE workflow_objectives SET evidence=%s,accepted_revision=revision,accepted_by=%s,accepted_at=%s WHERE id=%s",
            (_json(b["evidence"]), p["id"], sql.utcnow(), o["id"]),
        )
        self.audit(
            w,
            p,
            "workflow_objective_accepted",
            {"objective_id": o["id"], "evidence": b["evidence"]},
        )

    def op_finish(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w)
        completion = self.snapshot(w["id"])["completion"]
        if not completion["can_finish"]:
            conflict(
                "workflow_incomplete",
                "The workflow is not ready to finish.",
                blockers=completion["blockers"],
            )
        self.cur.execute(
            "UPDATE workflows SET status='completed',completed_at=%s,completed_by_human_id=%s WHERE id=%s",
            (sql.utcnow(), p["id"], w["id"]),
        )
        self.audit(w, p, "workflow_completed", {})

    def op_transfer_owner(self, w, actor, b, tid):
        p = self.owner(w, actor, project_owner=True)
        if w["status"] in {"completed", "cancelled"}:
            conflict("workflow_terminal", "This workflow is read-only.")
        new = self.one(
            "SELECT * FROM agents WHERE id=%s AND container_id=%s AND kind='human' AND terminated_at IS NULL AND member_role<>'viewer'",
            (b["new_owner_id"], w["container_id"]),
        )
        if not new:
            conflict(
                "owner_unavailable",
                "Choose a current human project member.",
                status=422,
            )
        self.cur.execute(
            "UPDATE workflows SET owner_human_id=%s WHERE id=%s", (new["id"], w["id"])
        )
        self.audit(
            w,
            p,
            "workflow_owner_transferred",
            {
                "previous_owner": w["owner_human_id"],
                "new_owner": new["id"],
                "reason": b["reason"],
            },
        )

    def op_review_round(self, w, actor, b, tid):
        p = self.actor(actor, w["container_id"])
        self.active(w)
        if p["kind"] == "human":
            self.owner(w, actor)
        elif not w["launch_enabled"]:
            conflict(
                "workflow_not_started",
                "Start the workflow before expanding a review loop.",
            )
        review = self.task(w["id"], b["review_task_id"])
        reviewed = self.task(w["id"], b["reviewed_task_id"])
        self.hooks.validate_evidence(self.cur, reviewed, b["reviewed_artifact"])
        previous = self.one(
            "SELECT * FROM workflow_review_rounds WHERE workflow_id=%s AND loop_key=%s ORDER BY round_number DESC LIMIT 1",
            (w["id"], b["loop_key"]),
        )
        if previous and previous["review_task_id"] != review["id"]:
            conflict(
                "review_round_changed",
                "Record the outcome against the latest review task.",
            )
        number = previous["round_number"] if previous else 1
        expanding_recorded = bool(
            previous
            and previous["outcome"] == "changes_requested"
            and b["outcome"] == "changes_requested"
            and b.get("correction")
            and previous["reviewed_artifact"] == b["reviewed_artifact"]
        )
        # An inconclusive review resolves nothing; once the human flow retries the
        # review task (newer work revision) its fresh outcome replaces it.
        rerecord = bool(
            previous
            and previous["outcome"] == "inconclusive"
            and review["work_revision"] > previous["review_work_revision"]
        )
        if previous and previous["outcome"] and not (expanding_recorded or rerecord):
            conflict(
                "review_outcome_recorded", "The review outcome is already recorded."
            )
        pair = []
        limit_hit = False
        if b["outcome"] == "changes_requested" and (
            b.get("correction") or b.get("next_review")
        ):
            if not b.get("correction") or not b.get("next_review"):
                conflict(
                    "review_pair_required",
                    "Provide a new correction and review task.",
                    status=422,
                )
            if (
                number >= w["round_limit"]
                or len(self.snapshot(w["id"])["tasks"]) + 2 > w["task_limit"]
            ):
                self.cur.execute(
                    "UPDATE workflows SET limit_reached=true WHERE id=%s", (w["id"],)
                )
                self.audit(w, p, "workflow_limit_reached", {"loop_key": b["loop_key"]})
                self.notice(
                    w,
                    "workflow_attention",
                    review["id"],
                    review["work_revision"],
                    "limit_reached",
                )
                limit_hit = True
            else:
                correction = dict(b["correction"], depends_on=[review["id"]])
                followup = dict(b["next_review"], depends_on=[correction["client_key"]])
                pair = [correction, followup]
        ids = self._add(w, actor, pair)
        rid = previous["id"] if previous else _id()
        if previous and (not previous["outcome"] or rerecord):
            self.cur.execute(
                "UPDATE workflow_review_rounds SET outcome=%s,reviewed_artifact=%s,reviewed_task_id=%s,reviewed_work_revision=%s,review_work_revision=%s WHERE id=%s",
                (
                    b["outcome"],
                    _json(b["reviewed_artifact"]),
                    reviewed["id"],
                    reviewed["work_revision"],
                    review["work_revision"],
                    rid,
                ),
            )
        elif not previous:
            self.cur.execute(
                "INSERT INTO workflow_review_rounds(id,workflow_id,loop_key,round_number,review_task_id,reviewed_artifact,reviewed_task_id,reviewed_work_revision,review_work_revision,outcome) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    rid,
                    w["id"],
                    b["loop_key"],
                    number,
                    review["id"],
                    _json(b["reviewed_artifact"]),
                    reviewed["id"],
                    reviewed["work_revision"],
                    review["work_revision"],
                    b["outcome"],
                ),
            )
        if pair:
            self.cur.execute(
                "INSERT INTO workflow_review_rounds(id,workflow_id,loop_key,round_number,prior_round_id,review_task_id,correction_task_id,reviewed_artifact) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    _id(),
                    w["id"],
                    b["loop_key"],
                    number + 1,
                    rid,
                    ids[pair[1]["client_key"]],
                    ids[pair[0]["client_key"]],
                    _json(b["reviewed_artifact"]),
                ),
            )
        self.audit(
            w,
            p,
            "workflow_review_outcome",
            {
                "loop_key": b["loop_key"],
                "round": number,
                "outcome": b["outcome"],
                "replaced_outcome": "inconclusive" if rerecord else None,
                "review_work_revision": review["work_revision"],
                "new_tasks": ids,
                "limit_reached": limit_hit,
            },
            scope=True,
        )

    def op_resolve_loop(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w, allow_paused=True)
        if not b["reason"].strip():
            conflict("reason_required", "Explain the owner's resolution.", status=422)
        r = self.one(
            "SELECT * FROM workflow_review_rounds WHERE workflow_id=%s AND review_task_id=%s",
            (w["id"], tid),
        )
        if not r or r["outcome"] == "accepted":
            conflict(
                "review_loop_unavailable", "There is no open review outcome to resolve."
            )
        self.cur.execute(
            "UPDATE workflow_review_rounds SET resolved_by_owner=%s,resolved_reason=%s WHERE id=%s",
            (p["id"], b["reason"], r["id"]),
        )
        self.audit(
            w,
            p,
            "workflow_review_resolved_by_owner",
            {"review_task_id": tid, "reason": b["reason"]},
            scope=True,
        )

    def op_edit_objective(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w, allow_paused=True)
        o = self.one(
            "SELECT * FROM workflow_objectives WHERE id=%s AND workflow_id=%s",
            (b["objective_id"], w["id"]),
        )
        if not o:
            conflict("objective_unavailable", "Objective not found.", status=404)
        self.cur.execute(
            "UPDATE workflow_objectives SET title=%s,criteria=%s,revision=revision+1,accepted_revision=NULL WHERE id=%s",
            (b["title"], b["criteria"], o["id"]),
        )
        self.audit(
            w,
            p,
            "workflow_objective_changed",
            {"objective_id": o["id"], "previous_revision": o["revision"]},
            scope=True,
        )

    def op_move(self, w, actor, b, tid):
        """Move a closed, never-started component at the source owner's direction."""
        p = self.owner(w, actor)
        self.active(w)
        ids = b["task_ids"]
        if len(set(ids)) != len(ids) or not ids or not b["reason"].strip():
            conflict(
                "invalid_move", "Select distinct tasks and give a reason.", status=422
            )
        destination = None
        if b.get("destination_workflow_id"):
            if b["destination_workflow_id"] == w["id"]:
                conflict("same_workflow", "These tasks are already in that workflow.")
            destination = self.lock(
                b["destination_workflow_id"], b.get("destination_revision")
            )
            if destination["container_id"] != w["container_id"]:
                conflict("workflow_unavailable", "Workflow not found.", status=404)
            if not b.get("destination_revision"):
                conflict(
                    "revision_required", "Refresh both workflows before moving tasks."
                )
            # A verified human source owner may move work into another active
            # workflow. The destination owner is notified by the durable audit
            # event and can hold, return or withdraw it through normal controls.
            self.active(destination)
            count = self.one(
                "SELECT count(*) AS n FROM tasks WHERE workflow_id=%s",
                (destination["id"],),
            )["n"]
            if count + len(ids) > destination["task_limit"]:
                conflict("task_limit", "The destination task limit would be exceeded.")
        s = self.snapshot(w["id"])
        if not set(ids).issubset(s["tasks"]):
            conflict("task_unavailable", "A selected task is unavailable.", status=404)
        if dependency_closure(ids, s["dependencies"]) != set(ids):
            conflict(
                "dependency_closure", "Move the complete connected group together."
            )
        for task_id in sorted(ids):
            task = self.task(w["id"], task_id)
            self.never_started(task)
            if task["status"] in {"completed", "cancelled"} or self.one(
                "SELECT id FROM task_outside_evidence WHERE task_id=%s LIMIT 1",
                (task_id,),
            ):
                conflict(
                    "task_history_present",
                    "Tasks with result history stay in their workflow.",
                )
        for task_id in sorted(ids):
            self.cur.execute(
                "UPDATE tasks SET workflow_id=%s,start_hold=%s,status='not_ready' WHERE id=%s AND workflow_id=%s",
                (
                    destination["id"] if destination else None,
                    bool(destination),
                    task_id,
                    w["id"],
                ),
            )
            if self.cur.rowcount != 1:
                conflict(
                    "membership_changed",
                    "A selected task moved. Refresh the selection.",
                )
            if not destination:
                self.cur.execute(
                    "UPDATE tasks SET preparation_state=NULL,human_hold_by=NULL,human_hold_at=NULL,human_hold_reason=NULL,awaiting_owner_decision=NULL,owner_decision_at=NULL WHERE id=%s",
                    (task_id,),
                )
        detail = {
            "task_ids": ids,
            "destination_workflow_id": destination["id"] if destination else None,
            "reason": b["reason"],
            "start_held": True,
        }
        self.audit(
            w,
            p,
            "workflow_tasks_moved" if destination else "workflow_tasks_removed",
            detail,
            scope=True,
        )
        if destination:
            self.audit(
                destination,
                p,
                "workflow_tasks_received",
                dict(detail, source_workflow_id=w["id"]),
                scope=True,
            )
            self.reconcile(destination["id"])

    def op_add_evidence(self, w, actor, b, tid):
        p = self.owner(w, actor)
        self.active(w, allow_paused=True)
        task = self.task(w["id"], tid, b["expected_work_revision"])
        if task["status"] in {"completed", "cancelled"} or task["withdrawn_at"]:
            conflict(
                "task_terminal",
                "Accepted, cancelled or withdrawn work cannot be replaced.",
            )
        execution = self.one(
            "SELECT * FROM workflow_executions WHERE task_id=%s AND work_revision=%s ORDER BY generation DESC LIMIT 1",
            (tid, task["work_revision"]),
        )
        if (
            not execution
            or execution["evidence_state"] != "missing"
            or not execution["current_evidence_set_id"]
        ):
            conflict(
                "missing_evidence_required",
                "Only the current missing evidence can be replaced.",
            )
        if execution["run_id"]:
            run = self.one(
                "SELECT ended_at FROM worker_runs WHERE run_id=%s",
                (execution["run_id"],),
            )
            if not run or not run["ended_at"]:
                conflict(
                    "worker_live",
                    "Wait for the worker to end before replacing evidence.",
                )
        if not self.basis_valid(b["evidence"], self.snapshot(w["id"])["tasks"]):
            conflict(
                "evidence_version_stale",
                "The supporting evidence changed or is unavailable.",
            )
        reference = self.hooks.capture_owner(
            self.cur, task, b["evidence"], execution, p
        )
        if reference["evidence_set_id"] == execution["current_evidence_set_id"]:
            conflict(
                "evidence_rebind_refused",
                "Replacement evidence needs a new immutable set.",
            )
        self.cur.execute(
            "UPDATE workflow_executions SET current_evidence_set_id=%s,evidence_state='saved' WHERE id=%s",
            (reference["evidence_set_id"], execution["id"]),
        )
        self.hooks.validate_evidence(self.cur, task, reference)
        self.audit(
            w,
            p,
            "workflow_evidence_replaced",
            {
                "previous_set_id": execution["current_evidence_set_id"],
                "evidence": reference,
            },
            tid,
        )
