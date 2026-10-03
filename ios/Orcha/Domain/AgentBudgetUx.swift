import Foundation

/// Pure formatting + verdicts for agent budgets — a port of the web's `budgetModel.ts`
/// so the phone says exactly what the portal says.
enum AgentBudgetUx {
    enum Tone: Equatable { case ok, warn, over }

    static func usd(_ v: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US")
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 2
        return "$" + (f.string(from: NSNumber(value: v)) ?? String(format: "%.2f", v))
    }

    /// `1.2M` / `45k` / `812` — the web's `fmtTok`.
    static func tokens(_ v: Int) -> String {
        let d = Double(v)
        func trim(_ s: String) -> String { s.hasSuffix(".0") ? String(s.dropLast(2)) : s }
        if v >= 1_000_000 { return trim(String(format: v >= 10_000_000 ? "%.0f" : "%.1f", d / 1_000_000)) + "M" }
        if v >= 1_000 { return trim(String(format: v >= 10_000 ? "%.0f" : "%.1f", d / 1_000)) + "k" }
        return String(v)
    }

    static func percent(_ ratio: Double?) -> String {
        guard let ratio else { return "" }
        if ratio >= 9.99 { return ">999%" }
        return "\(Int((ratio * 100).rounded()))%"
    }

    /// Bar fill 0…1 (an overspend reads as a full bar in the over tone).
    static func fill(_ ratio: Double?) -> Double {
        guard let ratio else { return 0 }
        guard ratio.isFinite else { return 1 }
        return max(0, min(1, ratio))
    }

    static func tone(_ ratio: Double?) -> Tone {
        guard let ratio else { return .ok }
        if ratio >= 1 { return .over }
        if ratio >= 0.8 { return .warn }
        return .ok
    }

    /// The single verdict chip — from the real server state, never a default.
    static func healthLabel(_ b: AgentBudgetDto) -> String? {
        switch b.state {
        case "ok": "Within budget"
        case "warning": "Near limit"
        case "exceeded": b.paused ? "Paused" : "Over · override"
        default: nil
        }
    }

    /// "October 2026" from `2026-10`.
    static func period(_ key: String?) -> String {
        guard let key, key.count == 7,
              let y = Int(key.prefix(4)), let m = Int(key.suffix(2)), (1...12).contains(m)
        else { return key ?? "" }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        guard let date = cal.date(from: DateComponents(year: y, month: m, day: 1)) else { return key }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.timeZone = cal.timeZone
        f.dateFormat = "LLLL yyyy"
        return f.string(from: date)
    }

    /// "Nov 1" — the UTC day the month resets.
    static func reset(_ iso: String?) -> String {
        guard let date = MobileUx.parseInstant(iso) else { return "next month" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "MMM d"
        return f.string(from: date)
    }

    enum ParsedLimit: Equatable { case none, value(Double), invalid }

    /// Blank → no limit; a non-negative number → that value; anything else → invalid.
    static func parseLimit(_ raw: String, integer: Bool) -> ParsedLimit {
        let t = raw.trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
            .replacingOccurrences(of: " ", with: "")
        if t.isEmpty { return .none }
        guard let n = Double(t), n.isFinite, n >= 0 else { return .invalid }
        return .value(integer ? n.rounded() : (n * 100).rounded() / 100)
    }

    /// The compact roster line: "$12.40 of $50.00" / "1.2M of 2M tokens" / nil when no limit.
    static func rosterLine(_ b: AgentBudgetDto) -> String? {
        if let limit = b.limits.usd, !b.spendUnknown {
            return "\(usd(b.usage.spendUsd)) of \(usd(limit))"
        }
        if let cap = b.limits.tokens {
            return "\(tokens(b.usage.tokens)) of \(tokens(cap)) tokens"
        }
        return nil
    }

    /// The worst ratio among the set limits (drives the roster tone).
    static func worstRatio(_ b: AgentBudgetDto) -> Double? {
        [b.usdRatio, b.tokenRatio].compactMap { $0 }.max()
    }
}
