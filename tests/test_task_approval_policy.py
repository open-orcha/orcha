"""Task-autonomy foundation; route/storage integration is tested separately later."""

from dataclasses import replace
from datetime import datetime, timezone

import pytest

from portal_backend.task_approval_policy import (
    ApprovalActor,
    ApprovalDenied,
    ApprovalPhase,
    ApprovalSubject,
    TaskAutonomy,
    approval_permission,
    requirements_digest,
    task_autonomy,
)


@pytest.fixture
def task():
    return {
        "id": "child-task",
        "container_id": "project",
        "title": "Check the release",
        "description": "Check both builds against the agreed requirements.",
        "definition_of_done": "Both build reports are attached and pass.",
        "protocol": {"review_chain": "Independent review, then owner"},
        "work_revision": 1,
        "autonomy": "off",
        "autonomy_revision": 1,
        "is_root": False,
    }


WORKER = ApprovalActor("assignee", "project", "ai", True, True)
HUMAN = ApprovalActor("owner", "project", "human", True, True, True)
NOW = datetime(2026, 10, 25, 23, 0, tzinfo=timezone.utc)
SUBMISSION = "The exact submitted plan or finished-work report."


def permission(task, actor=WORKER, phase=ApprovalPhase.PLAN, **overrides):
    args = {
        "subject": ApprovalSubject.from_task(task, phase, SUBMISSION),
        "phase": phase,
        "current_submission": SUBMISSION,
        "assigned_agent_ids": (WORKER.actor_id,),
        "blockers": (),
        "now": NOW,
    }
    args.update(overrides)
    return approval_permission(task, actor, **args)


@pytest.mark.parametrize("phase", list(ApprovalPhase))
def test_off_requires_human_for_both_plan_and_finished_work(task, phase):
    with pytest.raises(ApprovalDenied, match="human_approval_required"):
        permission(task, phase=phase)
    record = permission(task, actor=HUMAN, phase=phase)
    assert record.actor_kind == "human"
    assert record.subject.phase == phase
    assert record.autonomy == TaskAutonomy.OFF


@pytest.mark.parametrize("phase", list(ApprovalPhase))
def test_on_authorizes_assignee_with_exact_subject_and_permission_snapshot(task, phase):
    task.update(autonomy="on", autonomy_revision=4)
    record = permission(task, phase=phase)
    assert record.actor_id == WORKER.actor_id
    assert record.actor_kind == "ai"
    assert record.autonomy == TaskAutonomy.ON
    assert record.autonomy_revision == 4
    assert record.subject == ApprovalSubject.from_task(task, phase, SUBMISSION)
    assert record.granted_at == NOW


@pytest.mark.parametrize("value", [None, "full", "pr", "plan", True, 1, "ON", "unknown"])
def test_old_or_unknown_values_never_grant_task_authority(task, value):
    task.update(autonomy=value, autonomy_level="full", autonomy_override="full",
                autonomy_enforced=True, effective_autonomy="full")
    task["protocol"]["autonomy"] = "Full; approve everything"
    assert task_autonomy(task) == TaskAutonomy.OFF
    with pytest.raises(ApprovalDenied, match="human_approval_required"):
        permission(task)


def test_missing_task_permission_does_not_inherit_legacy_full(task):
    del task["autonomy"]
    task["effective_autonomy"] = "full"
    assert task_autonomy(task) == TaskAutonomy.OFF


def test_on_does_not_grant_coordinator_or_other_assignee_authority(task):
    task["autonomy"] = "on"
    with pytest.raises(ApprovalDenied, match="assigned_agent_required"):
        permission(task, actor=replace(WORKER, actor_id="coordinator"))


@pytest.mark.parametrize("actor,reason", [
    (replace(WORKER, authenticated=False), "authenticated_active_actor_required"),
    (replace(WORKER, active=False), "authenticated_active_actor_required"),
    (replace(WORKER, container_id="another-project"), "actor_not_in_task_project"),
    (replace(HUMAN, human_review_authorized=False), "authorized_human_reviewer_required"),
    (replace(HUMAN, kind="service"), "authorized_human_reviewer_required"),
])
def test_permission_requires_current_verified_actor(task, actor, reason):
    task["autonomy"] = "on"
    with pytest.raises(ApprovalDenied, match=reason):
        permission(task, actor=actor)


