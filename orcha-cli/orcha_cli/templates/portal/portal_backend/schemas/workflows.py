"""Typed Workflows contracts. OpenAPI generated from these models is authoritative."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Name = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
]
Text = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)
]
Key = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Blocker(BaseModel):
    code: str
    message: str
    task_id: str | None = None


class Capability(BaseModel):
    workflow_read: bool = True
    workflow_human_write: bool = False
    reason: str | None = "integration_required"
    # Outcomes, next-step rules and repeat groups (semantics version 2) are behind the
    # server switch; clients hide that authoring when this is false.
    flexible_workflows: bool = False
    semantics_versions_supported: list[int] = Field(default_factory=lambda: [1])


class IntegrationCapability(BaseModel):
    available: bool = False
    reason: str | None = "integration_required"


class AvailableAction(BaseModel):
    action: str
    enabled: bool
    reason: str | None = None
    # Who may act: workflow_owner, workflow_or_project_owner, verified_human,
    # workflow_owner_or_submitter (the person who submitted that outside result),
    # workflow_owner_or_participant (an assigned agent, after Start) or
    # task_approval (the task's own approval rule).
    permission: str | None = None
    # release only: the holds THIS reader may clear (start: workflow owner;
    # human: workflow owner or the person who set that safety hold).
    holds: list[Literal["start", "human"]] | None = None


class EvidenceItem(Input):
    item_id: str
    deliverable_id: str
    deliverable_version: int = Field(ge=1)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class EvidenceReference(Input):
    evidence_set_id: str
    items: list[EvidenceItem] = Field(min_length=1)


class EvidenceBasis(Input):
    narrative: Text
    task_revisions: dict[str, int] = Field(default_factory=dict)
    evidence_sets: list[EvidenceReference] = Field(default_factory=list)


class ImportAcceptance(Input):
    """Explicit human acceptance of a completed standalone task's existing result."""

    reviewed_result_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    evidence: EvidenceBasis


OutcomeName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)
]
RouteDestination = Literal["next", "step", "return", "ask_owner", "exit_group", "stop"]


class StepOutcome(Input):
    """A result a step may report (semantics version 2). Outcomes are optional: a step
    without any behaves like a version-1 step and simply lets its dependents proceed."""

    name: OutcomeName
    kind: Literal["success", "changes", "failure", "custom"] = "custom"


class StepRoute(Input):
    """What happens next for one outcome. `step` is a branch to one direct dependent,
    `return` starts a new round of the reporter's repeat group at an earlier member."""

    outcome: OutcomeName
    destination: RouteDestination
    destination_task: str | None = None


class RepeatGroup(Input):
    """A bounded repeat-until loop: members repeat until the review step reports
    `exit_outcome`, at most `max_rounds` rounds before the owner decides."""

    name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)
    ]
    member_tasks: list[str] = Field(min_length=2, max_length=10)
    review_task: str
    exit_outcome: OutcomeName
    max_rounds: int = Field(default=5, ge=1, le=20)
    escalation_owner_id: str | None = None
    stall_rule: Literal["findings_and_artifact", "off"] = "findings_and_artifact"


class NewTask(Input):
    client_key: Key
    title: Name
    description: str = Field(default="", max_length=4000)
    definition_of_done: str = Field(default="", max_length=4000)
    assignee_id: str | None = None
    priority: int = 100
    depends_on: list[str] = Field(default_factory=list, max_length=3)
    outcomes: list[StepOutcome] = Field(default_factory=list, max_length=8)
    routes: list[StepRoute] = Field(default_factory=list, max_length=8)


class NewObjective(Input):
    title: Name
    criteria: Text


class WorkflowDraft(Input):
    title: Name
    goal: Text
    execution_mode: Literal["serial", "parallel"] = "serial"
    objectives: list[NewObjective] = Field(default_factory=list, max_length=50)
    tasks: list[NewTask] = Field(default_factory=list, max_length=200)
    existing_task_ids: list[str] = Field(default_factory=list, max_length=200)
    import_acceptances: dict[str, ImportAcceptance] = Field(default_factory=dict)
    # Version 2 (outcomes, routes, repeat groups) needs the server's flexible_workflows
    # capability; unset means "the newest this server supports".
    semantics_version: Literal[1, 2] | None = None
    repeat_groups: list[RepeatGroup] = Field(default_factory=list, max_length=5)
    turn_allowance: int = Field(default=40, ge=1, le=1000)


class WorkflowCreate(WorkflowDraft):
    idempotency_key: Key
    preview_digest: str | None = None


class Mutation(Input):
    expected_revision: int = Field(ge=1)
    idempotency_key: Key
    reason: str = Field(default="", max_length=4000)


