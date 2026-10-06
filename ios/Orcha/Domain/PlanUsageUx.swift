import Foundation

/// Pure presentation logic for plan usage (the desktop "Usage" panel on the phone):
/// merging snapshots across paired servers, reset / remaining copy, bar tones,
/// token and cost formatting, and the staleness line. Mirrors
/// `desktop/src/shared/usage.ts` and `renderer/src/usage/parts.tsx`.
enum PlanUsageUx {

    static let emptyText = "Plan usage appears when the Embodent desktop app is running on your computer."
    /// A snapshot older than this shows a muted "may be out of date".
    static let staleAfter: TimeInterval = 30 * 60
    static let pollInterval: Duration = .seconds(120)

    // MARK: model

    struct Window: Identifiable, Equatable, Sendable {
        let id: String
        let label: String
        /// Clamped 0…100.
        let usedPct: Double
        let resetsAt: Date?

        var usedRounded: Int { Int(usedPct.rounded()) }
        var leftRounded: Int { max(0, 100 - usedRounded) }
    }

    struct Provider: Identifiable, Equatable, Sendable {
        /// Raw provider id (`claude` / `codex`).
        let id: String
        let plan: String?
        let headline: String?
        let windows: [Window]
        let today: PlanUsageTodayDto?
        let host: String
        let capturedAt: Date?

        var name: String { PlanUsageUx.providerName(id) }
        var mark: ModelProvider? { PlanUsageUx.mark(id) }
        /// The window closest to its limit — what the compact card shows.
        var constrained: Window? { windows.max { $0.usedPct < $1.usedPct } }
    }

    enum Tone: Equatable, Sendable { case neutral, warn, danger }

    // MARK: merge

    /// Newest entry per provider across every snapshot from every server, ordered
    /// Claude first, then Codex, then anything else alphabetically.
    static func merge(_ snapshots: [PlanUsageSnapshotDto]) -> [Provider] {
        var best: [String: Provider] = [:]
        for snap in snapshots {
            let captured = parseDate(snap.capturedAt) ?? parseDate(snap.updatedAt)
            for dto in snap.providers {
                let key = dto.provider.lowercased()
                let candidate = Provider(
                    id: key,
                    plan: dto.plan.flatMap { $0.isEmpty ? nil : $0 },
                    headline: dto.headline.flatMap { $0.isEmpty ? nil : $0 },
                    windows: dto.windows.map {
                        Window(id: $0.key, label: $0.label, usedPct: clamp($0.usedPct), resetsAt: parseDate($0.resetsAt))
                    },
                    today: dto.today,
                    host: snap.host,
                    capturedAt: captured
                )
                if let existing = best[key],
                   (existing.capturedAt ?? .distantPast) >= (captured ?? .distantPast) {
                    continue
                }
                best[key] = candidate
            }
        }
        return best.values.sorted { order($0.id, $1.id) }
    }

    private static func order(_ a: String, _ b: String) -> Bool {
        let rank = ["claude": 0, "codex": 1]
        let ra = rank[a] ?? 2, rb = rank[b] ?? 2
        return ra != rb ? ra < rb : a < b
    }

    /// The header figure: the highest used % of any window ("Usage 34%"); nil when no windows.
    static func overallPercent(_ providers: [Provider]) -> Int? {
        providers.flatMap(\.windows).map(\.usedPct).max().map { Int($0.rounded()) }
    }

    // MARK: copy

    static func providerName(_ raw: String) -> String {
        switch raw.lowercased() {
        case "claude": "Claude"
        case "codex": "Codex"
        default: raw.prefix(1).uppercased() + raw.dropFirst()
        }
    }

    static func mark(_ raw: String) -> ModelProvider? {
        ModelProvider.for(raw)
    }

    static func clamp(_ pct: Double) -> Double {
        guard pct.isFinite else { return 0 }
        return min(100, max(0, pct))
    }

    /// Neutral below 70 %, warn 70–90 %, danger at 90 % and above.
    static func tone(_ pct: Double) -> Tone {
        let v = clamp(pct)
        if v > 90 { return .danger }
        if v > 75 { return .warn }  // desktop usage/parts.tsx: amber above 75 %, red above 90 %
        return .neutral
    }

    /// `in 3h 26m` / `in 1d 1h` / `in 12m`; `now` once passed; nil when unknown.
    static func resetIn(_ date: Date?, now: Date) -> String? {
        guard let date else { return nil }
        let mins = Int((date.timeIntervalSince(now) / 60).rounded(.up))
        if mins <= 0 { return "now" }
        let d = mins / 1440, h = (mins % 1440) / 60, m = mins % 60
        if d > 0 { return "in \(d)d" + (h > 0 ? " \(h)h" : "") }
        if h > 0 { return "in \(h)h" + (m > 0 ? " \(m)m" : "") }
        return "in \(m)m"
    }

    /// `resets in 3h 26m` (compact card) — nil when unknown.
    static func resetsInText(_ date: Date?, now: Date) -> String? {
        resetIn(date, now: now).map { $0 == "now" ? "resets now" : "resets \($0)" }
    }

    /// `today 4:49 PM` / `Sat 3:20 PM` / `Oct 7, 3:00 PM` in device-local time.
    static func resetAt(_ date: Date, now: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let time = format(date, template: "jmm", locale: locale, timeZone: timeZone)
        let days = date.timeIntervalSince(now) / 86_400
        if days < 1, cal.isDate(date, inSameDayAs: now) { return "today \(time)" }
        if days < 6 { return "\(format(date, template: "EEE", locale: locale, timeZone: timeZone)) \(time)" }
        return "\(format(date, template: "MMMd", locale: locale, timeZone: timeZone)), \(time)"
    }

