package io.openorcha.mobile.data

/**
 * Workflows write bodies, typed from the live `/openapi.json` request schemas. The server
 * forbids extra fields on every one of them, so these carry exactly the schema's fields.
 * Required fields have NO Kotlin default: the wire Json does not encode defaults, so a
 * defaulted required field could silently drop out of the body. Optional fields default
 * to null (omitted, `explicitNulls = false`) and the server applies its own default.
 */

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** `Mutation` — pause, resume, cancel, finish, hide, restore, resolve findings. */
@Serializable
data class WorkflowMutationBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    val reason: String? = null,
)

/** `TaskMutation` — hold, stop, reissue-stop, release-lost-worker, withdraw, reject, withdraw outside result. */
@Serializable
data class WorkflowTaskMutationBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    @SerialName("expected_work_revision") val expectedWorkRevision: Int,
    val reason: String? = null,
)

/** `ReleaseTasks` — start and release. */
@Serializable
data class WorkflowReleaseBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    val reason: String? = null,
    @SerialName("task_ids") val taskIds: List<String>? = null,
    @SerialName("task_revisions") val taskRevisions: Map<String, Int>? = null,
    val holds: List<String>? = null,
)

/** `PrepareTask`. */
@Serializable
data class WorkflowPrepareBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    @SerialName("expected_work_revision") val expectedWorkRevision: Int,
    val reason: String? = null,
    val title: String? = null,
    val description: String? = null,
    @SerialName("definition_of_done") val definitionOfDone: String? = null,
    @SerialName("assignee_id") val assigneeId: String? = null,
)

/** `RetryTask`. */
@Serializable
data class WorkflowRetryBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    @SerialName("expected_work_revision") val expectedWorkRevision: Int,
    val reason: String? = null,
    @SerialName("assignee_id") val assigneeId: String? = null,
)

/** `DependencyEdit` — the full replacement `depends_on`. */
@Serializable
data class WorkflowDependencyEditBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    @SerialName("expected_work_revision") val expectedWorkRevision: Int,
    @SerialName("depends_on") val dependsOn: List<String>,
    val reason: String? = null,
)

/** `AcceptTask`. */
@Serializable
data class WorkflowAcceptTaskBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    @SerialName("expected_work_revision") val expectedWorkRevision: Int,
    val evidence: EvidenceReferenceDto,
    val reason: String? = null,
)

/** `OutcomeChoice` — `POST /api/tasks/{tid}/outcome/preview`. */
@Serializable
data class WorkflowOutcomeChoiceBody(
    val outcome: String,
    @SerialName("expected_work_revision") val expectedWorkRevision: Int,
)

/** `Finding` as written (id and severity optional). */
@Serializable
data class WorkflowFindingBody(
    val text: String,
    val id: String? = null,
    val severity: String? = null,
)

/** `OutcomeReport`. */
@Serializable
data class WorkflowOutcomeReportBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    @SerialName("expected_work_revision") val expectedWorkRevision: Int,
    val outcome: String,
    val findings: List<WorkflowFindingBody>? = null,
    val note: String? = null,
    val reason: String? = null,
)

/** `OutsideResult`. */
@Serializable
data class WorkflowOutsideResultBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    @SerialName("expected_work_revision") val expectedWorkRevision: Int,
    val evidence: EvidenceBasisDto,
    @SerialName("produced_by") val producedBy: String? = null,
    val reason: String? = null,
)

/** `AddEvidence` — replace missing evidence. */
@Serializable
data class WorkflowAddEvidenceBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    @SerialName("expected_work_revision") val expectedWorkRevision: Int,
    val evidence: EvidenceBasisDto,
    val reason: String? = null,
)

/** `AcceptBasis` — objective and goal acceptance (W13). */
@Serializable
data class WorkflowAcceptBasisBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    val evidence: EvidenceBasisDto,
    val reason: String? = null,
)

/** `StepOutcome` as written. */
@Serializable
data class StepOutcomeBody(
    val name: String,
    val kind: String? = null,
)

/** `StepRoute` as written. */
@Serializable
data class StepRouteBody(
    val outcome: String,
    val destination: String,
    @SerialName("destination_task") val destinationTask: String? = null,
)

/** `NewTask` — a draft step (create, add tasks, review-round follow-ups). */
@Serializable
data class WorkflowNewTaskBody(
    @SerialName("client_key") val clientKey: String,
    val title: String,
    val description: String? = null,
    @SerialName("definition_of_done") val definitionOfDone: String? = null,
    @SerialName("assignee_id") val assigneeId: String? = null,
    val priority: Int? = null,
    @SerialName("depends_on") val dependsOn: List<String>? = null,
    val outcomes: List<StepOutcomeBody>? = null,
    val routes: List<StepRouteBody>? = null,
)

/** `RepeatGroup` as written (create only on the phone, design §1 principle 5). */
@Serializable
data class WorkflowRepeatGroupBody(
    val name: String,
    @SerialName("member_tasks") val memberTasks: List<String>,
    @SerialName("review_task") val reviewTask: String,
    @SerialName("exit_outcome") val exitOutcome: String,
    @SerialName("max_rounds") val maxRounds: Int? = null,
    @SerialName("escalation_owner_id") val escalationOwnerId: String? = null,
    @SerialName("stall_rule") val stallRule: String? = null,
)

@Serializable
data class WorkflowNewObjectiveBody(
    val title: String,
    val criteria: String,
)

