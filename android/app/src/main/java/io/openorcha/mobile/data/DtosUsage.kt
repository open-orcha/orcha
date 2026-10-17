package io.openorcha.mobile.data

/* Usage slice DTOs (web cloud/metrics/MetricsPage): the aggregate
   GET /api/containers/{cid}/metrics?days=7|30, the token-usage windows
   GET /api/containers/{cid}/token-usage, the agent spend drilldown
   GET .../metrics/agents/{aid}/spend?window= and GET .../metrics/insights?window=.
   Every field defaults so an older backend or a missing key never fails the decode. */

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

// ── GET /metrics?days= ──

@Serializable
data class MxTotalsDto(
    val runs: Int = 0,
    @SerialName("sandbox_seconds") val sandboxSeconds: Double = 0.0,
    @SerialName("est_cost_usd") val estCostUsd: Double = 0.0,
    @SerialName("tokens_in") val tokensIn: Long = 0,
    @SerialName("tokens_out") val tokensOut: Long = 0,
    @SerialName("runs_with_cost") val runsWithCost: Int = 0,
    @SerialName("runs_with_tokens") val runsWithTokens: Int = 0,
    @SerialName("tasks_completed") val tasksCompleted: Int = 0,
    @SerialName("tasks_verified") val tasksVerified: Int = 0,
)

@Serializable
data class MxAgentDto(
    @SerialName("agent_id") val agentId: String = "",
    val alias: String? = null,
    val model: String? = null,
    val runs: Int = 0,
    @SerialName("ok_runs") val okRuns: Int = 0,
    @SerialName("failed_runs") val failedRuns: Int = 0,
    @SerialName("sandbox_seconds") val sandboxSeconds: Double = 0.0,
    @SerialName("est_cost_usd") val estCostUsd: Double = 0.0,
    @SerialName("tokens_in") val tokensIn: Long = 0,
    @SerialName("tokens_out") val tokensOut: Long = 0,
    @SerialName("runs_with_tokens") val runsWithTokens: Int = 0,
    @SerialName("last_active") val lastActive: String? = null,
)

@Serializable
data class MxDayDto(
    val date: String = "",
    val runs: Int = 0,
    @SerialName("est_cost_usd") val estCostUsd: Double = 0.0,
    @SerialName("sandbox_seconds") val sandboxSeconds: Double = 0.0,
)

@Serializable
data class MetricsSummaryResponse(
    val days: Int = 7,
    val totals: MxTotalsDto = MxTotalsDto(),
    @SerialName("per_agent") val perAgent: List<MxAgentDto> = emptyList(),
    val daily: List<MxDayDto> = emptyList(),
)

// ── GET /token-usage ──

@Serializable
data class TokenWindowDto(
    @SerialName("input_tokens") val inputTokens: Long = 0,
    @SerialName("output_tokens") val outputTokens: Long = 0,
    @SerialName("cache_read_input_tokens") val cacheReadInputTokens: Long = 0,
    @SerialName("cache_creation_input_tokens") val cacheCreationInputTokens: Long = 0,
    @SerialName("total_tokens") val totalTokens: Long = 0,
    @SerialName("total_cost_usd") val totalCostUsd: Double = 0.0,
    val runs: Int = 0,
    @SerialName("runs_with_cost") val runsWithCost: Int? = null,
    @SerialName("quota_tokens") val quotaTokens: Long? = null,
    @SerialName("pct_of_quota") val pctOfQuota: Double? = null,
)

@Serializable
data class TokenUsageAgentDto(
    @SerialName("agent_id") val agentId: String = "",
    val alias: String? = null,
    val runs: Int = 0,
    @SerialName("total_tokens") val totalTokens: Long = 0,
    @SerialName("total_cost_usd") val totalCostUsd: Double = 0.0,
)

@Serializable
data class LastWakeDto(
    @SerialName("run_id") val runId: String? = null,
    @SerialName("agent_alias") val agentAlias: String? = null,
    @SerialName("ended_at") val endedAt: String? = null,
    @SerialName("total_tokens") val totalTokens: Long = 0,
    @SerialName("total_cost_usd") val totalCostUsd: Double = 0.0,
)

@Serializable
data class TokenUsageResponse(
    val windows: Map<String, TokenWindowDto> = emptyMap(),
    @SerialName("per_agent") val perAgent: List<TokenUsageAgentDto> = emptyList(),
    @SerialName("last_wake") val lastWake: LastWakeDto? = null,
)

// ── GET /metrics/agents/{aid}/spend?window= ──

@Serializable
data class SpendAgentDto(
    val id: String = "",
    val alias: String? = null,
    val model: String? = null,
    @SerialName("reasoning_effort") val reasoningEffort: String? = null,
)

@Serializable
data class SpendTaskDto(
    @SerialName("task_id") val taskId: String? = null,
    val title: String? = null,
    val status: String? = null,
    val runs: Int = 0,
    @SerialName("input_tokens") val inputTokens: Long = 0,
    @SerialName("output_tokens") val outputTokens: Long = 0,
    @SerialName("cache_read_input_tokens") val cacheReadInputTokens: Long = 0,
    @SerialName("cache_creation_input_tokens") val cacheCreationInputTokens: Long = 0,
    @SerialName("total_tokens") val totalTokens: Long = 0,
    @SerialName("total_cost_usd") val totalCostUsd: Double = 0.0,
    @SerialName("runs_with_cost") val runsWithCost: Int? = null,
    @SerialName("last_run_at") val lastRunAt: String? = null,
)

@Serializable
data class AgentSpendResponse(
    val agent: SpendAgentDto = SpendAgentDto(),
    val window: String = "7d",
    val totals: TokenWindowDto = TokenWindowDto(),
    val tasks: List<SpendTaskDto> = emptyList(),
)

// ── GET /metrics/insights?window= ──

@Serializable
data class SpendInsightDto(
    val id: String = "",
    val severity: String = "info",
    val title: String = "",
    val detail: String = "",
    val evidence: JsonObject = JsonObject(emptyMap()),
    val action: String = "",
)

@Serializable
data class SpendInsightsResponse(
    val window: String = "7d",
    val insights: List<SpendInsightDto> = emptyList(),
)
