import Foundation

/// Pure formatting and verdicts for Metrics › usage — a port of the web's
/// `MetricsPage.tsx` helpers (`fmtUsd`, `fmtTokens`, `costCaptionShort`, `runHealth`,
/// `costBarPct`, `spendCostState`, `insightsForAgent`) so the phone says exactly what
/// the portal says. Dollar figures are never faked: an unreported cost reads
/// "Not reported", not $0.
enum UsageUx {

    // MARK: windows

    static let summaryRanges: [(key: Int, label: String)] = [(7, "7 days"), (30, "30 days")]
    static let spendWindows: [(key: String, label: String)] = [
        ("5h", "5 hours"), ("7d", "7 days"), ("30d", "30 days"), ("all", "All time"),
    ]
    /// The token meter has no 30-day window.
    static let meterWindows: [(key: String, label: String)] = [
        ("5h", "5 hours"), ("7d", "7 days"), ("all", "All time"),
    ]

    /// Insights only have 7d / all: 5h → 7d, 30d → all.
    static func insightsWindow(for window: String) -> String {
        window == "5h" || window == "7d" ? "7d" : "all"
    }

    static func spendWindow(forDays days: Int) -> String { days == 30 ? "30d" : "7d" }

    // MARK: formatters

    static let notReported = "not reported"
    static let notReportedTip = "No cost was recorded for these runs (subscription billing, an unpriced model, or a runtime that reports tokens only). This is not $0 — the token counts are the usage signal."
    static let costExplainer = "Usage and estimated spend per agent — runs, sandbox compute, tokens and cost, parsed from each run's recorded usage. Dollar figures are estimates: only runs whose worker reported cost contribute (the caption says how many did); runs that reported no cost are shown as “not reported”, never as $0."
    static let cacheNote = "Cache reads count toward your plan quota but cost little in dollars — that's why tokens and cost tell different stories. Total tokens sums all four kinds."
    static let healthRule = "On track under 5% failed runs · At risk 5–20% · Off track 20% or more"

    static func usd(_ v: Double) -> String {
        if v != 0 && v < 0.01 { return String(format: "$%.4f", v) }
        if v < 1000 { return String(format: "$%.2f", v) }
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US")
        f.maximumFractionDigits = 0
        return "$" + (f.string(from: NSNumber(value: v.rounded())) ?? String(Int(v.rounded())))
    }

    /// `812` · `1.6K` · `346.6K` · `37.5M` — the web's `fmtTokens`.
    static func tokens(_ v: Int) -> String {
        func trim(_ s: String) -> String { s.hasSuffix(".0") ? String(s.dropLast(2)) : s }
        let d = Double(v)
        if v < 1000 { return String(v) }
        if v < 1_000_000 { return trim(String(format: "%.1f", d / 1000)) + "K" }
        return trim(String(format: "%.1f", d / 1_000_000)) + "M"
    }

    /// `0s` · `45s` · `12m 5s` · `3h 4m` · `2d 1h` — the web's `fmtDuration`.
    static func duration(_ secs: Double) -> String {
        let s0 = Int(secs.isFinite ? secs.rounded() : 0)
        if s0 <= 0 { return "0s" }
        let d = s0 / 86400, h = (s0 % 86400) / 3600, m = (s0 % 3600) / 60, s = s0 % 60
        if d > 0 { return "\(d)d \(h)h" }
        if h > 0 { return "\(h)h \(m)m" }
        if m > 0 { return s > 0 ? "\(m)m \(s)s" : "\(m)m" }
        return "\(s)s"
    }

    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// `2026-09-29` → `Sep 29`.
    static func day(_ iso: String) -> String {
        let parts = iso.split(separator: "-")
        guard parts.count == 3, let m = Int(parts[1]), let d = Int(parts[2]), (1...12).contains(m) else { return iso }
        return "\(months[m - 1]) \(d)"
    }

