package io.openorcha.mobile.data

/* Usage slice API (read-only): metrics summary, token usage, agent spend drilldown,
   spend insights and the model catalog. Its own client instance (same bearer-auth
   plugin, timeouts and tolerant reader) so this slice never edits the shared client. */

import io.ktor.client.call.body
import io.ktor.client.request.get
import kotlinx.coroutines.withTimeout

object UsageApi {
    private val client by lazy { createOrchaHttpClient() }

    suspend fun summary(baseUrl: String, cid: String, days: Int): MetricsSummaryResponse = withTimeout(12_000) {
        client.get("${baseUrl.endpoint()}/api/containers/$cid/metrics?days=$days").body()
    }

    suspend fun tokenUsage(baseUrl: String, cid: String): TokenUsageResponse = withTimeout(12_000) {
        client.get("${baseUrl.endpoint()}/api/containers/$cid/token-usage").body()
    }

    suspend fun agentSpend(baseUrl: String, cid: String, agentId: String, window: String): AgentSpendResponse = withTimeout(12_000) {
        client.get("${baseUrl.endpoint()}/api/containers/$cid/metrics/agents/$agentId/spend?window=$window").body()
    }

    suspend fun insights(baseUrl: String, cid: String, window: String): SpendInsightsResponse = withTimeout(12_000) {
        client.get("${baseUrl.endpoint()}/api/containers/$cid/metrics/insights?window=$window").body()
    }

    suspend fun models(baseUrl: String): ModelsResponse = withTimeout(8_000) {
        client.get("${baseUrl.endpoint()}/api/models").body()
    }
}
