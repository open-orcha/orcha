import Foundation

/// Pure copy and bar maths for the Home tab's compact "This week" usage card
/// (`GET …/metrics?days=7`). Follows the Metrics screen's honesty rules: a cost
/// no run reported is never shown as $0 — the token total stands in instead.
enum UsageCardUx {

    struct Summary: Equatable {
        /// The big figure: "$53.63", or "1.2M tokens" when no run reported a cost.
        var figure: String
        /// Muted caption under the figure: "67 runs".
        var runs: String
        var accessibilityLabel: String
    }

    static let emptyText = "No runs this week"
    static let emptyAccessibilityLabel = "Usage this week: no runs. Opens Metrics and usage."

    /// nil → the card shows "No runs this week".
    static func summary(_ data: MetricsSummaryDto?) -> Summary? {
        guard let t = data?.totals, t.runs > 0 else { return nil }
        let figure = UsageUx.costUnreported(t)
            ? UsageUx.tokens(t.tokensIn + t.tokensOut) + " tokens"
            : UsageUx.usd(t.estCostUsd)
        let runs = UsageUx.plural(t.runs, "run")
        return Summary(
            figure: figure,
            runs: runs,
            accessibilityLabel: "Usage this week: \(figure), \(runs). Opens Metrics and usage."
        )
    }

    enum BarKind: Equatable { case peak, normal, zero }

    struct Bar: Equatable, Identifiable {
        var id: Int
        /// 0…1 of the tallest day.
        var fraction: Double
        var kind: BarKind
    }

    /// The last seven days of runs as sparkline bars, oldest first. Missing days pad
    /// at the front as zero ticks; the (first) busiest day is the peak.
    static func bars(_ daily: [MetricsDayDto], count: Int = 7) -> [Bar] {
        let runs = Array(daily.suffix(count).map(\.runs))
        let padded = Array(repeating: 0, count: max(0, count - runs.count)) + runs
        let peak = padded.max() ?? 0
        let peakIndex = peak > 0 ? padded.firstIndex(of: peak) : nil
        return padded.enumerated().map { index, value in
            guard value > 0, peak > 0 else { return Bar(id: index, fraction: 0, kind: .zero) }
            return Bar(id: index, fraction: Double(value) / Double(peak),
                       kind: index == peakIndex ? .peak : .normal)
        }
    }
}
