package io.openorcha.mobile.data

/**
 * Workflows read models (mobile design #373, W01–W26). Field names follow the live
 * `/openapi.json` schemas exactly (`WorkflowDetail`, `WorkflowTask`, `Capability`, …);
 * every field defaults so an older or partial payload still decodes. Write bodies live in
 * DtosWorkflowWrites.kt. Labels the person sees come from these fields, never from us.
 */

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** `Capability`: read once per container session and on every stale recovery. */
@Serializable
data class WorkflowCapabilityDto(
    @SerialName("workflow_read") val workflowRead: Boolean = true,
    @SerialName("workflow_human_write") val workflowHumanWrite: Boolean = false,
    val reason: String? = null,
    @SerialName("flexible_workflows") val flexibleWorkflows: Boolean = false,
    @SerialName("semantics_versions_supported") val semanticsVersionsSupported: List<Int> = emptyList(),
)

@Serializable
data class WorkflowBlockerDto(
    val code: String = "",
    val message: String = "",
    @SerialName("task_id") val taskId: String? = null,
)

@Serializable
data class WorkflowCompletionDto(
    @SerialName("can_finish") val canFinish: Boolean = false,
    val blockers: List<WorkflowBlockerDto> = emptyList(),
)

@Serializable
data class WorkflowAvailableActionDto(
    val action: String = "",
    val enabled: Boolean = false,
    val reason: String? = null,
    val permission: String? = null,
    val holds: List<String>? = null,
)

@Serializable
data class WorkflowProgressDto(
    val accepted: Int = 0,
    val total: Int = 0,
    val percent: Int? = null,
    val withdrawn: Int = 0,
    @SerialName("objectives_accepted") val objectivesAccepted: Int = 0,
    @SerialName("objectives_total") val objectivesTotal: Int = 0,
)

@Serializable
data class WorkflowDisplayStateDto(
    val label: String = "",
    @SerialName("release_available") val releaseAvailable: Boolean = false,
    @SerialName("release_available_at") val releaseAvailableAt: String? = null,
    val warning: String? = null,
    @SerialName("list_warning") val listWarning: Boolean = false,
)

/** `StepOutcome` — also used in write bodies (kind defaults to "custom" on the server). */
@Serializable
data class StepOutcomeDto(
    val name: String = "",
    val kind: String? = null,
)

/** `StepRoute` — destination is next | step | return | ask_owner | exit_group | stop. */
@Serializable
data class StepRouteDto(
    val outcome: String = "",
    val destination: String = "",
    @SerialName("destination_task") val destinationTask: String? = null,
)

@Serializable
data class WorkflowFindingDto(
    val id: String? = null,
    val text: String = "",
    val severity: String? = null,
)

@Serializable
data class ReportedOutcomeDto(
    val outcome: String = "",
    val findings: List<WorkflowFindingDto> = emptyList(),
    val note: String = "",
    @SerialName("reporter_id") val reporterId: String? = null,
    @SerialName("reporter_kind") val reporterKind: String? = null,
    val applied: Boolean = false,
)

/** `AcceptedEvidenceItem` / `SavedEvidenceItem` (same shape; the saved one has every field). */
@Serializable
data class WorkflowEvidenceItemDto(
    @SerialName("item_id") val itemId: String = "",
    @SerialName("deliverable_id") val deliverableId: String = "",
    @SerialName("deliverable_version") val deliverableVersion: Int = 1,
    val sha256: String = "",
    val kind: String? = null,
    val source: String? = null,
    @SerialName("snapshot_phase") val snapshotPhase: String? = null,
    val complete: Boolean? = null,
    val note: String? = null,
    @SerialName("storage_state") val storageState: String? = null,
    @SerialName("captured_by") val capturedBy: String? = null,
    @SerialName("captured_by_alias") val capturedByAlias: String? = null,
    @SerialName("captured_by_kind") val capturedByKind: String? = null,
)

