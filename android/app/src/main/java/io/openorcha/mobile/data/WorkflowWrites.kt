package io.openorcha.mobile.data

/**
 * Builds each [WorkflowWrite] (route + typed body + receipt operation) from the loaded
 * detail, so every sheet sends the revisions it was checked against. Operation names are
 * the routes' `x-workflow-operation` values in the live `/openapi.json`.
 */
object WorkflowWrites {
    private fun wf(w: WorkflowDetailDto, action: String) = WorkflowPaths.action(w.id, action)

    /** pause | resume | cancel | finish | hide | restore — all `Mutation`. */
    fun workflowMutation(w: WorkflowDetailDto, action: String, key: String, reason: String? = null) =
        WorkflowWrite(wf(w, action), action, key, WorkflowMutationBody(w.revision, key, reason.clean()))

    fun start(w: WorkflowDetailDto, key: String, taskIds: List<String>, taskRevisions: Map<String, Int>, reason: String? = null) =
        WorkflowWrite(wf(w, "start"), "start", key, WorkflowReleaseBody(w.revision, key, reason.clean(), taskIds, taskRevisions))

    fun release(w: WorkflowDetailDto, key: String, taskIds: List<String>, taskRevisions: Map<String, Int>, holds: List<String>, reason: String?) =
        WorkflowWrite(wf(w, "release"), "release", key, WorkflowReleaseBody(w.revision, key, reason.clean(), taskIds, taskRevisions, holds))

    /** hold | stop | reissue-stop | release-lost-worker | withdraw-from-scope | reject — all `TaskMutation`. */
    fun taskMutation(w: WorkflowDetailDto, t: WorkflowTaskDto, route: String, key: String, reason: String?): WorkflowWrite {
        val operation = TASK_MUTATION_OPS[route] ?: error("not a TaskMutation route: $route")
        return WorkflowWrite(WorkflowPaths.task(t.id, route), operation, key, WorkflowTaskMutationBody(w.revision, key, t.workRevision, reason.clean()))
    }

    fun prepare(
        w: WorkflowDetailDto,
        t: WorkflowTaskDto,
        key: String,
        definitionOfDone: String?,
        assigneeId: String?,
        reason: String? = null,
    ) = WorkflowWrite(
        WorkflowPaths.task(t.id, "prepare"), "prepare", key,
        WorkflowPrepareBody(
            w.revision, key, t.workRevision, reason.clean(),
            definitionOfDone = definitionOfDone.clean()?.takeIf { it != t.definitionOfDone },
            assigneeId = assigneeId?.takeIf { it !in t.assigneeIds },
        ),
    )

    fun retry(w: WorkflowDetailDto, t: WorkflowTaskDto, key: String, reason: String?, assigneeId: String?) =
        WorkflowWrite(WorkflowPaths.task(t.id, "retry"), "retry", key, WorkflowRetryBody(w.revision, key, t.workRevision, reason.clean(), assigneeId))

    fun dependencies(w: WorkflowDetailDto, t: WorkflowTaskDto, key: String, dependsOn: List<String>, reason: String?) =
        WorkflowWrite(WorkflowPaths.task(t.id, "dependencies"), "dependencies", key, WorkflowDependencyEditBody(w.revision, key, t.workRevision, dependsOn, reason.clean()))

    fun accept(w: WorkflowDetailDto, t: WorkflowTaskDto, key: String, evidence: EvidenceReferenceDto, reason: String?) =
        WorkflowWrite(WorkflowPaths.task(t.id, "accept"), "accept", key, WorkflowAcceptTaskBody(w.revision, key, t.workRevision, evidence, reason.clean()))

    fun reportOutcome(w: WorkflowDetailDto, t: WorkflowTaskDto, key: String, outcome: String, findings: List<String>, note: String?) =
        WorkflowWrite(
            WorkflowPaths.task(t.id, "outcome"), "report_outcome", key,
            WorkflowOutcomeReportBody(
                w.revision, key, t.workRevision, outcome,
                findings = findings.mapNotNull { it.clean() }.map { WorkflowFindingBody(it) }.takeIf { it.isNotEmpty() },
                note = note.clean(),
            ),
        )

    fun outsideResult(w: WorkflowDetailDto, t: WorkflowTaskDto, key: String, narrative: String, producedBy: String?) =
        WorkflowWrite(
            WorkflowPaths.task(t.id, "external-result"), "external_result", key,
            WorkflowOutsideResultBody(w.revision, key, t.workRevision, EvidenceBasisDto(narrative.trim()), producedBy.clean()),
        )

    fun withdrawOutsideResult(w: WorkflowDetailDto, t: WorkflowTaskDto, key: String, reason: String?): WorkflowWrite {
        val eid = t.outsideResultId ?: error("no outside result")
        return WorkflowWrite(
            WorkflowPaths.task(t.id, "external-result/$eid/withdraw"), "withdraw_evidence", key,
            WorkflowTaskMutationBody(w.revision, key, t.workRevision, reason.clean()),
        )
    }

    fun addEvidence(w: WorkflowDetailDto, t: WorkflowTaskDto, key: String, narrative: String) =
        WorkflowWrite(
            wf(w, "tasks/${t.id}/evidence"), "add_evidence", key,
            WorkflowAddEvidenceBody(w.revision, key, t.workRevision, EvidenceBasisDto(narrative.trim())),
        )