class TaskMutation(Mutation):
    expected_work_revision: int = Field(ge=1)


class WorkflowPatch(Mutation):
    title: Name | None = None
    goal: Text | None = None
    execution_mode: Literal["serial", "parallel"] | None = None
    task_limit: int | None = Field(default=None, ge=1)
    round_limit: int | None = Field(default=None, ge=1)
    turn_allowance: int | None = Field(default=None, ge=1, le=1000)


class TaskBatch(Mutation):
    tasks: list[NewTask] = Field(min_length=1, max_length=200)


class ImportPreview(Input):
    task_ids: list[str] = Field(min_length=1, max_length=200)
    acceptances: dict[str, ImportAcceptance] = Field(default_factory=dict)


class ImportTasks(ImportPreview, Mutation):
    preview_digest: str
    # Ticked "Start this task when it is ready" (plan 14.1 import mapping):
    # only prepared tasks that were waiting, only in a started workflow.
    release_task_ids: list[str] = Field(default_factory=list, max_length=200)


class ReleaseTasks(Mutation):
    task_ids: list[str] = Field(default_factory=list, max_length=200)
    task_revisions: dict[str, int] = Field(default_factory=dict)
    holds: list[Literal["start", "human"]] = Field(
        default_factory=lambda: ["start"], min_length=1, max_length=2
    )


class PrepareTask(TaskMutation):
    title: Name | None = None
    description: str | None = Field(default=None, max_length=4000)
    definition_of_done: Text | None = None
    assignee_id: str | None = None


class DependencyEdit(TaskMutation):
    depends_on: list[str] = Field(max_length=3)


class RetryTask(TaskMutation):
    assignee_id: str | None = None


class OutsideResult(TaskMutation):
    evidence: EvidenceBasis
    produced_by: str | None = Field(default=None, max_length=200)


class AddEvidence(TaskMutation):
    evidence: EvidenceBasis


class AcceptTask(TaskMutation):
    evidence: EvidenceReference


class AcceptBasis(Mutation):
    evidence: EvidenceBasis


class TransferOwner(Mutation):
    new_owner_id: str


class ReviewRound(Mutation):
    loop_key: Key
    review_task_id: str
    reviewed_task_id: str
    reviewed_artifact: EvidenceReference
    outcome: Literal["changes_requested", "accepted", "inconclusive"]
    correction: NewTask | None = None
    next_review: NewTask | None = None


class Finding(Input):
    id: str | None = Field(default=None, max_length=80)
    text: Text
    severity: Literal["blocker", "major", "minor", "note"] | None = None


class OutcomeChoice(Input):
    outcome: OutcomeName
    expected_work_revision: int = Field(ge=1)


class OutcomeReport(TaskMutation):
    """The step's declared result. The route it selects is applied when the work is
    accepted under the step's own approval rule, never by the report itself."""

    outcome: OutcomeName
    findings: list[Finding] = Field(default_factory=list, max_length=50)
    note: str = Field(default="", max_length=4000)


class LoopDecision(Mutation):
    """The owner's choice when a loop or an outcome waits for them. Every decision is
    recorded beside the outcome that caused it."""

    kind: Literal[
        "raise_limit",
        "reassign_continue",
        "accept_override",
        "resume_stalled",
        "pick_outcome",
        "stop",
    ]
    task_id: str
    new_max_rounds: int | None = Field(default=None, ge=1, le=20)
    assignee_id: str | None = None
    outcome: OutcomeName | None = None
    note: str = Field(default="", max_length=4000)


class RoutingPreview(BaseModel):
    task_id: str
    outcome: str
    destination: RouteDestination
    destination_task_id: str | None = None
    group: str | None = None
    round: int | None = None
    rounds_remaining: int | None = None
    repeats: list[str] = Field(default_factory=list)
    kept: list[str] = Field(default_factory=list)
    stale: list[str] = Field(default_factory=list)
    not_selected: list[str] = Field(default_factory=list)
    blocked_by: Literal["limit"] | None = None
    message: str


class MoveTasks(Mutation):
    task_ids: list[str] = Field(min_length=1)
    destination_workflow_id: str | None = None
    destination_revision: int | None = Field(default=None, ge=1)


class DisplayState(BaseModel):
    label: str
    release_available: bool = False
    release_available_at: datetime | None = None
    warning: str | None = None
    list_warning: bool = False