@Serializable
data class TaskAcceptanceDto(
    val id: String = "",
    @SerialName("work_revision") val workRevision: Int = 1,
    @SerialName("actor_id") val actorId: String = "",
    @SerialName("actor_kind") val actorKind: String = "human",
    @SerialName("actor_alias") val actorAlias: String = "",
    @SerialName("autonomy_at_acceptance") val autonomyAtAcceptance: String = "off",
    @SerialName("autonomy_revision") val autonomyRevision: Int = 1,
    @SerialName("acceptance_source") val acceptanceSource: String = "",
    @SerialName("evidence_set_id") val evidenceSetId: String = "",
    @SerialName("evidence_items") val evidenceItems: List<WorkflowEvidenceItemDto> = emptyList(),
    @SerialName("accepted_at") val acceptedAt: String = "",
)

@Serializable
data class WorkflowTaskDto(
    val id: String = "",
    val title: String = "",
    val description: String? = null,
    @SerialName("definition_of_done") val definitionOfDone: String = "",
    val status: String = "",
    @SerialName("work_revision") val workRevision: Int = 1,
    val autonomy: String = "off",
    @SerialName("autonomy_revision") val autonomyRevision: Int = 1,
    @SerialName("preparation_state") val preparationState: String? = null,
    @SerialName("start_hold") val startHold: Boolean = false,
    @SerialName("human_hold_by") val humanHoldBy: String? = null,
    @SerialName("human_hold_reason") val humanHoldReason: String? = null,
    @SerialName("awaiting_owner_decision") val awaitingOwnerDecision: String? = null,
    @SerialName("withdrawn_at") val withdrawnAt: String? = null,
    @SerialName("withdrawn_by") val withdrawnBy: String? = null,
    @SerialName("withdrawn_reason") val withdrawnReason: String? = null,
    val priority: Int = 100,
    @SerialName("assignee_ids") val assigneeIds: List<String> = emptyList(),
    @SerialName("depends_on") val dependsOn: List<String> = emptyList(),
    @SerialName("can_start") val canStart: Boolean = false,
    val blockers: List<WorkflowBlockerDto> = emptyList(),
    @SerialName("display_state") val displayState: WorkflowDisplayStateDto = WorkflowDisplayStateDto(),
    @SerialName("available_actions") val availableActions: List<WorkflowAvailableActionDto> = emptyList(),
    @SerialName("outside_result_id") val outsideResultId: String? = null,
    @SerialName("outside_result_state") val outsideResultState: String? = null,
    @SerialName("current_evidence_set_id") val currentEvidenceSetId: String? = null,
    @SerialName("evidence_state") val evidenceState: String? = null,
    val acceptance: TaskAcceptanceDto? = null,
    val outcomes: List<StepOutcomeDto> = emptyList(),
    val routes: List<StepRouteDto> = emptyList(),
    @SerialName("route_state") val routeState: String? = null,
    @SerialName("awaiting_loop_decision") val awaitingLoopDecision: String? = null,
    @SerialName("repeat_group_id") val repeatGroupId: String? = null,
    val round: Int? = null,
    @SerialName("reported_outcome") val reportedOutcome: ReportedOutcomeDto? = null,
)

@Serializable
data class EvidenceItemRefDto(
    @SerialName("item_id") val itemId: String,
    @SerialName("deliverable_id") val deliverableId: String,
    @SerialName("deliverable_version") val deliverableVersion: Int,
    val sha256: String,
)

/** `EvidenceReference` — read and written with the same shape. */
@Serializable
data class EvidenceReferenceDto(
    @SerialName("evidence_set_id") val evidenceSetId: String,
    val items: List<EvidenceItemRefDto>,
)

/** `EvidenceBasis` — read (objective evidence) and written (acceptances). */
@Serializable
data class EvidenceBasisDto(
    val narrative: String,
    @SerialName("task_revisions") val taskRevisions: Map<String, Int>? = null,
    @SerialName("evidence_sets") val evidenceSets: List<EvidenceReferenceDto>? = null,
)

