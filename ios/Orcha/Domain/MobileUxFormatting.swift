import Foundation

// Responsibility: Relative-time, expiry, and day-divider formatting shared by mobile screens.

extension MobileUx {
    // MARK: shared — compact relative time + expiry + day dividers

    private static let isoParser: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoParserNoFraction = ISO8601DateFormatter()

    static func parseInstant(_ iso: String?) -> Date? {
        guard var iso, !iso.isEmpty else { return nil }
        if !iso.hasSuffix("Z") && !iso.contains("+") { iso += "Z" }
        return isoParser.date(from: iso) ?? isoParserNoFraction.date(from: iso)
    }

    static func agoLabel(_ iso: String?, now: Date = Date()) -> String? {
        guard let then = parseInstant(iso) else { return nil }
        let mins = Int(now.timeIntervalSince(then) / 60)
        switch mins {
        case ..<1: return "just now"
        case ..<60: return "\(mins)m ago"
        case ..<(60 * 24): return "\(mins / 60)h ago"
        default: return "\(mins / (60 * 24))d ago"
        }
    }

    static func expiryChip(_ expiresAt: String?, now: Date = Date()) -> ExpiryChip? {
        guard let then = parseInstant(expiresAt) else { return nil }
        let deltaMin = Int(then.timeIntervalSince(now) / 60)
        if deltaMin < 0 { return .expired }
        if deltaMin >= 120 { return nil }
        if deltaMin >= 60 { return .warn("expires in \(deltaMin / 60)h \(deltaMin % 60)m") }
        return .warn("expires in \(deltaMin)m")
    }

    static func dayKey(_ iso: String?) -> String? {
        guard let iso, iso.count >= 10 else { return nil }
        let key = String(iso.prefix(10))
        return key.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil ? key : nil
    }

    static func dayLabel(_ iso: String?) -> String? {
        guard let key = dayKey(iso) else { return nil }
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        guard (1...12).contains(parts[1]) else { return nil }
        return "\(months[parts[1] - 1]) \(parts[2])"
    }

}
