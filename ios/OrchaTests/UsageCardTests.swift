import Foundation
import Testing
@testable import Orcha

/// Home "This week" usage card: figure / caption / VoiceOver copy and sparkline bars.
@Suite struct UsageCardTests {

    private func summary(runs: Int, cost: Double, withCost: Int, tokensIn: Int = 0, tokensOut: Int = 0,
                         daily: [Int] = []) throws -> MetricsSummaryDto {
        let days = daily.enumerated().map { "{\"date\":\"2026-09-2\($0.offset)\",\"runs\":\($0.element)}" }
        let json = """
        {"days":7,"totals":{"runs":\(runs),"est_cost_usd":\(cost),"tokens_in":\(tokensIn),
         "tokens_out":\(tokensOut),"runs_with_cost":\(withCost)},"per_agent":[],
         "daily":[\(days.joined(separator: ","))]}
        """
        return try JSONDecoder().decode(MetricsSummaryDto.self, from: Data(json.utf8))
    }

    @Test func costFigureAndVoiceOverLabel() throws {
        let s = try #require(UsageCardUx.summary(try summary(runs: 67, cost: 53.62863, withCost: 58)))
        #expect(s.figure == "$53.63")
        #expect(s.runs == "67 runs")
        #expect(s.accessibilityLabel == "Usage this week: $53.63, 67 runs. Opens Metrics and usage.")
    }

    @Test func unreportedCostFallsBackToTokens() throws {
        let s = try #require(UsageCardUx.summary(
            try summary(runs: 1, cost: 0, withCost: 0, tokensIn: 1566, tokensOut: 346_650)))
        #expect(s.figure == "348.2K tokens")
        #expect(s.runs == "1 run")
    }

    @Test func noRunsOrNoDataIsEmpty() throws {
        #expect(UsageCardUx.summary(nil) == nil)
        #expect(UsageCardUx.summary(try summary(runs: 0, cost: 0, withCost: 0)) == nil)
    }

    @Test func barsMarkPeakAndZeroDays() throws {
        let d = try summary(runs: 9, cost: 1, withCost: 9, daily: [0, 2, 4, 0, 4, 1, 0])
        let bars = UsageCardUx.bars(d.daily)
        #expect(bars.count == 7)
        #expect(bars.map(\.kind) == [.zero, .normal, .peak, .zero, .normal, .normal, .zero])
        #expect(bars[1].fraction == 0.5 && bars[2].fraction == 1)
    }

    @Test func barsPadShortSeriesAndKeepLastSeven() throws {
        let short = UsageCardUx.bars(try summary(runs: 3, cost: 0, withCost: 0, daily: [3]).daily)
        #expect(short.map(\.kind) == [.zero, .zero, .zero, .zero, .zero, .zero, .peak])
        let long = UsageCardUx.bars(try summary(runs: 8, cost: 0, withCost: 0, daily: [5, 1, 1, 1, 1, 1, 1, 2]).daily)
        #expect(long.count == 7 && long.last?.kind == .peak)
        let quiet = UsageCardUx.bars(try summary(runs: 0, cost: 0, withCost: 0, daily: [0, 0]).daily)
        #expect(quiet.allSatisfy { $0.kind == .zero })
    }
}