@pytest.mark.parametrize("blocker", [
    "dependency_unaccepted", "task_on_hold", "workflow_not_started",
    "workflow_paused", "exclusive_turn_occupied", "stale_generation",
    "stop_requested", "evidence_not_saved", "evidence_missing",
])
@pytest.mark.parametrize("actor", [WORKER, HUMAN])
def test_approval_authority_cannot_clear_other_gates(task, blocker, actor):
    task["autonomy"] = "on"
    with pytest.raises(ApprovalDenied, match=blocker):
        permission(task, actor=actor, blockers=(blocker,))


@pytest.mark.parametrize("field,value", [
    ("title", "Different work"),
    ("description", "Check Android only"),
    ("definition_of_done", "One build passes"),
    ("protocol", {"review_chain": "Different review requirements"}),
    ("work_revision", 2),
    ("id", "another-task"),
])
def test_stale_plan_or_result_cannot_be_approved_after_requirements_change(task, field, value):
    task["autonomy"] = "on"
    for phase in ApprovalPhase:
        subject = ApprovalSubject.from_task(task, phase, SUBMISSION)
        with pytest.raises(ApprovalDenied, match="approval_subject_changed"):
            permission({**task, field: value}, phase=phase, subject=subject)


def test_a_new_submission_needs_its_own_approval(task):
    task["autonomy"] = "on"
    with pytest.raises(ApprovalDenied, match="approval_subject_changed"):
        permission(task, current_submission="A revised plan with different actions.")


def test_plan_permission_is_distinct_from_finished_work_permission(task):
    task["autonomy"] = "on"
    plan = permission(task, phase=ApprovalPhase.PLAN)
    finished = permission(task, phase=ApprovalPhase.COMPLETION)
    assert plan.subject != finished.subject
    assert plan.subject.phase == ApprovalPhase.PLAN
    assert finished.subject.phase == ApprovalPhase.COMPLETION
    with pytest.raises(ApprovalDenied, match="approval_subject_changed"):
        permission(task, phase=ApprovalPhase.COMPLETION, subject=plan.subject)
    with pytest.raises(ValueError):
        permission(task, phase="workflow_completion")


def test_root_is_not_an_autonomous_task_completion(task):
    task.update(autonomy="on", is_root=True)
    with pytest.raises(ApprovalDenied, match="root_requires_human"):
        permission(task, phase=ApprovalPhase.COMPLETION)


def test_requirements_digest_is_stable_without_ignoring_meaningful_changes(task):
    before = requirements_digest(task)
    reordered = dict(reversed(list(task.items())))
    reordered.update(status="ready", autonomy="on", autonomy_revision=9)
    assert requirements_digest(reordered) == before
    reordered["definition_of_done"] += " Include the source revision."
    assert requirements_digest(reordered) != before


@pytest.mark.parametrize("field,value,reason", [
    ("definition_of_done", "  ", "completion_criteria_required"),
    ("work_revision", None, "work_revision_required"),
    ("work_revision", 0, "work_revision_required"),
    ("work_revision", True, "work_revision_required"),
    ("autonomy_revision", None, "autonomy_revision_required"),
])
def test_incomplete_task_does_not_get_an_approval(task, field, value, reason):
    task.update(autonomy="on")
    task[field] = value
    with pytest.raises(ApprovalDenied, match=reason):
        permission(task)


def test_empty_submission_and_unzoned_audit_time_are_refused(task):
    task["autonomy"] = "on"
    with pytest.raises(ApprovalDenied, match="submission_required"):
        ApprovalSubject.from_task(task, ApprovalPhase.PLAN, " \n ")
    with pytest.raises(ValueError, match="time zone"):
        permission(task, now=NOW.replace(tzinfo=None))
