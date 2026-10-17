import Foundation

/// The routine editor's schedule presets ⇄ 5-field cron (web `pages/routines/schedule.ts`).
/// The server (`/routines/preview`) is the authority for validity, wording and next runs;
/// this only turns the controls into a cron, reads a saved cron back, and gives an
/// instant fallback line while the preview is in flight.
enum RoutineSchedulePreset: String, CaseIterable, Identifiable, Hashable {
    case hourly, daily, weekdays, weekly, monthly, custom
    var id: String { rawValue }

    var label: String {
        switch self {
        case .hourly: "Hourly"
        case .daily: "Daily"
        case .weekdays: "Weekdays"
        case .weekly: "Weekly"
        case .monthly: "Monthly"
        case .custom: "Custom"
        }
    }
}

struct RoutineScheduleForm: Equatable {
    var preset: RoutineSchedulePreset = .weekdays
    /// hourly: minute past the hour
    var minute = 0
    var hour = 9
    var timeMinute = 0
    /// weekly: 0 = Sunday … 6 = Saturday
    var weekday = 1
    /// monthly: 1–28
    var monthDay = 1
    /// custom: raw cron
    var cron = "0 9 * * 1-5"
}

enum RoutineScheduleUx {
    static let dayNames = TaskRoutineUx.dayNames

    static func toCron(_ f: RoutineScheduleForm) -> String {
        let h = min(23, max(0, f.hour))
        let m = min(59, max(0, f.timeMinute))
        switch f.preset {
        case .hourly: return "\(min(59, max(0, f.minute))) * * * *"
        case .daily: return "\(m) \(h) * * *"
        case .weekdays: return "\(m) \(h) * * 1-5"
        case .weekly: return "\(m) \(h) * * \(((f.weekday % 7) + 7) % 7)"
        case .monthly: return "\(m) \(h) \(min(28, max(1, f.monthDay))) * *"
        case .custom: return normalize(f.cron)
        }
    }

    static func normalize(_ cron: String) -> String {
        cron.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Read a saved cron back into the preset controls (Custom when it isn't a preset shape).
    static func fromCron(_ cron: String) -> RoutineScheduleForm {
        let expr = normalize(cron)
        var base = RoutineScheduleForm(preset: .custom, cron: expr)
        let f = expr.split(separator: " ").map(String.init)
        guard f.count == 5 else { return base }
        let (mi, hr, dom, mon, dow) = (f[0], f[1], f[2], f[3], f[4])
        guard let minute = num(mi), mon == "*" else { return base }
        if hr == "*", dom == "*", dow == "*" {
            base.preset = .hourly
            base.minute = minute
            return base
        }
        guard let hour = num(hr), hour <= 23, minute <= 59 else { return base }
        base.hour = hour
        base.timeMinute = minute
        if dom == "*", dow == "*" { base.preset = .daily; return base }
        if dom == "*", dow == "1-5" || dow.uppercased() == "MON-FRI" { base.preset = .weekdays; return base }
        if dom == "*", let d = Int(dow), (0...7).contains(d), dow.count == 1 {
            base.preset = .weekly
            base.weekday = d % 7
            return base
        }
        if dow == "*", let d = num(dom), (1...28).contains(d) {
            base.preset = .monthly
            base.monthDay = d
            return base
        }
        base.hour = 9
        base.timeMinute = 0
        return base
    }

    private static func num(_ s: String) -> Int? {
        guard (1...2).contains(s.count), s.allSatisfy(\.isNumber) else { return nil }
        return Int(s)
    }

    /// "Africa/Nairobi" → "Nairobi time"; UTC stays "UTC" (server `zone_label`).
    static func zoneLabel(_ tz: String) -> String {
        if ["UTC", "Etc/UTC", "GMT", "Etc/GMT"].contains(tz) { return "UTC" }
        let city = tz.split(separator: "/").last.map(String.init) ?? tz
        return city.replacingOccurrences(of: "_", with: " ") + " time"
    }

    private static func ordinal(_ n: Int) -> String {
        let suffix: String
        if (11...13).contains(n % 100) { suffix = "th" } else {
            switch n % 10 {
            case 1: suffix = "st"
            case 2: suffix = "nd"
            case 3: suffix = "rd"
            default: suffix = "th"
            }
        }
        return "\(n)\(suffix)"
    }

    /// Plain English for preset shapes; mirrors the server's describe (server wins when it answers).
    static func describe(_ cron: String, timezone tz: String) -> String {
        let f = fromCron(cron)
        let zl = zoneLabel(tz)
        let at = String(format: "%02d:%02d", f.hour, f.timeMinute)
        switch f.preset {
        case .hourly: return String(format: "Every hour at :%02d", f.minute)
        case .daily: return "Every day at \(at) \(zl)"
        case .weekdays: return "Every weekday at \(at) \(zl)"
        case .weekly: return "Every \(dayNames[f.weekday]) at \(at) \(zl)"
        case .monthly: return "On the \(ordinal(f.monthDay)) of every month at \(at) \(zl)"
        case .custom: return "Custom schedule (\(f.cron)) \(zl)"
        }
    }

    /// A quick local shape check before asking the server: five fields, no empties.
    static func looksLikeCron(_ cron: String) -> Bool {
        normalize(cron).split(separator: " ").count == 5
    }

    /// Priority choices (web `PRIORITY_BUCKETS`).
    static let priorities: [(value: Int, label: String)] = [
        (1, "Urgent"), (10, "High"), (100, "Normal"), (200, "Low"),
    ]

    /// Who may create / edit routines: owner or the manage_agents grant (web `routineAuthority`).
    static let grant = Grant.manageAgents
}
