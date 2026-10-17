import Foundation

/// Pure copy helpers for the Routines screens (web `pages/routines/RoutinesPage.tsx`).
enum RoutineUx {

    enum Tone: Equatable { case neutral, ok, danger, info }

    /// The last-result chip: the created task's CURRENT status, or why the run didn't create one.
    static func lastResult(outcome: String?, taskId: String?, taskStatus: String?) -> (text: String, tone: Tone) {
        guard let outcome else { return ("Never run", .neutral) }
        switch outcome {
        case "created":
            guard taskId != nil else { return ("Task removed", .neutral) }
            let st = taskStatus ?? "unknown"
            return (statusWord(st), st == "completed" ? .ok : (st == "failed" ? .danger : .info))
        case "skipped": return ("Skipped", .neutral)
        case "failed": return ("Failed", .danger)
        default: return ("Creating…", .info)
        }
    }

    static func statusWord(_ s: String) -> String {
        let map = [
            "ready": "Ready", "pending": "Waiting on deps", "in_progress": "In progress", "blocked": "Blocked",
            "not_ready": "Held", "needs_verification": "Needs verification", "completed": "Done",
            "cancelled": "Cancelled", "failed": "Failed",
        ]
        return map[s] ?? s.replacingOccurrences(of: "_", with: " ").capitalized
    }

    static func triggerWord(trigger: String?, missedCount: Int?, actorAlias: String?) -> String {
        switch trigger {
        case "manual": return actorAlias.map { "Run now by \($0)" } ?? "Run now"
        case "catch_up": return (missedCount ?? 0) > 1 ? "Catch-up (\(missedCount!) missed)" : "Catch-up (late)"
        default: return "Scheduled"
        }
    }

    /// "in 3h" / "in 2 days" — the next run relative to now.
    static func relFuture(_ iso: String?, now: Date = Date()) -> String? {
        guard let date = MobileUx.parseInstant(iso) else { return nil }
        let secs = date.timeIntervalSince(now)
        if secs < 60 { return "any moment" }
        let mins = Int(secs / 60)
        switch mins {
        case ..<60: return "in \(mins)m"
        case ..<(60 * 24): return "in \(mins / 60)h"
        default:
            let days = mins / (60 * 24)
            return days == 1 ? "in 1 day" : "in \(days) days"
        }
    }

    /// The list row's next-run text (web: Paused / No upcoming run / relative).
    static func nextRunText(enabled: Bool, nextRunAt: String?, now: Date = Date()) -> String {
        guard enabled else { return "Paused" }
        guard let rel = relFuture(nextRunAt, now: now) else { return "No upcoming run" }
        return "Next run " + rel
    }

    static func runResultToast(detail: String?) -> String {
        if let detail, !detail.isEmpty { return "Task created — " + detail }
        return "Task created."
    }
}
