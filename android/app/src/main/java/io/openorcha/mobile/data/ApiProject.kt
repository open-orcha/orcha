package io.openorcha.mobile.data

/* Project slice API: objective, agent limit, budgets, metrics, agent worktrees, members
   (authority) and routine create/edit/preview. Its own client instance (same bearer-auth
   plugin, timeouts and tolerant reader) so this slice never edits the shared client.
   Write bodies are JsonObjects so an explicit `null` (clear a budget limit) reaches the wire. */

import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

object ProjectApi {
    private val client by lazy { createOrchaHttpClient() }

    private fun JsonObject.withActor(actorId: String?): JsonObject =
        if (actorId == null) this else JsonObject(this + ("actor_agent_id" to JsonPrimitive(actorId)))

    private suspend inline fun <reified R> putJson(url: String, body: JsonObject): R = withTimeout(10_000) {
        client.put(url) { contentType(ContentType.Application.Json); setBody(body) }.body()
    }

    // ── objective ──

    suspend fun setObjective(baseUrl: String, cid: String, actorId: String?, objective: String?): ProjectObjectiveResponse =
        putJson(
            "${baseUrl.endpoint()}/api/containers/$cid/objective",
            buildJsonObject { put("objective", objective?.let { JsonPrimitive(it) } ?: JsonNull) }.withActor(actorId),
        )

    // ── members (authority) ──

    suspend fun members(baseUrl: String, cid: String): ProjectMembersResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/containers/$cid/members").body()
    }

    // ── agent limit ──

    suspend fun limits(baseUrl: String, cid: String): ProjectLimitsResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/containers/$cid/limits").body()
    }

    suspend fun setLimits(baseUrl: String, cid: String, actorId: String, maxAutoAgents: Int): ProjectLimitsResponse =
        putJson(
            "${baseUrl.endpoint()}/api/containers/$cid/limits",
            buildJsonObject { put("max_auto_agents", maxAutoAgents) }.withActor(actorId),
        )

    // ── budgets ──

    suspend fun budgets(baseUrl: String, cid: String): ProjectBudgetsResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/containers/$cid/budgets").body()
    }

    /** PUT the project's monthly limits; null clears a limit. */
    suspend fun setProjectBudget(baseUrl: String, cid: String, actorId: String?, usd: Double?, tokens: Long?) {
        putJson<JsonElement>(
            "${baseUrl.endpoint()}/api/containers/$cid/budget",
            buildJsonObject {
                put("monthly_limit_usd", usd?.let { JsonPrimitive(it) } ?: JsonNull)
                put("monthly_limit_tokens", tokens?.let { JsonPrimitive(it) } ?: JsonNull)
            }.withActor(actorId),
        )
    }

    // ── metrics ──

    suspend fun performance(baseUrl: String, cid: String, range: String): PerformanceResponse = withTimeout(12_000) {
        client.get("${baseUrl.endpoint()}/api/containers/$cid/metrics/performance?range=$range").body()
    }

    suspend fun agentPerformance(baseUrl: String, cid: String, aid: String, range: String): AgentPerformanceResponse =
        withTimeout(12_000) {
            client.get("${baseUrl.endpoint()}/api/containers/$cid/metrics/performance/agents/$aid?range=$range").body()
        }

    // ── agent worktrees ──

    suspend fun agentWorktrees(baseUrl: String, cid: String): AgentWorktreesResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/containers/$cid/agent-worktrees").body()
    }

    suspend fun setWorktreeSettings(baseUrl: String, cid: String, actorId: String?, autoCleanup: Boolean, graceDays: Int): WorktreeSettingsDto =
        putJson(
            "${baseUrl.endpoint()}/api/containers/$cid/agent-worktrees/settings",
            buildJsonObject { put("auto_cleanup", autoCleanup); put("grace_days", graceDays) }.withActor(actorId),
        )

    // ── routines: create / edit / preview ──

    suspend fun previewSchedule(baseUrl: String, cid: String, cron: String, timezone: String, count: Int = 3): SchedulePreviewResponse =
        withTimeout(8_000) {
            client.post("${baseUrl.endpoint()}/api/containers/$cid/routines/preview") {
                contentType(ContentType.Application.Json)
                setBody(buildJsonObject { put("cron", cron); put("timezone", timezone); put("count", count) })
            }.body()
        }

    suspend fun routine(baseUrl: String, rid: String): RoutineDetailDto = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/routines/$rid").body()
    }

    suspend fun createRoutine(baseUrl: String, cid: String, actorId: String?, body: JsonObject): JsonElement = withTimeout(10_000) {
        client.post("${baseUrl.endpoint()}/api/containers/$cid/routines") {
            contentType(ContentType.Application.Json)
            setBody(body.withActor(actorId))
        }.body()
    }

    suspend fun updateRoutine(baseUrl: String, rid: String, actorId: String?, body: JsonObject): JsonElement = withTimeout(10_000) {
        client.patch("${baseUrl.endpoint()}/api/routines/$rid") {
            contentType(ContentType.Application.Json)
            setBody(body.withActor(actorId))
        }.body()
    }
}
