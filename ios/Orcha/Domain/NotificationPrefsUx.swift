import Foundation

/// Pure helpers for the notification preferences screen (web
/// `pages/settings/notifications/notificationPrefs.ts` parity).
enum NotificationPrefsUx {

    /// The channels this phone edits. Desktop and Slack are shown read-only.
    static let deviceChannels: Set<String> = ["in_app", "push"]

    enum PauseChoice: String, CaseIterable, Identifiable {
        case oneHour, tomorrow, forever
        var id: String { rawValue }
        var label: String {
            switch self {
            case .oneHour: "For 1 hour"
            case .tomorrow: "Until tomorrow"
            case .forever: "Until I turn it back on"
            }
        }
    }

    /// The `pause` value for a snooze choice. "Until tomorrow" = 8:00 tomorrow, local time.
    static func pause(for choice: PauseChoice, now: Date = Date(), calendar: Calendar = .current) -> NotifPause {
        switch choice {
        case .forever: return NotifPause(until: nil)
        case .oneHour: return NotifPause(until: (now.timeIntervalSince1970 + 3600).rounded())
        case .tomorrow:
            let startToday = calendar.startOfDay(for: now)
            let tomorrow8 = calendar.date(byAdding: DateComponents(day: 1, hour: 8), to: startToday) ?? now.addingTimeInterval(86_400)
            return NotifPause(until: tomorrow8.timeIntervalSince1970.rounded())
        }
    }

    static func isPaused(_ pause: NotifPause?, now: Date = Date()) -> Bool {
        guard let pause else { return false }
        guard let until = pause.until else { return true }
        return now.timeIntervalSince1970 < until
    }

    /// "Paused until 3:40 PM" / "Paused until tomorrow, 8:00 AM" / "Paused until you turn them back on".
    static func pauseText(_ pause: NotifPause?, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String? {
        guard isPaused(pause, now: now) else { return nil }
        guard let until = pause?.until else { return "Paused until you turn them back on" }
        let d = Date(timeIntervalSince1970: until)
        let tf = DateFormatter()
        tf.locale = locale
        tf.calendar = calendar
        tf.timeZone = calendar.timeZone
        tf.dateStyle = .none
        tf.timeStyle = .short
        let time = tf.string(from: d)
        if calendar.isDate(d, inSameDayAs: now) { return "Paused until " + time }
        if let tmr = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(d, inSameDayAs: tmr) {
            return "Paused until tomorrow, " + time
        }
        let df = DateFormatter()
        df.locale = locale
        df.calendar = calendar
        df.timeZone = calendar.timeZone
        df.setLocalizedDateFormatFromTemplate("MMMd")
        return "Paused until " + df.string(from: d) + ", " + time
    }

    static func lockReason(_ catalog: NotifCatalog, category: String, channel: String) -> String? {
        catalog.locks.first { $0.category == category && $0.channel == channel }.map { $0.reason ?? "Always on" }
    }

    /// The project's override with one category changed (the PUT replaces the whole map,
    /// so the rest is carried over untouched).
    static func projectRules(
        _ current: [String: NotifPartialRule], category: String,
        scope: String? = nil, channel: String? = nil, on: Bool? = nil
    ) -> [String: NotifPartialRule] {
        var out = current
        var rule = out[category] ?? NotifPartialRule(scope: nil, channels: nil)
        if let scope { rule.scope = scope }
        if let channel, let on {
            var ch = rule.channels ?? [:]
            ch[channel] = on
            rule.channels = ch
        }
        out[category] = rule
        return out
    }

    /// "22:00" ⇄ minutes after midnight.
    static func minutes(_ hhmm: String) -> Int? {
        let parts = hhmm.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]), (0..<24).contains(h), (0..<60).contains(m) else { return nil }
        return h * 60 + m
    }

    static func hhmm(_ minutes: Int) -> String {
        let m = ((minutes % 1440) + 1440) % 1440
        return String(format: "%02d:%02d", m / 60, m % 60)
    }

    /// Scope key → its catalog label ("Only mine"), never the raw key.
    static func scopeLabel(_ key: String, catalog: NotifCatalog) -> String {
        catalog.scopes.first { $0.key == key }?.label ?? (key == "mine" ? "Only mine" : key.capitalized)
    }
}