@Serializable
data class WorkflowObjectiveDto(
    val id: String = "",
    val title: String = "",
    val criteria: String = "",
    val revision: Int = 1,
    @SerialName("accepted_revision") val acceptedRevision: Int? = null,
    val evidence: EvidenceBasisDto? = null,
    @SerialName("available_actions") val availableActions: List<WorkflowAvailableActionDto> = emptyList(),
)

@Serializable
data class ReviewHistoryDto(
    val id: String = "",
    @SerialName("loop_key") val loopKey: String = "",
    @SerialName("round_number") val roundNumber: Int = 0,
    @SerialName("review_task_id") val reviewTaskId: String = "",
    @SerialName("correction_task_id") val correctionTaskId: String? = null,
    val outcome: String? = null,
    @SerialName("reviewed_artifact") val reviewedArtifact: EvidenceReferenceDto? = null,
    @SerialName("reviewed_task_id") val reviewedTaskId: String? = null,
    @SerialName("reviewed_work_revision") val reviewedWorkRevision: Int? = null,
    @SerialName("review_work_revision") val reviewWorkRevision: Int? = null,
    @SerialName("resolved_by_owner") val resolvedByOwner: String? = null,
    @SerialName("resolved_reason") val resolvedReason: String? = null,
)

@Serializable
data class WorkflowActivityDto(
    val id: String = "",
    @SerialName("task_id") val taskId: String? = null,
    @SerialName("actor_alias") val actorAlias: String = "",
    @SerialName("actor_kind") val actorKind: String = "",
    val event: String = "",
    val revision: Int = 0,
    val detail: JsonObject = JsonObject(emptyMap()),
    @SerialName("created_at") val createdAt: String = "",
)

@Serializable
data class IntegrationCapabilityDto(
    val available: Boolean = false,
    val reason: String? = null,
)

@Serializable
data class RepeatGroupViewDto(
    val id: String = "",
    val name: String = "",
    @SerialName("member_tasks") val memberTasks: List<String> = emptyList(),
    @SerialName("review_task") val reviewTask: String = "",
    @SerialName("exit_outcome") val exitOutcome: String = "",
    @SerialName("max_rounds") val maxRounds: Int = 5,
    @SerialName("escalation_owner_id") val escalationOwnerId: String? = null,
    @SerialName("stall_rule") val stallRule: String = "",
    @SerialName("current_round") val currentRound: Int = 0,
    val state: String = "",
)

/** `Impact` — only on the check routes (`WorkflowImpact` = detail + impact). */
@Serializable
data class WorkflowImpactDto(
    val kind: String = "",
    val revision: Int = 0,
    @SerialName("graph_revision") val graphRevision: Int = 0,
    @SerialName("scope_revision") val scopeRevision: Int = 0,
    @SerialName("task_revisions") val taskRevisions: Map<String, Int> = emptyMap(),
    val holds: List<String> = emptyList(),
    val tasks: List<ImpactTaskDto> = emptyList(),
    @SerialName("counts_by_state") val countsByState: Map<String, Int> = emptyMap(),
    @SerialName("accepted_retained") val acceptedRetained: List<String> = emptyList(),
    @SerialName("workers_to_stop") val workersToStop: List<WorkerToStopDto> = emptyList(),
)

@Serializable
data class ImpactTaskDto(
    @SerialName("task_id") val taskId: String = "",
    val title: String = "",
    @SerialName("work_revision") val workRevision: Int = 1,
    val selected: Boolean = false,
    @SerialName("current_status") val currentStatus: String = "",
    @SerialName("resulting_status") val resultingStatus: String = "",
    @SerialName("can_start") val canStart: Boolean = false,
    val refusal: WorkflowBlockerDto? = null,
    val blockers: List<WorkflowBlockerDto> = emptyList(),
)

@Serializable
data class WorkerToStopDto(
    @SerialName("task_id") val taskId: String = "",
    @SerialName("agent_id") val agentId: String? = null,
    val name: String? = null,
)

