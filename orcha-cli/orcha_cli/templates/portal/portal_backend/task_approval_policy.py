"""Task-only approval authority for the Workflows integration.

This module is deliberately independent of the legacy project/agent settings. The
route adapters must resolve identity, lock the current task and compute scheduling
and evidence blockers before calling it. A returned permission is an audit snapshot,
not a task transition, execution permit or workflow completion.

Owner-only toggles apply to future decisions. Existing approvals keep the mode,
revision, actor and exact submitted work they were granted against.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Collection, Mapping


class TaskAutonomy(str, Enum):
    OFF = "off"
    ON = "on"


class ApprovalPhase(str, Enum):
    PLAN = "plan"
    COMPLETION = "completion"


class ApprovalDenied(ValueError):
    """A stable reason that a route can expose alongside its current blockers."""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


def task_autonomy(task: Mapping[str, Any]) -> TaskAutonomy:
    """Missing/unknown permission is OFF; legacy settings never grant authority.

    Write schemas must reject invalid enum values. This conservative read behavior
    also covers partial snapshots and older servers without a task-level field.
    Free-text protocol instructions are requirements, not a permission source.
    """
    return TaskAutonomy.ON if task.get("autonomy") == "on" else TaskAutonomy.OFF


def requirements_digest(task: Mapping[str, Any]) -> str:
    """Bind approval to the exact brief, completion criteria and working agreement.

    SQL JSON columns arrive as mappings on both supported database engines. JSON
    key order is immaterial; meaningful text, including whitespace, is preserved.
    Display status, assignment, autonomy and diagnostic output are not requirements.
    """
    requirements = {
        key: task.get(key)
        for key in ("title", "description", "definition_of_done", "protocol")
    }
    encoded = json.dumps(
        requirements, sort_keys=True, ensure_ascii=False, separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True)
class ApprovalSubject:
    """The submitted plan/result, separately from permission to accept it."""

    task_id: str
    work_revision: int
    requirements_digest: str
    phase: ApprovalPhase
    submission_digest: str

    @classmethod
    def from_task(
        cls, task: Mapping[str, Any], phase: ApprovalPhase, submission: str,
    ) -> ApprovalSubject:
        phase = ApprovalPhase(phase)
        if not submission.strip():
            raise ApprovalDenied("submission_required")
        if not str(task.get("definition_of_done") or "").strip():
            raise ApprovalDenied("completion_criteria_required")
        revision = task.get("work_revision")
        if type(revision) is not int or revision < 1:
            raise ApprovalDenied("work_revision_required")
        return cls(
            task_id=str(task["id"]),
            work_revision=revision,
            requirements_digest=requirements_digest(task),
            phase=phase,
            submission_digest=hashlib.sha256(submission.encode("utf-8")).hexdigest(),
        )


@dataclass(frozen=True)
class ApprovalActor:
    """Trusted identity facts supplied by an authenticated route, never its body."""

    actor_id: str
    container_id: str
    kind: str
    authenticated: bool
    active: bool
    human_review_authorized: bool = False


@dataclass(frozen=True)
class ApprovalPermission:
    """Authority at the decision time; persist with the exact accepted subject.

    Evidence-set/item references belong in the acceptance record maintained by the
    workflow service. Plan permissions cannot stand in for completion permissions.
    """

    subject: ApprovalSubject
    actor_id: str
    actor_kind: str
    autonomy: TaskAutonomy
    autonomy_revision: int
    granted_at: datetime


def approval_permission(
    task: Mapping[str, Any],
    actor: ApprovalActor,
    subject: ApprovalSubject,
    *,
    phase: ApprovalPhase,
    current_submission: str,
    assigned_agent_ids: Collection[str],
    blockers: Collection[str],
    now: datetime,
) -> ApprovalPermission:
    """Check current task-only authority, preserving every caller-supplied gate.

    Call inside the mutation's transaction with a freshly read task, verified actor
    and current submission. The shared admission/evidence service MUST supply the
    blockers; ON never clears a dependency, hold, stop or missing-evidence reason.
    This function neither authorizes changing autonomy nor judges completion quality.
    Direct requests do not use this gate and remain available in both modes.
    """
    if not actor.authenticated or not actor.active:
        raise ApprovalDenied("authenticated_active_actor_required")
    if actor.container_id != str(task["container_id"]):
        raise ApprovalDenied("actor_not_in_task_project")
    if subject != ApprovalSubject.from_task(task, phase, current_submission):
        raise ApprovalDenied("approval_subject_changed")
    if blockers:
        raise ApprovalDenied(next(iter(blockers)))
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("approval time must include a time zone")
    revision = task.get("autonomy_revision")
    if type(revision) is not int or revision < 1:
        raise ApprovalDenied("autonomy_revision_required")
    mode = task_autonomy(task)
    if actor.kind == "ai":
        if task.get("is_root"):
            raise ApprovalDenied("root_requires_human")
        if actor.actor_id not in assigned_agent_ids:
            raise ApprovalDenied("assigned_agent_required")
        if mode is not TaskAutonomy.ON:
            raise ApprovalDenied("human_approval_required")
    elif actor.kind != "human" or not actor.human_review_authorized:
        raise ApprovalDenied("authorized_human_reviewer_required")
    return ApprovalPermission(
        subject=subject,
        actor_id=actor.actor_id,
        actor_kind=actor.kind,
        autonomy=mode,
        autonomy_revision=revision,
        granted_at=now,
    )
