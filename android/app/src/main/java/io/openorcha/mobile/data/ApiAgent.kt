package io.openorcha.mobile.data

import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.readRawBytes
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.encodeURLParameter
import io.ktor.client.plugins.timeout
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/*
 * Agent slice endpoints, as extensions on the shared client (same auth seam, base-URL
 * normalisation and tolerant JSON reader as every other Embodent call).
 */

suspend fun OrchaApiClient.getAgentBudget(baseUrl: String, agentId: String): AgentBudgetDto = withTimeout(8_000) {
    client.get("${baseUrl.endpoint()}/api/agents/$agentId/budget").body()
}

suspend fun OrchaApiClient.getContainerBudgets(baseUrl: String, containerId: String): ContainerBudgetsDto = withTimeout(8_000) {
    client.get("${baseUrl.endpoint()}/api/containers/$containerId/budgets").body()
}

/** Grant (or revoke) the one-time override that lifts the hard stop for the rest of the month. */
suspend fun OrchaApiClient.setBudgetOverride(
    baseUrl: String,
    agentId: String,
    actorId: String,
    grant: Boolean,
    note: String?,
): AgentBudgetDto = withTimeout(10_000) {
    val response: HttpResponse = client.put("${baseUrl.endpoint()}/api/agents/$agentId/budget") {
        contentType(ContentType.Application.Json)
        setBody(BudgetOverrideBody(actorId, if (grant) "grant" else "revoke", note?.trim()?.takeIf { it.isNotEmpty() }))
    }
    response.body()
}

suspend fun OrchaApiClient.getReportsTo(baseUrl: String, agentId: String): ReportsToDto = withTimeout(8_000) {
    client.get("${baseUrl.endpoint()}/api/agents/$agentId/reports-to").body()
}

suspend fun OrchaApiClient.getRunChanges(baseUrl: String, agentId: String, runId: String, since: String?): RunChangesDto =
    withTimeout(10_000) {
        val q = since?.let { "?since=${it.encodeURLParameter()}" }.orEmpty()
        client.get("${baseUrl.endpoint()}/api/agents/$agentId/runs/$runId/changes$q").body()
    }

suspend fun OrchaApiClient.getRunChangeDiff(baseUrl: String, agentId: String, runId: String, path: String): RunChangeDiffDto =
    withTimeout(10_000) {
        client.get("${baseUrl.endpoint()}/api/agents/$agentId/runs/$runId/changes/diff?path=${path.encodeURLParameter()}").body()
    }

/** Raw bytes of one side (`new` after the run, `old` before) of a changed file — image previews. */
suspend fun OrchaApiClient.getRunChangeRaw(
    baseUrl: String,
    agentId: String,
    runId: String,
    path: String,
    side: String = "new",
): ByteArray = withTimeout(15_000) {
    client.get("${baseUrl.endpoint()}/api/agents/$agentId/runs/$runId/changes/raw?path=${path.encodeURLParameter()}&side=$side")
        .readRawBytes()
}

/** The agent's recent runs, read for the chat's live reply (conversation lane fields kept). */
suspend fun OrchaApiClient.getChatRuns(baseUrl: String, agentId: String): ChatRunsResponse = withTimeout(8_000) {
    client.get("${baseUrl.endpoint()}/api/agents/$agentId/runs?limit=5").body()
}

/** Every run of the agent's recent history for agent detail (headless + resident, iOS parity). */
suspend fun OrchaApiClient.getAgentRecentRuns(baseUrl: String, agentId: String): RunsResponse = withTimeout(25_000) {
    // A run row carries its full `output` (hundreds of KB): give the read room on a slow device.
    client.get("${baseUrl.endpoint()}/api/agents/$agentId/runs?limit=20") {
        timeout { requestTimeoutMillis = 25_000; socketTimeoutMillis = 25_000 }
    }.body()
}

// ---------- config history ----------

suspend fun OrchaApiClient.getConfigRevisions(baseUrl: String, agentId: String, before: Int? = null, limit: Int = 30): ConfigRevisionPageDto =
    withTimeout(10_000) {
        val q = "?limit=$limit" + (before?.let { "&before=$it" }.orEmpty())
        client.get("${baseUrl.endpoint()}/api/agents/$agentId/config-revisions$q").body()
    }

suspend fun OrchaApiClient.getConfigRevision(baseUrl: String, agentId: String, rev: Int): ConfigRevisionDetailDto = withTimeout(10_000) {
    client.get("${baseUrl.endpoint()}/api/agents/$agentId/config-revisions/$rev").body()
}

/** A restore creates a NEW revision; history is never rewritten. */
suspend fun OrchaApiClient.restoreConfigRevision(baseUrl: String, agentId: String, rev: Int, actorId: String, reason: String?): ConfigRestoreResultDto =
    withTimeout(10_000) {
        client.post("${baseUrl.endpoint()}/api/agents/$agentId/config-revisions/$rev/restore") {
            contentType(ContentType.Application.Json)
            setBody(ConfigRestoreBody(actorId, reason?.trim()?.takeIf { it.isNotEmpty() }))
        }.body()
    }

// ---------- org chart ----------

/** Every agent's reporting line in one read (a thin projection of the snapshot). */
suspend fun OrchaApiClient.getOrgLines(baseUrl: String, containerId: String): OrgSnapshotDto = withTimeout(10_000) {
    client.get("${baseUrl.endpoint()}/api/containers/$containerId?task_limit=1&request_limit=1").body()
}

/**
 * Set the manager, or clear it with null — sent as an explicit JSON null (the field is
 * required). Owner / manage_agents only; 422 = not a live agent here, 409 = a loop.
 */
suspend fun OrchaApiClient.setReportsTo(baseUrl: String, agentId: String, managerId: String?, actorId: String): ReportsToDto =
    withTimeout(10_000) {
        client.put("${baseUrl.endpoint()}/api/agents/$agentId/reports-to") {
            contentType(ContentType.Application.Json)
            setBody(
                buildJsonObject {
                    put("reports_to_agent_id", managerId?.let { JsonPrimitive(it) } ?: JsonNull)
                    put("actor_agent_id", JsonPrimitive(actorId))
                },
            )
        }.body()
    }

// ---------- budgets (limits) ----------

/** Partial budget write: [body] from [io.openorcha.mobile.domain.AgentInsights.budgetUpdateJson]. */
suspend fun OrchaApiClient.updateAgentBudget(baseUrl: String, agentId: String, body: JsonObject): AgentBudgetDto = withTimeout(10_000) {
    client.put("${baseUrl.endpoint()}/api/agents/$agentId/budget") {
        contentType(ContentType.Application.Json)
        setBody(body)
    }.body()
}

// ---------- acting identity ----------

suspend fun OrchaApiClient.getMe(baseUrl: String, containerId: String): MeDto = withTimeout(8_000) {
    client.get("${baseUrl.endpoint()}/api/me?cid=$containerId").body()
}