/**
 * `WorkflowDetail` (and, with [impact] set, `WorkflowImpact`): the one shape every write
 * returns, so a confirmed write replaces the loaded detail without a second read.
 */
@Serializable
data class WorkflowDetailDto(
    val id: String = "",
    @SerialName("container_id") val containerId: String = "",
    val title: String = "",
    @SerialName("created_at") val createdAt: String? = null,
    val goal: String = "",
    @SerialName("owner_human_id") val ownerHumanId: String = "",
    val status: String = "active",
    @SerialName("execution_mode") val executionMode: String = "serial",
    @SerialName("launch_enabled") val launchEnabled: Boolean = false,
    val revision: Int = 1,
    @SerialName("graph_revision") val graphRevision: Int = 0,
    @SerialName("scope_revision") val scopeRevision: Int = 0,
    @SerialName("goal_revision") val goalRevision: Int = 0,
    @SerialName("goal_accepted_revision") val goalAcceptedRevision: Int? = null,
    @SerialName("task_limit") val taskLimit: Int = 0,
    @SerialName("round_limit") val roundLimit: Int = 0,
    @SerialName("limit_reached") val limitReached: Boolean = false,
    val capability: WorkflowCapabilityDto = WorkflowCapabilityDto(),
    @SerialName("available_actions") val availableActions: List<WorkflowAvailableActionDto> = emptyList(),
    val progress: WorkflowProgressDto = WorkflowProgressDto(),
    val completion: WorkflowCompletionDto = WorkflowCompletionDto(),
    val tasks: List<WorkflowTaskDto> = emptyList(),
    val objectives: List<WorkflowObjectiveDto> = emptyList(),
    @SerialName("review_rounds") val reviewRounds: List<ReviewHistoryDto> = emptyList(),
    val activity: List<WorkflowActivityDto> = emptyList(),
    @SerialName("activity_truncated") val activityTruncated: Boolean = false,
    val hidden: Boolean = false,
    @SerialName("hidden_at") val hiddenAt: String? = null,
    @SerialName("hidden_by_human_id") val hiddenByHumanId: String? = null,
    @SerialName("hidden_by_alias") val hiddenByAlias: String? = null,
    @SerialName("hidden_reason") val hiddenReason: String? = null,
    @SerialName("evidence_capability") val evidenceCapability: IntegrationCapabilityDto = IntegrationCapabilityDto(),
    @SerialName("created_task_ids") val createdTaskIds: Map<String, String> = emptyMap(),
    @SerialName("semantics_version") val semanticsVersion: Int = 1,
    @SerialName("definition_version") val definitionVersion: Int = 0,
    @SerialName("turn_allowance") val turnAllowance: Int = 40,
    @SerialName("turns_used") val turnsUsed: Int = 0,
    @SerialName("repeat_groups") val repeatGroups: List<RepeatGroupViewDto> = emptyList(),
    val impact: WorkflowImpactDto? = null,
)

@Serializable
data class WorkflowListDto(
    val workflows: List<WorkflowDetailDto> = emptyList(),
    val capability: WorkflowCapabilityDto = WorkflowCapabilityDto(),
    @SerialName("next_cursor") val nextCursor: String? = null,
)

/** `Receipt` — the uncertain-write check (`GET …/workflow-operations/{key}`). */
@Serializable
data class WorkflowReceiptDto(
    /** saved | not_found */
    val status: String = "not_found",
    val operation: String = "",
    @SerialName("idempotency_key") val idempotencyKey: String = "",
    val result: WorkflowDetailDto? = null,
)

@Serializable
data class WorkflowActivityPageDto(
    val activity: List<WorkflowActivityDto> = emptyList(),
    @SerialName("next_before_at") val nextBeforeAt: String? = null,
    @SerialName("next_before_id") val nextBeforeId: String? = null,
)

