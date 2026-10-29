package io.openorcha.mobile.data

import java.util.UUID

/**
 * One repository per container (design §8, shared with iOS): capability, reads, and every
 * workflow write. Writes carry `expected_revision` (workflow) and, for task writes,
 * `expected_work_revision`, plus ONE idempotency key minted when the sheet opens and reused
 * on retry. An uncertain reply reads the operation receipt before Retry is offered. Writes
 * are never queued offline.
 */
class WorkflowsRepository(
    private val api: OrchaApiClient,
    val containerId: String,
    private val baseUrl: () -> String,
    /** The paired human; null = read-only (no acting member). */
    val actorId: String?,
) {
    suspend fun capability(): WorkflowCapabilityDto = api.getWorkflowCapability(baseUrl(), containerId, actorId)

    suspend fun list(status: String?, cursor: String?, visibility: String? = null): WorkflowListDto =
        api.listWorkflows(baseUrl(), containerId, actorId, status, cursor, visibility)

    suspend fun detail(workflowId: String): WorkflowDetailDto = api.getWorkflow(baseUrl(), workflowId, actorId)

    suspend fun activity(workflowId: String, beforeAt: String?, beforeId: String?): WorkflowActivityPageDto =
        api.getWorkflowActivity(baseUrl(), workflowId, actorId, beforeAt, beforeId)

    suspend fun impact(workflowId: String, check: String, taskIds: List<String> = emptyList(), holds: List<String> = emptyList()) =
        api.getWorkflowImpact(baseUrl(), workflowId, check, actorId, taskIds, holds)

    suspend fun completionCheck(workflowId: String) = api.getWorkflowCompletionCheck(baseUrl(), workflowId, actorId)

    suspend fun visibilityCheck(workflowId: String) = api.getWorkflowVisibilityCheck(baseUrl(), workflowId, actorId)

    suspend fun taskEvidence(workflowId: String, taskId: String, beforeRevision: Int? = null) =
        api.getWorkflowTaskEvidence(baseUrl(), workflowId, taskId, actorId, beforeRevision)

    suspend fun roundContext(taskId: String) = api.getRoundContext(baseUrl(), taskId, actorId)

    suspend fun approvals(taskId: String) = api.getTaskApprovals(baseUrl(), taskId, actorId)

    suspend fun searchTasks(query: String, selected: List<String>) =
        api.searchWorkflowTasks(baseUrl(), containerId, actorId, query, selected)

    suspend fun previewDraft(body: WorkflowDraftBody) = api.previewWorkflowDraft(baseUrl(), containerId, actorId, body)

    suspend fun previewImport(workflowId: String, body: WorkflowImportPreviewBody) =
        api.previewWorkflowImport(baseUrl(), workflowId, actorId, body)

    suspend fun previewOutcome(taskId: String, outcome: String, workRevision: Int) =
        api.previewTaskOutcome(baseUrl(), taskId, actorId, WorkflowOutcomeChoiceBody(outcome, workRevision))

    suspend fun setAutonomy(taskId: String, autonomy: String): TaskAutonomyResultDto {
        val actor = actorId ?: throw WorkflowApiException(NO_HUMAN, 403, "human_required")
        return api.setTaskAutonomy(baseUrl(), taskId, actor, autonomy)
    }

    /**
     * Sends [write]. A refusal comes back as [WorkflowWriteOutcome.Refused] (drafts kept,
     * preview cleared by the caller). An uncertain reply checks the receipt first: a saved
     * receipt is a success; `not_found` (or an unreadable check) leaves the decision with
     * the person as [WorkflowWriteOutcome.Uncertain], whose Retry resends the SAME write.
     */
    suspend fun send(write: WorkflowWrite): WorkflowWriteOutcome {
        if (actorId == null) return WorkflowWriteOutcome.Refused(NO_HUMAN, "human_required")
        return try {
            WorkflowWriteOutcome.Saved(api.sendWorkflowWrite(baseUrl(), actorId, write))
        } catch (e: WorkflowApiException) {
            if (!e.uncertain) return WorkflowWriteOutcome.Refused(e.message ?: "Orcha refused this change.", e.code)
            checkReceipt(write) ?: WorkflowWriteOutcome.Uncertain(UNCERTAIN, write)
        }
    }

    /** "Check saved result": the receipt for [write], or null when it cannot be read or was not saved. */
    suspend fun checkReceipt(write: WorkflowWrite): WorkflowWriteOutcome.Saved? = runCatching {
        api.getWorkflowReceipt(baseUrl(), containerId, write.idempotencyKey, write.operation, actorId)
    }.getOrNull()?.takeIf { it.status == "saved" }?.result?.let { WorkflowWriteOutcome.Saved(it) }

    companion object {
        const val NO_HUMAN = "Choose a current human member of this project to change workflows."
        const val UNCERTAIN = "We did not get a reply. Check saved result, or retry the same request."

        /** One key per opened sheet; reused for every retry of that sheet's write. */
        fun newIdempotencyKey(): String = "android-" + UUID.randomUUID().toString()
    }
}

sealed interface WorkflowWriteOutcome {
    data class Saved(val detail: WorkflowDetailDto) : WorkflowWriteOutcome
    data class Refused(val message: String, val code: String) : WorkflowWriteOutcome
    data class Uncertain(val message: String, val write: WorkflowWrite) : WorkflowWriteOutcome
}
