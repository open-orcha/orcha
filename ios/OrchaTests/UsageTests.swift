import Foundation
import Testing
@testable import Orcha

/// Usage slice: Metrics aggregate / token meter / spend drilldown / insights decoding,
/// and the web `MetricsPage.tsx` formatting + honesty rules.
@Suite struct UsageDecodingTests {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    @Test func decodesMetricsSummary() throws {
        let d = try decode(MetricsSummaryDto.self, """
        {"days":7,"totals":{"runs":67,"sandbox_seconds":0.0,"est_cost_usd":53.62863,"tokens_in":1566,
         "tokens_out":346650,"runs_with_cost":58,"runs_with_tokens":58,"tasks_completed":1,"tasks_verified":1},
         "per_agent":[{"agent_id":"a1","alias":"Atlas","model":"claude-opus-5-5","runs":56,"ok_runs":54,
         "failed_runs":1,"sandbox_seconds":0.0,"est_cost_usd":43.53,"tokens_in":1176,"tokens_out":273686,
         "runs_with_tokens":49,"last_active":"2026-10-02T02:47:55+00:00"},
         {"agent_id":"a2","alias":"Ferry","model":null,"runs":6,"ok_runs":6,"failed_runs":0,"est_cost_usd":5.96}],
         "daily":[{"date":"2026-09-29","runs":26,"est_cost_usd":21.9,"sandbox_seconds":0.0}]}
        """)
        #expect(d.totals.runs == 67 && d.totals.runsWithCost == 58)
        #expect(d.perAgent.count == 2 && d.perAgent[0].okRuns == 54 && d.perAgent[1].model == nil)
        #expect(d.daily.first?.runs == 26)
    }

    @Test func decodesTokenUsageWithNullQuota() throws {
        let u = try decode(TokenUsageDto.self, """
        {"container_id":"c","windows":{
          "5h":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,
                "total_tokens":0,"total_cost_usd":0.0,"runs":0,"quota_tokens":null,"pct_of_quota":null},
          "7d":{"input_tokens":1566,"output_tokens":346650,"cache_read_input_tokens":35049893,
                "cache_creation_input_tokens":2056240,"total_tokens":37454349,"total_cost_usd":53.62863,"runs":58,
                "quota_tokens":50000000,"pct_of_quota":74.91}},
         "per_agent":[{"agent_id":"a1","alias":"Atlas","runs":49,"total_tokens":28483709,"total_cost_usd":43.53}],
         "last_wake":{"run_id":"r","agent_alias":"Atlas","ended_at":"2026-10-02T02:47:55+00:00",
                      "total_tokens":233945,"total_cost_usd":0.325788}}
        """)
        #expect(u.windows["5h"]?.quotaTokens == nil)
        #expect(UsageUx.quotaFraction(u.windows["5h"]!) == nil)
        #expect(u.windows["7d"]?.totalTokens == 37_454_349)
        #expect(abs((UsageUx.quotaFraction(u.windows["7d"]!) ?? 0) - 0.7491) < 0.0001)
        #expect(u.perAgent.first?.alias == "Atlas")
        #expect(u.lastWake?.totalTokens == 233_945)
    }

    @Test func decodesSpendWithConversationRow() throws {
        let s = try decode(AgentSpendDto.self, """
        {"agent":{"id":"a1","alias":"Atlas","model":"claude-opus-5-5","reasoning_effort":null},"window":"7d",
         "totals":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":90,"cache_creation_input_tokens":5,
                   "total_tokens":125,"total_cost_usd":1.5,"runs":4,"runs_with_cost":3},
         "tasks":[{"task_id":"t1","title":"Weekly Audit","status":"completed","runs":3,"input_tokens":5,
                   "output_tokens":10,"cache_read_input_tokens":45,"cache_creation_input_tokens":0,"total_tokens":60,
                   "total_cost_usd":1.0,"runs_with_cost":3},
                  {"task_id":null,"title":"Conversation & drains","status":null,"runs":1,"total_tokens":65}]}
        """)
        #expect(s.agent.model == "claude-opus-5-5")
        #expect(s.tasks.count == 2)
        #expect(s.tasks[0].mix.cacheReadTokens == 45)
        #expect(s.tasks[1].id == "__conversation__")
        #expect(UsageUx.spendCostState(s.totals) == .partial)
        #expect(UsageUx.spendCostCaption(s.totals) == "partial · 3 of 4 runs reported cost")
    }

    @Test func decodesInsightsEvidence() throws {
        let i = try decode(InsightsDto.self, """
        {"window":"7d","insights":[{"id":"concentration:__none__","severity":"info","title":"T","detail":"D",
          "evidence":{"task_id":null,"task_title":"Conversation & drains"},"action":"A"},
          {"id":"wake-churn:a1","severity":"high","title":"Churn","evidence":{"agent_alias":"Atlas"}}]}
        """)
        #expect(i.insights.count == 2)
        #expect(i.insights[1].evidenceAlias == "Atlas")
        #expect(UsageUx.severityLabel(i.insights[1].severity) == "High")
    }
}

@Suite struct UsageUxTests {