    /// `92% left · resets today 4:49 PM · in 3h 26m` — what remains and when it refills.
    static func remainText(_ w: Window, now: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        var parts = ["\(w.leftRounded)% left"]
        if let at = w.resetsAt, let rel = resetIn(at, now: now) {
            if rel == "now" {
                parts.append("resets now")
            } else {
                parts.append("resets \(resetAt(at, now: now, locale: locale, timeZone: timeZone))")
                parts.append(rel)
            }
        }
        return parts.joined(separator: " · ")
    }

    /// `0`, `950`, `12.4K`, `3.20M`, `601M`, `1.05B`.
    static func tokens(_ n: Int) -> String {
        guard n >= 1000 else { return String(max(0, n)) }
        for (div, unit) in [(1e9, "B"), (1e6, "M"), (1e3, "K")] where Double(n) >= div {
            let v = Double(n) / div
            let digits = v >= 100 ? 0 : (v >= 10 ? 1 : 2)
            return String(format: "%.\(digits)f", v) + unit
        }
        return String(n)
    }

    /// `$237.61`; whole dollars with grouping from $1,000.
    static func usd(_ n: Double) -> String {
        guard n.isFinite else { return "$0.00" }
        if n >= 1000 {
            return "$" + Int(n.rounded()).formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US")))
        }
        return String(format: "$%.2f", n)
    }

    /// `Today 601M tokens · Est. $237.61`; nil when nothing to say.
    static func todayText(_ today: PlanUsageTodayDto?) -> String? {
        guard let today else { return nil }
        var parts: [String] = []
        if let t = today.tokens { parts.append("Today \(tokens(t)) tokens") }
        if let c = today.costUsd { parts.append(parts.isEmpty ? "Today est. \(usd(c))" : "Est. \(usd(c))") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// `Husseins-MacBook-Pro` from `Husseins-MacBook-Pro.local`.
    static func hostName(_ host: String) -> String {
        let trimmed = host.hasSuffix(".local") ? String(host.dropLast(6)) : host
        return trimmed.isEmpty ? "your computer" : trimmed
    }

    /// `Updated 2m ago from Husseins-MacBook-Pro`.
    static func updatedText(host: String, capturedAt: Date?, now: Date) -> String {
        let from = "from \(hostName(host))"
        guard let capturedAt else { return "Updated \(from)" }
        let mins = Int(now.timeIntervalSince(capturedAt) / 60)
        let ago: String = switch mins {
        case ..<1: "just now"
        case ..<60: "\(mins)m ago"
        case ..<(60 * 24): "\(mins / 60)h ago"
        default: "\(mins / (60 * 24))d ago"
        }
        return "Updated \(ago) \(from)"
    }

    static func isStale(_ capturedAt: Date?, now: Date) -> Bool {
        guard let capturedAt else { return true }
        return now.timeIntervalSince(capturedAt) > staleAfter
    }

    /// The freshest provider — drives the card's single staleness line.
    static func newest(_ providers: [Provider]) -> Provider? {
        providers.max { ($0.capturedAt ?? .distantPast) < ($1.capturedAt ?? .distantPast) }
    }

    /// Distinct desktop hosts behind the shown numbers, newest first (sheet footer).
    static func sources(_ providers: [Provider]) -> [(host: String, capturedAt: Date?)] {
        var seen = Set<String>()
        return providers
            .sorted { ($0.capturedAt ?? .distantPast) > ($1.capturedAt ?? .distantPast) }
            .compactMap { seen.insert($0.host).inserted ? ($0.host, $0.capturedAt) : nil }
    }

    // MARK: accessibility

    static func providerAccessibility(_ p: Provider, now: Date) -> String {
        var parts = ["\(p.name)" + (p.plan.map { " \($0) plan" } ?? "")]
        if let w = p.constrained {
            parts.append("\(w.label) window \(w.usedRounded) percent used")
            if let r = resetsInText(w.resetsAt, now: now) { parts.append(r) }
        }
        return parts.joined(separator: ", ")
    }

    static func windowAccessibility(_ w: Window, now: Date) -> String {
        "\(w.label) window, \(w.usedRounded) percent used, " + remainText(w, now: now).replacingOccurrences(of: " · ", with: ", ")
    }

    // MARK: dates

    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let whole = ISO8601DateFormatter()

    /// ISO-8601 with `Z` or a `±hh:mm` offset, with or without fractional seconds
    /// (microseconds are trimmed to milliseconds); a bare timestamp is read as UTC.
    static func parseDate(_ iso: String?) -> Date? {
        guard var s = iso?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
        s = s.replacingOccurrences(of: " ", with: "T")
        if s.range(of: #"(Z|[+-]\d{2}:?\d{2})$"#, options: .regularExpression) == nil { s += "Z" }
        if let r = s.range(of: #"\.\d+"#, options: .regularExpression) {
            let frac = s[r].dropFirst()
            let ms = String((frac + "000").prefix(3))
            s.replaceSubrange(r, with: "." + ms)
        }
        return fractional.date(from: s) ?? whole.date(from: s)
    }

    private static func format(_ date: Date, template: String, locale: Locale, timeZone: TimeZone) -> String {
        let f = DateFormatter()
        f.locale = locale
        f.timeZone = timeZone
        f.setLocalizedDateFormatFromTemplate(template)
        return f.string(from: date)
    }
}