@Serializable
data class VisibilityCheckDto(
    val revision: Int = 1,
    val title: String = "",
    val status: String = "",
    val hidden: Boolean = false,
    @SerialName("task_count") val taskCount: Int = 0,
    @SerialName("live_turns") val liveTurns: Int = 0,
    @SerialName("can_hide") val canHide: Boolean = false,
    @SerialName("can_restore") val canRestore: Boolean = false,
    val blockers: List<WorkflowBlockerDto> = emptyList(),
)

/** `Preview` — create/add draft review and import preview. */
@Serializable
data class WorkflowPreviewDto(
    @SerialName("graph_revision") val graphRevision: Int = 0,
    @SerialName("preview_digest") val previewDigest: String = "",
    @SerialName("selected_task_ids") val selectedTaskIds: List<String> = emptyList(),
    @SerialName("required_task_ids") val requiredTaskIds: List<String> = emptyList(),
    val blockers: List<WorkflowBlockerDto> = emptyList(),
    @SerialName("task_impacts") val taskImpacts: List<ImportTaskImpactDto> = emptyList(),
    @SerialName("save_starts_work") val saveStartsWork: Boolean = false,
)

@Serializable
data class ImportTaskImpactDto(
    val id: String = "",
    val title: String = "",
    val status: String = "",
    @SerialName("workflow_id") val workflowId: String? = null,
    val eligible: Boolean = false,
    @SerialName("requires_acceptance") val requiresAcceptance: Boolean = false,
    @SerialName("result_digest") val resultDigest: String? = null,
    val description: String? = null,
    @SerialName("definition_of_done") val definitionOfDone: String = "",
    @SerialName("completed_at") val completedAt: String? = null,
    @SerialName("result_text") val resultText: String? = null,
    @SerialName("result_by_agent_id") val resultByAgentId: String? = null,
    @SerialName("preparation_state") val preparationState: String = "draft",
    @SerialName("start_hold") val startHold: Boolean = false,
    val releasable: Boolean = false,
    @SerialName("human_hold_reason") val humanHoldReason: String? = null,
    @SerialName("assignee_ids") val assigneeIds: List<String> = emptyList(),
    @SerialName("depends_on") val dependsOn: List<String> = emptyList(),
)

@Serializable
data class WorkflowTaskChoiceDto(
    val id: String = "",
    val title: String = "",
    val status: String = "",
    @SerialName("is_root") val isRoot: Boolean = false,
    @SerialName("workflow_id") val workflowId: String? = null,
)

@Serializable
data class WorkflowTaskSearchDto(
    val results: List<WorkflowTaskChoiceDto> = emptyList(),
    val selected: List<WorkflowTaskChoiceDto> = emptyList(),
)

/** `RoundContext` (#368) — the W06 round block. */
@Serializable
data class RoundContextDto(
    @SerialName("task_id") val taskId: String = "",
    @SerialName("workflow_id") val workflowId: String? = null,
    @SerialName("workflow_revision") val workflowRevision: Int? = null,
    @SerialName("work_revision") val workRevision: Int? = null,
    val outcomes: List<StepOutcomeDto> = emptyList(),
    val group: RoundGroupDto? = null,
)

@Serializable
data class RoundGroupDto(
    val name: String = "",
    val round: Int = 0,
    @SerialName("max_rounds") val maxRounds: Int = 0,
    val state: String = "",
    @SerialName("review_step") val reviewStep: String? = null,
    @SerialName("review_task_id") val reviewTaskId: String = "",
    @SerialName("is_review_step") val isReviewStep: Boolean = false,
    @SerialName("can_review_handoff") val canReviewHandoff: Boolean = false,
    @SerialName("exit_outcome") val exitOutcome: String = "",
    @SerialName("this_round") val thisRound: ThisRoundDto = ThisRoundDto(),
    @SerialName("earlier_rounds") val earlierRounds: List<EarlierRoundDto> = emptyList(),
)

@Serializable
data class RoundFindingDto(val text: String = "", val severity: String? = null)