    @Test func formatsLikeTheWeb() {
        #expect(UsageUx.usd(53.62863) == "$53.63")
        #expect(UsageUx.usd(0.005) == "$0.0050")
        #expect(UsageUx.usd(1234.4) == "$1,234")
        #expect(UsageUx.tokens(812) == "812")
        #expect(UsageUx.tokens(1566) == "1.6K")
        #expect(UsageUx.tokens(346_650) == "346.6K")
        #expect(UsageUx.tokens(37_454_349) == "37.5M")
        #expect(UsageUx.tokens(2_000_000) == "2M")
        #expect(UsageUx.duration(0) == "0s")
        #expect(UsageUx.duration(125) == "2m 5s")
        #expect(UsageUx.duration(3 * 3600 + 240) == "3h 4m")
        #expect(UsageUx.day("2026-09-29") == "Sep 29")
    }

    @Test func costCaptions() {
        var t = MetricsTotalsDto()
        #expect(UsageUx.costCaptionShort(t) == "no runs")
        t.runs = 67
        #expect(UsageUx.costCaptionShort(t) == "see tokens")
        #expect(UsageUx.costUnreported(t))
        t.runsWithCost = 58
        #expect(UsageUx.costCaptionShort(t) == "from 58 of 67 runs")
        t.runsWithCost = 67
        #expect(UsageUx.costCaptionShort(t) == "all runs reported")
        #expect(UsageUx.costComplete(t))
    }

    @Test func healthThresholds() {
        #expect(UsageUx.health(failed: 0, total: 0) == .noData)
        #expect(UsageUx.health(failed: 1, total: 56) == .onTrack)
        #expect(UsageUx.health(failed: 1, total: 20) == .atRisk)
        #expect(UsageUx.health(failed: 4, total: 20) == .offTrack)
        let a = MetricsAgentDto(agentId: "a", alias: "Atlas", runs: 56, okRuns: 54, failedRuns: 1)
        #expect(UsageUx.healthDetail(a) == "54 of 56 runs succeeded · 1 failed")
    }

    @Test func costBarIsHonest() {
        #expect(UsageUx.costBarFraction(5, max: 0, known: true) == nil)
        #expect(UsageUx.costBarFraction(0, max: 10, known: false) == nil)
        #expect(UsageUx.costBarFraction(0.001, max: 10, known: true) == nil)
        #expect(UsageUx.costBarFraction(5, max: 10, known: true) == 0.5)
        #expect(UsageUx.rowCost(0, complete: false) == nil)
        #expect(UsageUx.rowCost(0, complete: true) == "$0.00")
    }

    @Test func modelNames() throws {
        let catalog = try JSONDecoder().decode([ModelDto].self, from: Data(#"[{"id":"claude-opus-5-5","name":"Opus 5.5"}]"#.utf8))
        #expect(UsageUx.modelName("claude-opus-5-5", catalog: catalog) == "Opus 5.5")
        #expect(UsageUx.modelName("claude-haiku-4-5-20251001", catalog: []) == "Claude Haiku 4.5")
        #expect(UsageUx.modelName(nil, catalog: catalog) == nil)
    }

    @Test func tokenMixAndCacheHit() {
        let m = TokenMixDto(input: 1566, output: 346_650, cacheRead: 35_049_893, cacheWrite: 2_056_240)
        let parts = UsageUx.mixParts(m)
        #expect(parts.map(\.label) == ["Input", "Output", "Cache read", "Cache write"])
        #expect(abs(parts.reduce(0) { $0 + $1.fraction } - 1) < 0.0001)
        #expect(UsageUx.percent(parts[0].fraction) == "<1%")
        #expect(UsageUx.percent(parts[2].fraction) == "94%")
        #expect(UsageUx.cacheHitPct(TokenMixDto(input: 10, output: 0, cacheRead: 90, cacheWrite: 0)) == 90)
        #expect(UsageUx.cacheHitPct(TokenMixDto()) == nil)
    }

    @Test func windows() {
        #expect(UsageUx.insightsWindow(for: "5h") == "7d")
        #expect(UsageUx.insightsWindow(for: "30d") == "all")
        #expect(UsageUx.spendWindow(forDays: 30) == "30d")
    }

    @Test func insightsForOneAgent() {
        let all = [
            InsightDto(id: "wake-churn:a1", severity: "high", title: "x"),
            InsightDto(id: "cold-context:a2", severity: "medium", title: "y", evidenceAlias: "Atlas"),
            InsightDto(id: "concentration:t1", severity: "info", title: "z"),
            InsightDto(id: "cache-write-churn", severity: "info", title: "w"),
        ]
        let mine = UsageUx.insightsForAgent(all, agentId: "a1", alias: "Atlas", taskIds: ["t1", nil])
        #expect(mine.map(\.id) == ["wake-churn:a1", "cold-context:a2", "concentration:t1"])
    }

    @Test func sortsAgentsByCostThenTokens() throws {
        var d = try JSONDecoder().decode(MetricsSummaryDto.self, from: Data("""
        {"totals":{"runs":3,"runs_with_cost":3},"per_agent":[
          {"agent_id":"a","alias":"A","est_cost_usd":1,"tokens_in":900,"tokens_out":0},
          {"agent_id":"b","alias":"B","est_cost_usd":5,"tokens_in":10,"tokens_out":0}]}
        """.utf8))
        #expect(UsageUx.sortedAgents(d).map(\.agentId) == ["b", "a"])
        d.totals.runsWithCost = 0
        #expect(UsageUx.sortedAgents(d).map(\.agentId) == ["a", "b"])
    }
}