/** `ImportAcceptance`. */
@Serializable
data class WorkflowImportAcceptanceBody(
    @SerialName("reviewed_result_digest") val reviewedResultDigest: String,
    val evidence: EvidenceBasisDto,
)

/** `WorkflowDraft` — `POST /api/containers/{cid}/workflows/preview`. */
@Serializable
data class WorkflowDraftBody(
    val title: String,
    val goal: String,
    @SerialName("execution_mode") val executionMode: String? = null,
    val objectives: List<WorkflowNewObjectiveBody>? = null,
    val tasks: List<WorkflowNewTaskBody>? = null,
    @SerialName("existing_task_ids") val existingTaskIds: List<String>? = null,
    @SerialName("import_acceptances") val importAcceptances: Map<String, WorkflowImportAcceptanceBody>? = null,
    @SerialName("semantics_version") val semanticsVersion: Int? = null,
    @SerialName("repeat_groups") val repeatGroups: List<WorkflowRepeatGroupBody>? = null,
    @SerialName("turn_allowance") val turnAllowance: Int? = null,
)

/** `WorkflowCreate` — the draft plus the idempotency key and the reviewed digest. */
@Serializable
data class WorkflowCreateBody(
    val title: String,
    val goal: String,
    @SerialName("idempotency_key") val idempotencyKey: String,
    @SerialName("execution_mode") val executionMode: String? = null,
    val objectives: List<WorkflowNewObjectiveBody>? = null,
    val tasks: List<WorkflowNewTaskBody>? = null,
    @SerialName("existing_task_ids") val existingTaskIds: List<String>? = null,
    @SerialName("import_acceptances") val importAcceptances: Map<String, WorkflowImportAcceptanceBody>? = null,
    @SerialName("semantics_version") val semanticsVersion: Int? = null,
    @SerialName("repeat_groups") val repeatGroups: List<WorkflowRepeatGroupBody>? = null,
    @SerialName("turn_allowance") val turnAllowance: Int? = null,
    @SerialName("preview_digest") val previewDigest: String? = null,
)

/** `TaskBatch` — add new tasks (W11). */
@Serializable
data class WorkflowTaskBatchBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    val tasks: List<WorkflowNewTaskBody>,
    val reason: String? = null,
)

/** `ImportPreview` — W11b review. */
@Serializable
data class WorkflowImportPreviewBody(
    @SerialName("task_ids") val taskIds: List<String>,
    val acceptances: Map<String, WorkflowImportAcceptanceBody>? = null,
)

/** `ImportTasks` — W11b confirm. */
@Serializable
data class WorkflowImportBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    @SerialName("task_ids") val taskIds: List<String>,
    @SerialName("preview_digest") val previewDigest: String,
    val acceptances: Map<String, WorkflowImportAcceptanceBody>? = null,
    @SerialName("release_task_ids") val releaseTaskIds: List<String>? = null,
    val reason: String? = null,
)

/** `MoveTasks` — destination null = remove from the workflow. */
@Serializable
data class WorkflowMoveBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    @SerialName("task_ids") val taskIds: List<String>,
    @SerialName("destination_workflow_id") val destinationWorkflowId: String? = null,
    @SerialName("destination_revision") val destinationRevision: Int? = null,
    val reason: String? = null,
)

/** `WorkflowPatch` — settings (W22). */
@Serializable
data class WorkflowPatchBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    val reason: String? = null,
    val title: String? = null,
    val goal: String? = null,
    @SerialName("execution_mode") val executionMode: String? = null,
    @SerialName("task_limit") val taskLimit: Int? = null,
    @SerialName("round_limit") val roundLimit: Int? = null,
    @SerialName("turn_allowance") val turnAllowance: Int? = null,
)

/** `ObjectiveEdit`. */
@Serializable
data class WorkflowObjectiveEditBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    val title: String,
    val criteria: String,
    val reason: String? = null,
)

/** `TransferOwner`. */
@Serializable
data class WorkflowTransferOwnerBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    @SerialName("new_owner_id") val newOwnerId: String,
    val reason: String? = null,
)

/** `ReviewRound` — record review outcome (W25). */
@Serializable
data class WorkflowReviewRoundBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    @SerialName("loop_key") val loopKey: String,
    @SerialName("review_task_id") val reviewTaskId: String,
    @SerialName("reviewed_task_id") val reviewedTaskId: String,
    @SerialName("reviewed_artifact") val reviewedArtifact: EvidenceReferenceDto,
    /** changes_requested | accepted | inconclusive */
    val outcome: String,
    val correction: WorkflowNewTaskBody? = null,
    @SerialName("next_review") val nextReview: WorkflowNewTaskBody? = null,
    val reason: String? = null,
)

/** `LoopDecision` — owner decisions (W20). */
@Serializable
data class WorkflowLoopDecisionBody(
    @SerialName("expected_revision") val expectedRevision: Int,
    @SerialName("idempotency_key") val idempotencyKey: String,
    /** raise_limit | reassign_continue | accept_override | resume_stalled | pick_outcome | stop */
    val kind: String,
    @SerialName("task_id") val taskId: String,
    @SerialName("new_max_rounds") val newMaxRounds: Int? = null,
    @SerialName("assignee_id") val assigneeId: String? = null,
    val outcome: String? = null,
    val note: String? = null,
    val reason: String? = null,
)

/** `TaskAutonomyUpdate` (W16 task authority). */
@Serializable
data class TaskAutonomyUpdateBody(
    val autonomy: String,
    @SerialName("actor_agent_id") val actorAgentId: String? = null,
)