@Serializable
data class ThisRoundDto(
    val trigger: String? = null,
    val outcome: String? = null,
    val findings: List<RoundFindingDto> = emptyList(),
    val note: String? = null,
    @SerialName("owner_note") val ownerNote: String? = null,
)

@Serializable
data class EarlierRoundDto(
    val round: Int = 0,
    val ended: String? = null,
    val outcome: String? = null,
    val findings: List<RoundFindingDto> = emptyList(),
)

/** `RoutingPreview` — what an outcome report will do (W09 "Review decision"). */
@Serializable
data class RoutingPreviewDto(
    @SerialName("task_id") val taskId: String = "",
    val outcome: String = "",
    val destination: String = "",
    @SerialName("destination_task_id") val destinationTaskId: String? = null,
    val group: String? = null,
    val round: Int? = null,
    @SerialName("rounds_remaining") val roundsRemaining: Int? = null,
    val repeats: List<String> = emptyList(),
    val kept: List<String> = emptyList(),
    val stale: List<String> = emptyList(),
    @SerialName("not_selected") val notSelected: List<String> = emptyList(),
    @SerialName("blocked_by") val blockedBy: String? = null,
    val message: String = "",
)

@Serializable
data class SavedEvidenceSetDto(
    @SerialName("evidence_set_id") val evidenceSetId: String = "",
    @SerialName("task_id") val taskId: String = "",
    @SerialName("workflow_id") val workflowId: String = "",
    @SerialName("workflow_execution_id") val workflowExecutionId: String = "",
    @SerialName("run_id") val runId: String? = null,
    @SerialName("work_revision") val workRevision: Int = 1,
    @SerialName("result_revision") val resultRevision: Int = 0,
    @SerialName("source_sequence") val sourceSequence: Int = 0,
    val generation: Int = 0,
    /** pending | saved | missing | superseded */
    val state: String = "",
    /** acceptance | attempt_record */
    val purpose: String = "",
    @SerialName("missing_reason") val missingReason: String? = null,
    @SerialName("terminal_cause") val terminalCause: String? = null,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("frozen_at") val frozenAt: String? = null,
    @SerialName("source_revision") val sourceRevision: String? = null,
    val items: List<WorkflowEvidenceItemDto> = emptyList(),
)

@Serializable
data class WorkflowTaskEvidenceDto(
    @SerialName("task_id") val taskId: String = "",
    @SerialName("workflow_id") val workflowId: String = "",
    @SerialName("current_evidence_set_id") val currentEvidenceSetId: String? = null,
    val sets: List<SavedEvidenceSetDto> = emptyList(),
    @SerialName("next_before_revision") val nextBeforeRevision: Int? = null,
)

@Serializable
data class TaskApprovalRecordDto(
    val id: String = "",
    val phase: String = "",
    @SerialName("work_revision") val workRevision: Int = 1,
    @SerialName("requirements_sha256") val requirementsSha256: String = "",
    @SerialName("submission_sha256") val submissionSha256: String = "",
    @SerialName("actor_id") val actorId: String = "",
    @SerialName("actor_kind") val actorKind: String = "",
    @SerialName("actor_alias") val actorAlias: String = "",
    @SerialName("autonomy_at_approval") val autonomyAtApproval: String = "",
    @SerialName("autonomy_revision") val autonomyRevision: Int = 1,
    @SerialName("permission_source") val permissionSource: String = "",
    @SerialName("approved_at") val approvedAt: String = "",
)

@Serializable
data class TaskApprovalHistoryDto(
    @SerialName("task_id") val taskId: String = "",
    val approvals: List<TaskApprovalRecordDto> = emptyList(),
)

@Serializable
data class TaskAutonomyResultDto(
    @SerialName("task_id") val taskId: String = "",
    val autonomy: String = "off",
    @SerialName("autonomy_revision") val autonomyRevision: Int = 1,
    val changed: Boolean = false,
    @SerialName("changed_at") val changedAt: String? = null,
)