class TaskAcceptance(BaseModel):
    """Immutable result acceptance for this exact task/work revision."""

    id: str
    work_revision: int = Field(ge=1)
    actor_id: str
    actor_kind: Literal["human", "ai"]
    actor_alias: str
    autonomy_at_acceptance: Literal["off", "on"]
    autonomy_revision: int = Field(ge=1)
    acceptance_source: str
    evidence_set_id: str
    evidence_items: list["AcceptedEvidenceItem"] = Field(min_length=1)
    accepted_at: datetime


class AcceptedEvidenceItem(BaseModel):
    item_id: str
    deliverable_id: str
    deliverable_version: int = Field(ge=1)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    kind: Literal[
        "result_summary", "file_changes", "log_excerpt", "owner_result",
        "outside_result", "import_result",
    ] | None = None
    source: Literal[
        "worker", "owner", "outside", "import", "cancelled_attempt",
        "released_attempt",
    ] | None = None
    snapshot_phase: Literal["submission", "terminal"] | None = None
    complete: bool | None = None
    note: str | None = None
    storage_state: Literal[
        "readable", "missing", "corrupt", "missing_after_restore"
    ] | None = None
    # Immutable supplier attribution captured with the evidence.  These remain
    # optional so historical acceptance records stay readable after upgrade.
    captured_by: str | None = None
    captured_by_alias: str | None = None
    captured_by_kind: Literal["human", "ai"] | None = None


class WorkflowTask(BaseModel):
    id: str
    title: str
    description: str | None = None
    definition_of_done: str
    status: str
    work_revision: int
    autonomy: Literal["off", "on"] = "off"
    autonomy_revision: int = 1
    preparation_state: str | None
    start_hold: bool
    human_hold_by: str | None
    human_hold_reason: str | None
    awaiting_owner_decision: str | None
    withdrawn_at: datetime | None
    withdrawn_by: str | None = None
    withdrawn_reason: str | None = None
    priority: int
    assignee_ids: list[str]
    depends_on: list[str]
    can_start: bool
    blockers: list[Blocker]
    display_state: DisplayState
    available_actions: list[AvailableAction]
    outside_result_id: str | None = None
    outside_result_state: str | None = None
    current_evidence_set_id: str | None = None
    evidence_state: str | None = None
    acceptance: TaskAcceptance | None = None
    # Semantics version 2 only; empty or null on version-1 workflows.
    outcomes: list[StepOutcome] = Field(default_factory=list)
    routes: list[StepRoute] = Field(default_factory=list)
    route_state: Literal["not_selected"] | None = None
    awaiting_loop_decision: (
        Literal["limit_reached", "stalled", "missing_outcome", "ask_owner"] | None
    ) = None
    repeat_group_id: str | None = None
    round: int | None = None


class Progress(BaseModel):
    accepted: int
    total: int
    percent: int | None
    withdrawn: int
    objectives_accepted: int
    objectives_total: int


class CompletionCheck(BaseModel):
    can_finish: bool
    blockers: list[Blocker]


class Objective(BaseModel):
    id: str
    title: str
    criteria: str
    revision: int
    accepted_revision: int | None
    evidence: EvidenceBasis | None = None
    available_actions: list[AvailableAction] = Field(default_factory=list)


class ReviewHistory(BaseModel):
    id: str
    loop_key: str
    round_number: int
    review_task_id: str
    correction_task_id: str | None = None
    outcome: str | None = None
    reviewed_artifact: EvidenceReference
    # The task and work revision the recorded outcome judged; null until recorded.
    reviewed_task_id: str | None = None
    reviewed_work_revision: int | None = None
    # The review task's own work revision when the outcome was recorded.
    review_work_revision: int | None = None
    resolved_by_owner: str | None = None
    resolved_reason: str | None = None


class Activity(BaseModel):
    id: str
    task_id: str | None = None
    actor_alias: str
    actor_kind: str
    event: str
    revision: int
    detail: dict
    created_at: datetime


class RepeatGroupView(BaseModel):
    id: str
    name: str
    member_tasks: list[str]
    review_task: str
    exit_outcome: str
    max_rounds: int
    escalation_owner_id: str | None = None
    stall_rule: str
    current_round: int
    state: str