    fun acceptObjective(w: WorkflowDetailDto, objectiveId: String, key: String, basis: EvidenceBasisDto) =
        WorkflowWrite(wf(w, "objectives/$objectiveId/accept"), "accept_objective", key, WorkflowAcceptBasisBody(w.revision, key, basis))

    fun acceptGoal(w: WorkflowDetailDto, key: String, basis: EvidenceBasisDto) =
        WorkflowWrite(wf(w, "goal/accept"), "accept_goal", key, WorkflowAcceptBasisBody(w.revision, key, basis))

    fun addTasks(w: WorkflowDetailDto, key: String, tasks: List<WorkflowNewTaskBody>) =
        WorkflowWrite(wf(w, "tasks"), "add_tasks", key, WorkflowTaskBatchBody(w.revision, key, tasks))

    fun import(
        w: WorkflowDetailDto,
        key: String,
        taskIds: List<String>,
        previewDigest: String,
        releaseTaskIds: List<String>,
        acceptances: Map<String, WorkflowImportAcceptanceBody> = emptyMap(),
    ) = WorkflowWrite(
        wf(w, "import"), "import", key,
        WorkflowImportBody(
            w.revision, key, taskIds, previewDigest,
            acceptances = acceptances.takeIf { it.isNotEmpty() },
            releaseTaskIds = releaseTaskIds.takeIf { it.isNotEmpty() },
        ),
    )

    fun move(w: WorkflowDetailDto, key: String, taskIds: List<String>, destination: WorkflowDetailDto?, reason: String?) =
        WorkflowWrite(wf(w, "move"), "move", key, WorkflowMoveBody(w.revision, key, taskIds, destination?.id, destination?.revision, reason.clean()))

    fun patch(
        w: WorkflowDetailDto,
        key: String,
        title: String,
        goal: String,
        mode: String,
        taskLimit: Int?,
        roundLimit: Int?,
        turnAllowance: Int?,
        reason: String?,
    ) = WorkflowWrite(
        WorkflowPaths.detail(w.id), "patch", key,
        WorkflowPatchBody(
            w.revision, key, reason.clean(),
            title = title.clean()?.takeIf { it != w.title },
            goal = goal.clean()?.takeIf { it != w.goal },
            executionMode = mode.takeIf { it != w.executionMode },
            taskLimit = taskLimit?.takeIf { it != w.taskLimit },
            roundLimit = roundLimit?.takeIf { it != w.roundLimit },
            turnAllowance = turnAllowance?.takeIf { it != w.turnAllowance },
        ),
    )

    fun editObjective(w: WorkflowDetailDto, objectiveId: String, key: String, title: String, criteria: String, reason: String?) =
        WorkflowWrite(wf(w, "objectives/$objectiveId"), "edit_objective", key, WorkflowObjectiveEditBody(w.revision, key, title.trim(), criteria.trim(), reason.clean()))

    fun transferOwner(w: WorkflowDetailDto, key: String, newOwnerId: String, reason: String?) =
        WorkflowWrite(wf(w, "transfer-owner"), "transfer_owner", key, WorkflowTransferOwnerBody(w.revision, key, newOwnerId, reason.clean()))

    fun reviewRound(
        w: WorkflowDetailDto,
        key: String,
        loopKey: String,
        reviewTaskId: String,
        reviewedTaskId: String,
        artifact: EvidenceReferenceDto,
        outcome: String,
        correction: WorkflowNewTaskBody?,
        nextReview: WorkflowNewTaskBody?,
        reason: String?,
    ) = WorkflowWrite(
        wf(w, "review-rounds"), "review_round", key,
        WorkflowReviewRoundBody(w.revision, key, loopKey, reviewTaskId, reviewedTaskId, artifact, outcome, correction, nextReview, reason.clean()),
    )

    fun resolveLoop(w: WorkflowDetailDto, taskId: String, key: String, reason: String?) =
        WorkflowWrite(wf(w, "review-loops/$taskId/resolve"), "resolve_loop", key, WorkflowMutationBody(w.revision, key, reason.clean()))

    fun loopDecision(
        w: WorkflowDetailDto,
        key: String,
        kind: String,
        taskId: String,
        newMaxRounds: Int? = null,
        assigneeId: String? = null,
        outcome: String? = null,
        note: String? = null,
        reason: String? = null,
    ) = WorkflowWrite(
        wf(w, "decisions"), "loop_decision", key,
        WorkflowLoopDecisionBody(w.revision, key, kind, taskId, newMaxRounds, assigneeId, outcome, note.clean(), reason.clean()),
    )

    /** `POST /api/containers/{cid}/workflows` (receipt operation `create`). */
    fun create(containerId: String, body: WorkflowCreateBody) =
        WorkflowWrite(WorkflowPaths.collection(containerId), "create", body.idempotencyKey, body)

    /** Task routes whose body is `TaskMutation`, with their receipt operation. */
    val TASK_MUTATION_OPS = mapOf(
        "hold" to "hold",
        "stop" to "stop",
        "reissue-stop" to "reissue_stop",
        "release-lost-worker" to "release_lost_worker",
        "withdraw-from-scope" to "withdraw",
        "reject" to "reject",
    )

    private fun String?.clean(): String? = this?.trim()?.takeIf { it.isNotEmpty() }
}