    static func plural(_ n: Int, _ one: String) -> String { "\(n) \(one)\(n == 1 ? "" : "s")" }

    // MARK: cost honesty

    static func costUnreported(_ t: MetricsTotalsDto) -> Bool { t.runs > 0 && t.runsWithCost == 0 }
    static func costComplete(_ t: MetricsTotalsDto) -> Bool { t.runs > 0 && t.runsWithCost >= t.runs }

    /// The one-line caption under Est. cost.
    static func costCaptionShort(_ t: MetricsTotalsDto) -> String {
        if t.runs == 0 { return "no runs" }
        if t.runsWithCost == 0 { return "see tokens" }
        return t.runsWithCost >= t.runs ? "all runs reported" : "from \(t.runsWithCost) of \(t.runs) runs"
    }

    /// A row's dollar text: the figure when known, else "not reported".
    static func rowCost(_ v: Double, complete: Bool) -> String? {
        v > 0 || complete ? usd(v) : nil
    }

    /// Cost share bar 0…1 — nil when there's nothing honest to draw.
    static func costBarFraction(_ cost: Double, max maxCost: Double, known: Bool) -> Double? {
        guard maxCost > 0, cost > 0 || known else { return nil }
        let pct = (cost / maxCost * 100).rounded()
        return pct < 1 ? nil : pct / 100
    }

    enum CostState: Equatable { case full, partial, none }

    /// Spend-row cost completeness: every run reported a cost, some did, or none did.
    static func spendCostState(_ m: TokenMixDto) -> CostState {
        guard let n = m.runsWithCost else { return m.totalCostUsd > 0 ? .partial : .none }
        if n <= 0 { return .none }
        return n >= m.runs ? .full : .partial
    }

    static func spendCostCaption(_ m: TokenMixDto) -> String? {
        guard m.runs > 0 else { return nil }
        switch spendCostState(m) {
        case .none: return "no run reported a cost"
        case .full: return nil
        case .partial:
            if let n = m.runsWithCost { return "partial · \(n) of \(plural(m.runs, "run")) reported cost" }
            return "partial · some runs reported no cost"
        }
    }

    // MARK: health

    enum Health: Equatable { case onTrack, atRisk, offTrack, noData }

    static func health(failed: Int, total: Int) -> Health {
        guard total > 0 else { return .noData }
        let rate = Double(max(0, failed)) / Double(total)
        if rate >= 0.20 { return .offTrack }
        if rate >= 0.05 { return .atRisk }
        return .onTrack
    }

    static func healthLabel(_ h: Health) -> String {
        switch h {
        case .onTrack: "On track"
        case .atRisk: "At risk"
        case .offTrack: "Off track"
        case .noData: "No runs"
        }
    }

    /// "54 of 56 runs succeeded · 1 failed"
    static func healthDetail(_ a: MetricsAgentDto) -> String {
        guard a.runs > 0 else { return "No runs in this window" }
        return "\(a.okRuns) of \(plural(a.runs, "run")) succeeded" + (a.failedRuns > 0 ? " · \(a.failedRuns) failed" : "")
    }

    static func tokensReported(_ a: MetricsAgentDto) -> Bool {
        if let n = a.runsWithTokens { return n > 0 }
        return a.tokensIn + a.tokensOut > 0
    }

    /// Agents for the "Cost & activity" list: by cost desc, or by tokens when no run
    /// in the window reported a cost.
    static func sortedAgents(_ d: MetricsSummaryDto) -> [MetricsAgentDto] {
        let byTokens = costUnreported(d.totals)
        return d.perAgent.sorted {
            let x = byTokens ? Double($0.tokensIn + $0.tokensOut) : $0.estCostUsd
            let y = byTokens ? Double($1.tokensIn + $1.tokensOut) : $1.estCostUsd
            return x != y ? x > y : ($0.alias ?? "") < ($1.alias ?? "")
        }
    }

    // MARK: models

