package io.openorcha.mobile.data

/**
 * Task-detail parity endpoints (see DtosTask.kt). Extension functions on [OrchaApiClient]
 * so they ride the shared Ktor client: bearer auth, the auth-perimeter HTML check, and
 * the tolerant JSON reader.
 */

import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.encodeURLParameter
import kotlinx.coroutines.withTimeout

suspend fun OrchaApiClient.getTaskEvidence(baseUrl: String, taskId: String): EvidencePackDto = withTimeout(12_000) {
    client.get("${baseUrl.endpoint()}/api/tasks/$taskId/evidence").body()
}

suspend fun OrchaApiClient.getGoalChain(baseUrl: String, taskId: String): GoalChainDto = withTimeout(8_000) {
    client.get("${baseUrl.endpoint()}/api/tasks/$taskId/goal-chain").body()
}

suspend fun OrchaApiClient.getVerdiktRuns(baseUrl: String, taskId: String): VerdiktRunsResponse = withTimeout(8_000) {
    client.get("${baseUrl.endpoint()}/api/tasks/$taskId/verdikt/runs").body()
}

/** "Run in Verdikt": hands the task's definition of done to Verdikt (web exposes this to humans). */
suspend fun OrchaApiClient.triggerVerdikt(baseUrl: String, taskId: String, actorId: String): VerdiktRunDto =
    transport.post("${baseUrl.endpoint()}/api/tasks/$taskId/verdikt/runs", VerdiktTriggerBody(actorId))

/** Reassign: the agent must be a live AI agent in the project; `reassign` releases the prior assignee. */
suspend fun OrchaApiClient.reassignTask(baseUrl: String, taskId: String, actorId: String, agentId: String): GenericIdResponse =
    transport.post("${baseUrl.endpoint()}/api/tasks/$taskId/assign", AssignTaskBody(actorId, agentId, reassign = true))

/** Reviewer picker: `null` = anyone can verify. */
suspend fun OrchaApiClient.setTaskReviewer(baseUrl: String, taskId: String, actorId: String, reviewerAgentId: String?) {
    withTimeout(10_000) {
        client.put("${baseUrl.endpoint()}/api/tasks/$taskId/reviewer") {
            contentType(ContentType.Application.Json)
            setBody(TaskReviewerBody(reviewerAgentId, actorId))
        }
    }
}

suspend fun OrchaApiClient.listRoutinesFromTask(baseUrl: String, containerId: String, taskId: String): RoutineListResponse =
    withTimeout(8_000) {
        client.get(
            "${baseUrl.endpoint()}/api/containers/$containerId/routines?origin_task_id=${taskId.encodeURLParameter()}",
        ).body()
    }

suspend fun OrchaApiClient.previewSchedule(baseUrl: String, containerId: String, cron: String, timezone: String): SchedulePreviewDto =
    transport.post("${baseUrl.endpoint()}/api/containers/$containerId/routines/preview", SchedulePreviewBody(cron, timezone))

suspend fun OrchaApiClient.createRoutine(baseUrl: String, containerId: String, body: RoutineCreateBody): RoutineDto =
    transport.post("${baseUrl.endpoint()}/api/containers/$containerId/routines", body)