class WorkflowDetail(BaseModel):
    id: str
    container_id: str
    title: str
    created_at: datetime | None = None
    goal: str
    owner_human_id: str
    status: Literal["active", "paused", "completed", "cancelled"]
    execution_mode: Literal["serial", "parallel"]
    launch_enabled: bool
    revision: int
    graph_revision: int
    scope_revision: int
    goal_revision: int
    goal_accepted_revision: int | None
    task_limit: int
    round_limit: int
    limit_reached: bool
    capability: Capability
    available_actions: list[AvailableAction]
    progress: Progress
    completion: CompletionCheck
    tasks: list[WorkflowTask]
    objectives: list[Objective]
    review_rounds: list[ReviewHistory] = Field(default_factory=list)
    activity: list[Activity] = Field(default_factory=list)
    activity_truncated: bool = False
    # GH #350 (spec §4.14): reversible deactivation is a VISIBILITY state, not a lifecycle
    # status. A hidden workflow keeps its completed/cancelled status, tasks, evidence and
    # history; it only leaves the usual list and ordinary task views until restored.
    hidden: bool = False
    hidden_at: datetime | None = None
    hidden_by_human_id: str | None = None
    hidden_by_alias: str | None = None
    hidden_reason: str | None = None
    evidence_capability: IntegrationCapability = Field(
        default_factory=IntegrationCapability
    )
    created_task_ids: dict[str, str] = Field(default_factory=dict)
    semantics_version: Literal[1, 2] = 1
    definition_version: int = 0
    turn_allowance: int = 40
    turns_used: int = 0
    repeat_groups: list[RepeatGroupView] = Field(default_factory=list)


class VisibilityCheck(BaseModel):
    """GH #350 (spec §4.14): fresh server eligibility for Hide / Restore. `can_hide` is true
    only for a completed or cancelled workflow with no live worker turn that is not already
    hidden; `can_restore` only for a hidden one. Blockers carry the exact reason."""

    revision: int
    title: str
    status: Literal["active", "paused", "completed", "cancelled"]
    hidden: bool
    task_count: int
    live_turns: int
    can_hide: bool
    can_restore: bool
    blockers: list[Blocker] = Field(default_factory=list)


class ImpactTask(BaseModel):
    task_id: str
    title: str
    work_revision: int
    selected: bool
    current_status: str
    resulting_status: Literal[
        "refused",
        "unchanged",
        "blocked",
        "waiting_for_prerequisites",
        "ready",
        "takes_turn_alone",
    ]
    can_start: bool
    refusal: Blocker | None = None
    blockers: list[Blocker] = Field(default_factory=list)


class WorkerToStop(BaseModel):
    task_id: str
    agent_id: str | None = None
    name: str | None = None


class Impact(BaseModel):
    kind: Literal["start", "release", "cancellation"]
    revision: int
    graph_revision: int
    scope_revision: int
    task_revisions: dict[str, int]
    holds: list[Literal["start", "human"]] = Field(default_factory=list)
    tasks: list[ImpactTask] = Field(default_factory=list)
    counts_by_state: dict[str, int] = Field(default_factory=dict)
    accepted_retained: list[str] = Field(default_factory=list)
    workers_to_stop: list[WorkerToStop] = Field(default_factory=list)


class WorkflowImpact(WorkflowDetail):
    """The full detail plus what the previewed Start, release or cancel would do."""

    impact: Impact


class WorkflowList(BaseModel):
    workflows: list[WorkflowDetail]
    capability: Capability
    next_cursor: str | None = None


class WorkflowTaskChoice(BaseModel):
    id: str
    title: str
    status: str
    is_root: bool
    workflow_id: str | None = None


class WorkflowTaskSearch(BaseModel):
    results: list[WorkflowTaskChoice] = Field(max_length=5)
    selected: list[WorkflowTaskChoice] = Field(max_length=200)


class ImportTaskImpact(BaseModel):
    id: str
    title: str
    status: str
    workflow_id: str | None = None
    eligible: bool
    requires_acceptance: bool
    result_digest: str | None = None
    # What the person reviews for a completed import, bound to preview_digest.
    description: str | None = None
    definition_of_done: str
    completed_at: datetime | None = None
    result_text: str | None = None
    result_by_agent_id: str | None = None
    preparation_state: Literal["draft", "prepared"]
    start_hold: bool
    # True when the owner may tick it to start on import; otherwise the
    # preview says it will not run until released.
    releasable: bool = False
    human_hold_reason: str | None = None
    assignee_ids: list[str]
    depends_on: list[str]


class Preview(BaseModel):
    graph_revision: int
    preview_digest: str
    selected_task_ids: list[str]
    required_task_ids: list[str]
    blockers: list[Blocker]
    task_impacts: list[ImportTaskImpact] = Field(default_factory=list)
    save_starts_work: Literal[False] = False


class ObjectiveEdit(Mutation):
    title: Name
    criteria: Text


class ActivityPage(BaseModel):
    activity: list[Activity]
    next_before_at: datetime | None = None
    next_before_id: str | None = None


class Receipt(BaseModel):
    status: Literal["saved", "not_found"]
    operation: str
    idempotency_key: str
    result: WorkflowDetail | None = None
