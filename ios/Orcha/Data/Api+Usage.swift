import Foundation

/// Usage slice endpoints (all reads): the Metrics aggregate, the token meter, one
/// agent's spend drilldown and the rule-based spend insights.
extension OrchaApiClient {

    /// `GET /api/containers/{cid}/metrics?days=7|30`
    func metricsSummary(_ base: String, _ cid: String, days: Int) async throws -> MetricsSummaryDto {
        try await get(base, "/api/containers/\(cid)/metrics?days=\(days)")
    }

    /// `GET /api/containers/{cid}/token-usage` — 5h / 7d / all windows + quota.
    func tokenUsage(_ base: String, _ cid: String) async throws -> TokenUsageDto {
        try await get(base, "/api/containers/\(cid)/token-usage")
    }

    /// `GET /api/containers/{cid}/metrics/agents/{aid}/spend?window=5h|7d|30d|all`
    func agentSpend(_ base: String, _ cid: String, agentId: String, window: String) async throws -> AgentSpendDto {
        try await get(base, "/api/containers/\(cid)/metrics/agents/\(agentId)/spend?window=\(window)")
    }

    /// `GET /api/containers/{cid}/metrics/insights?window=7d|all`
    func metricsInsights(_ base: String, _ cid: String, window: String) async throws -> InsightsDto {
        try await get(base, "/api/containers/\(cid)/metrics/insights?window=\(window)")
    }
}