    /// Catalog name, else a readable id (`claude-opus-5-5` → `Claude Opus 5.5`), else nil.
    static func modelName(_ id: String?, catalog: [ModelDto]) -> String? {
        guard let id, !id.isEmpty else { return nil }
        if let name = catalog.first(where: { $0.id == id })?.name, !name.isEmpty { return name }
        var words: [String] = []
        var digits: [String] = []
        for part in id.split(separator: "-").map(String.init) {
            if part.count >= 8, Int(part) != nil { continue } // date stamp
            if Int(part) != nil { digits.append(part) } else {
                if !digits.isEmpty { words.append(digits.joined(separator: ".")); digits = [] }
                words.append(part.prefix(1).uppercased() + part.dropFirst())
            }
        }
        if !digits.isEmpty { words.append(digits.joined(separator: ".")) }
        return words.isEmpty ? id : words.joined(separator: " ")
    }

    // MARK: token mix

    struct MixPart: Equatable, Identifiable {
        let key: String
        let label: String
        let value: Int
        let fraction: Double
        var id: String { key }
    }

    static func mixParts(_ m: TokenMixDto) -> [MixPart] {
        let raw = [
            ("in", "Input", m.inputTokens), ("out", "Output", m.outputTokens),
            ("read", "Cache read", m.cacheReadTokens), ("write", "Cache write", m.cacheWriteTokens),
        ]
        let sum = raw.reduce(0) { $0 + $1.2 }
        return raw.map { MixPart(key: $0.0, label: $0.1, value: $0.2, fraction: sum > 0 ? Double($0.2) / Double(sum) : 0) }
    }

    static func percent(_ f: Double) -> String {
        let p = f * 100
        if p > 0 && p < 1 { return "<1%" }
        return "\(Int(p.rounded()))%"
    }

    /// Cache reads ÷ (input + cache reads), one decimal — nil without input.
    static func cacheHitPct(_ m: TokenMixDto) -> Double? {
        let denom = m.inputTokens + m.cacheReadTokens
        guard denom > 0 else { return nil }
        return (Double(m.cacheReadTokens) / Double(denom) * 1000).rounded() / 10
    }

    /// Quota fill 0…1, or nil when no quota is configured.
    static func quotaFraction(_ m: TokenMixDto) -> Double? {
        guard m.quotaTokens != nil, let pct = m.pctOfQuota else { return nil }
        return max(0, min(1, pct / 100))
    }

    // MARK: insights

    static func severityLabel(_ s: String) -> String {
        switch s {
        case "high": "High"
        case "medium": "Medium"
        default: "Info"
        }
    }

    private static let agentInsightKinds: Set<String> = ["cold-context", "wake-churn", "heavy-model-small-talk", "subscription-loop"]

    /// The insights that concern ONE agent (web `insightsForAgent`).
    static func insightsForAgent(_ insights: [InsightDto], agentId: String, alias: String?, taskIds: [String?]) -> [InsightDto] {
        let tasks = Set(taskIds.compactMap { $0 })
        return insights.filter { i in
            let parts = i.id.split(separator: ":", maxSplits: 1).map(String.init)
            let kind = parts.first ?? ""
            let ref = parts.count > 1 ? parts[1] : nil
            if agentInsightKinds.contains(kind) {
                return ref == agentId || (alias != nil && i.evidenceAlias == alias)
            }
            let tid = i.taskId ?? ((kind == "context-bloat" || kind == "concentration") ? ref : nil)
            guard let tid else { return false }
            return tasks.contains(tid)
        }
    }

    // MARK: budgets

    /// Agents with a budget (state ≠ none), for the Monthly budgets list.
    static func budgetedAgents(_ b: ProjectBudgetsDto, agentId: String? = nil) -> [AgentBudgetDto] {
        b.agents.filter { a in
            if let agentId { return a.agentId == agentId && a.state != "none" }
            return a.state != "none"
        }
    }
}
