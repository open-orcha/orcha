package io.openorcha.mobile.data

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json

class OrchaApiClient {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        explicitNulls = false
    }

    private val client = HttpClient(OkHttp) {
        install(ContentNegotiation) { json(json) }
        install(HttpTimeout) {
            requestTimeoutMillis = 10_000
            connectTimeoutMillis = 3_000
            socketTimeoutMillis = 10_000
        }
    }

    suspend fun listContainers(baseUrl: String): ContainersResponse = withTimeout(6_000) {
        client.get("${baseUrl.endpoint()}/api/containers").body()
    }

    suspend fun getSnapshot(baseUrl: String, containerId: String): ContainerSnapshot = withTimeout(10_000) {
        client.get("${baseUrl.endpoint()}/api/containers/$containerId").body()
    }

    suspend fun getTaskMessages(baseUrl: String, taskId: String): TaskMessagesResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/tasks/$taskId/messages").body()
    }

    suspend fun postTaskMessage(baseUrl: String, taskId: String, actorId: String, body: String): GenericIdResponse =
        postJson("${baseUrl.endpoint()}/api/tasks/$taskId/messages", TaskMessageBody(actorId, body))

    suspend fun cancelTask(baseUrl: String, taskId: String, actorId: String, reason: String?): GenericIdResponse =
        postJson("${baseUrl.endpoint()}/api/tasks/$taskId/cancel", TaskCancelBody(actorId, reason.blankToNull()))

    suspend fun verifyTask(baseUrl: String, taskId: String, actorId: String, approve: Boolean, feedback: String?): GenericIdResponse =
        postJson("${baseUrl.endpoint()}/api/tasks/$taskId/verify", TaskVerifyBody(approve, feedback.blankToNull(), actorId))

    suspend fun decidePlan(
        baseUrl: String,
        taskId: String,
        actorId: String,
        approve: Boolean,
        reason: String?,
        targetAgentId: String?,
    ): GenericIdResponse =
        postJson(
            "${baseUrl.endpoint()}/api/decisions",
            DecisionBody(
                subjectType = "plan_approval",
                subjectId = taskId,
                decision = if (approve) "approve" else "reject",
                reason = reason.blankToNull(),
                actorAgentId = actorId,
                targetAgentId = targetAgentId,
            ),
        )

    suspend fun getTaskRuns(baseUrl: String, taskId: String): RunsResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/tasks/$taskId/runs").body()
    }

    suspend fun getAgentRuns(baseUrl: String, agentId: String): RunsResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/agents/$agentId/runs").body()
    }

    suspend fun getRunStreamText(baseUrl: String, agentId: String, runId: String): String = withTimeout(20_000) {
        client.get("${baseUrl.endpoint()}/api/agents/$agentId/runs/$runId/stream").bodyAsText()
    }

    suspend fun stopRun(baseUrl: String, runId: String, actorId: String): GenericIdResponse =
        postJson("${baseUrl.endpoint()}/api/runs/$runId/stop", WorkerRunStopBody(actorId))

    suspend fun respondRequest(baseUrl: String, requestId: String, actorId: String, response: String): GenericIdResponse =
        postJson("${baseUrl.endpoint()}/api/requests/$requestId/respond", RequestRespondBody(actorId, response))

    suspend fun closeRequest(baseUrl: String, requestId: String, actorId: String, reason: String?): GenericIdResponse =
        postJson("${baseUrl.endpoint()}/api/requests/$requestId/close", RequestActorBody(actorId, reason.blankToNull()))

    suspend fun nudgeRequest(baseUrl: String, requestId: String, actorId: String, note: String?): GenericIdResponse =
        postJson("${baseUrl.endpoint()}/api/requests/$requestId/nudge", NudgeBody(actorId, note.blankToNull()))

    suspend fun escalateRequest(baseUrl: String, requestId: String, actorId: String, reason: String?): GenericIdResponse =
        postJson("${baseUrl.endpoint()}/api/requests/$requestId/escalate", RequestActorBody(actorId, reason.blankToNull()))

    suspend fun acceptTaskRequest(baseUrl: String, requestId: String, actorId: String, note: String?): GenericIdResponse =
        postJson("${baseUrl.endpoint()}/api/requests/$requestId/accept-task", TaskRequestAcceptBody(actorId, note.blankToNull()))

    suspend fun rejectTaskRequest(baseUrl: String, requestId: String, actorId: String, reason: String): GenericIdResponse =
        postJson("${baseUrl.endpoint()}/api/requests/$requestId/reject-task", TaskRequestRejectBody(actorId, reason))

    suspend fun convertRequest(
        baseUrl: String,
        requestId: String,
        actorId: String,
        title: String,
        definitionOfDone: String,
        assigneeAlias: String?,
        priority: Int = 100,
    ): GenericIdResponse =
        postJson(
            "${baseUrl.endpoint()}/api/requests/$requestId/convert-to-task",
            RequestConvertBody(actorId, title, definitionOfDone, priority, assigneeAlias.blankToNull()),
        )

    suspend fun listModels(baseUrl: String): ModelsResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/models").body()
    }

    suspend fun updateAgentModel(baseUrl: String, agentId: String, model: String): GenericIdResponse =
        postJson("${baseUrl.endpoint()}/api/agents/$agentId/model", AgentModelBody(model))

    suspend fun updateAutoWake(baseUrl: String, agentId: String, actorId: String, intervalSecs: Int?): GenericIdResponse =
        patchJson("${baseUrl.endpoint()}/api/agents/$agentId/auto-wake", AutoWakeBody(actorId, intervalSecs))

    suspend fun retireAgent(baseUrl: String, agentId: String, actorId: String): GenericIdResponse =
        postJson("${baseUrl.endpoint()}/api/agents/$agentId/retire", AgentRetireBody(actorId))

    suspend fun getConversation(baseUrl: String, agentId: String): ConversationResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/agents/$agentId/conversation?limit=80").body()
    }

    suspend fun startConversation(baseUrl: String, agentId: String, actorId: String): ConversationResponse =
        postJson("${baseUrl.endpoint()}/api/agents/$agentId/conversations", ConversationStartBody(actorId))

    suspend fun sendConversationTurn(baseUrl: String, conversationId: String, actorId: String, content: String): GenericIdResponse =
        postJson("${baseUrl.endpoint()}/api/conversations/$conversationId/turns", TurnAppendBody("human", actorId, content))

    suspend fun endConversation(baseUrl: String, conversationId: String, actorId: String): GenericIdResponse =
        postJson("${baseUrl.endpoint()}/api/conversations/$conversationId/end", ConversationActorBody(actorId))

    suspend fun createTask(
        baseUrl: String,
        containerId: String,
        title: String,
        description: String?,
        definitionOfDone: String,
        actorId: String,
        assigneeAlias: String?,
        priority: Int,
        dependsOn: List<String>,
        notReady: Boolean,
    ): GenericIdResponse =
        postJson(
            "${baseUrl.endpoint()}/api/containers/$containerId/tasks",
            TaskCreateBody(
                title = title,
                description = description.blankToNull(),
                definitionOfDone = definitionOfDone,
                priority = priority,
                createdByAgentId = actorId,
                assigneeAlias = assigneeAlias.blankToNull(),
                dependsOn = dependsOn,
                notReady = notReady,
            ),
        )

    suspend fun assignTask(baseUrl: String, taskId: String, actorId: String, agentId: String, reassign: Boolean): GenericIdResponse =
        postJson("${baseUrl.endpoint()}/api/tasks/$taskId/assign", AssignTaskBody(actorId, agentId, reassign))

    private suspend inline fun <reified T : Any, reified R> postJson(url: String, payload: T): R = withTimeout(10_000) {
        val response: HttpResponse = client.post(url) {
            contentType(ContentType.Application.Json)
            setBody(payload)
        }
        response.body()
    }

    private suspend inline fun <reified T : Any, reified R> patchJson(url: String, payload: T): R = withTimeout(10_000) {
        val response: HttpResponse = client.patch(url) {
            contentType(ContentType.Application.Json)
            setBody(payload)
        }
        response.body()
    }

    private fun String.endpoint(): String = OrchaServerAddress.normalize(this)
    private fun String?.blankToNull(): String? = this?.trim()?.takeIf { it.isNotEmpty() }
}
