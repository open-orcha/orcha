package io.openorcha.mobile.data

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.HttpTimeoutConfig
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.timeout
import io.ktor.client.request.get
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.prepareGet
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.encodeURLParameter
import io.ktor.serialization.kotlinx.json.json
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
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

    suspend fun getSnapshot(
        baseUrl: String,
        containerId: String,
        taskLimit: Int? = null,
        requestLimit: Int? = null,
    ): ContainerSnapshot = withTimeout(10_000) {
        val window = listOfNotNull(
            taskLimit?.let { "task_limit=$it" },
            requestLimit?.let { "request_limit=$it" },
        ).joinToString("&").let { if (it.isEmpty()) "" else "?$it" }
        client.get("${baseUrl.endpoint()}/api/containers/$containerId$window").body()
    }

    /** Keyset-paged thread fetch: newest page first; older pages via before/before_id. */
    suspend fun getTaskMessages(
        baseUrl: String,
        taskId: String,
        limit: Int = THREAD_PAGE,
        before: String? = null,
        beforeId: String? = null,
    ): TaskMessagesResponse = withTimeout(8_000) {
        val cursor = listOfNotNull(
            before?.let { "before=${it.encodeURLParameter()}" },
            beforeId?.let { "before_id=${it.encodeURLParameter()}" },
        ).joinToString("&").let { if (it.isEmpty()) "" else "&$it" }
        client.get("${baseUrl.endpoint()}/api/tasks/$taskId/messages?limit=$limit$cursor").body()
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
        client.get("${baseUrl.endpoint()}/api/tasks/$taskId/runs?limit=$RUNS_PAGE").body()
    }

    // flow 09 lazy sections
    suspend fun getPersona(baseUrl: String, agentId: String): PersonaResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/agents/$agentId/persona").body()
    }

    suspend fun getDigest(baseUrl: String, agentId: String): DigestResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/agents/$agentId/digest").body()
    }

    suspend fun getInbox(baseUrl: String, agentId: String): InboxResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/agents/$agentId/inbox").body()
    }

    suspend fun getOutbox(baseUrl: String, agentId: String): OutboxResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/agents/$agentId/outbox").body()
    }

    suspend fun getResidentRuns(baseUrl: String, agentId: String): RunsResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/agents/$agentId/resident-runs").body()
    }

    suspend fun updateAgent(baseUrl: String, agentId: String, actorId: String, alias: String?, role: String?): GenericIdResponse =
        patchJson("${baseUrl.endpoint()}/api/agents/$agentId", AgentUpdateBody(actorId, alias.blankToNull(), role.blankToNull()))

    // flow 05: implications preview before the destructive close confirm
    suspend fun getCloseImplications(baseUrl: String, taskId: String): CloseImplicationsResponse = withTimeout(5_000) {
        client.get("${baseUrl.endpoint()}/api/tasks/$taskId/close-implications").body()
    }

    suspend fun getAgentRuns(baseUrl: String, agentId: String): RunsResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/agents/$agentId/runs?limit=$RUNS_PAGE").body()
    }

    /**
     * FINISHED runs only: the server closes the stream immediately, so a buffered read is
     * safe. A RUNNING run must go through [streamRun] — this call's timeouts would kill it.
     */
    suspend fun getRunStreamText(baseUrl: String, agentId: String, runId: String): String = withTimeout(20_000) {
        client.get("${baseUrl.endpoint()}/api/agents/$agentId/runs/$runId/stream").bodyAsText()
    }

    /**
     * Live run-log stream (issue 3): same endpoint the web's EventSource consumes, read
     * incrementally. The per-request infinite timeout is load-bearing — the client's
     * global 10s request cap would otherwise kill a stream that never ends; no coroutine
     * withTimeout may wrap this call (that was the old getRunStreamText bug).
     */
    fun streamRun(baseUrl: String, agentId: String, runId: String): Flow<RunStreamEvent> = flow {
        client.prepareGet("${baseUrl.endpoint()}/api/agents/$agentId/runs/$runId/stream") {
            timeout {
                requestTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                socketTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
            }
        }.execute { response ->
            val channel = response.bodyAsChannel()
            while (true) {
                val raw = channel.readUTF8Line() ?: break
                RunStream.parse(raw)?.let { emit(it) }
            }
        }
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

    /** Delta refresh (web conversation.js:586): only turns after the last seen seq. */
    suspend fun getConversationTurns(baseUrl: String, conversationId: String, afterSeq: Int, limit: Int = 50): TurnsResponse =
        withTimeout(8_000) {
            client.get("${baseUrl.endpoint()}/api/conversations/$conversationId/turns?after_seq=$afterSeq&limit=$limit").body()
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

    companion object {
        /** Task-thread keyset page size (issue 4; the thread fetch was the one unbounded call). */
        const val THREAD_PAGE = 20

        /** Explicit runs-list window (documents the server default). */
        const val RUNS_PAGE = 20
    }
}
