import Foundation

/// Pure helpers for the project slice: metrics figures (web `performanceModel.ts`), the
/// agent limit and worktree grace period, and byte sizes.
enum PerfUx {
    static let notEnough = "Not enough data"
    static let notMetered = "Not metered"

    static let ranges: [(key: String, label: String)] = [
        ("7d", "7 days"), ("30d", "30 days"), ("90d", "90 days"), ("all", "All time"),
    ]

    struct Figure: Equatable {
        var text: String
        var known: Bool
        var sub: String
    }

    static func pct(_ v: Double) -> String { "\(Int((v * 100).rounded()))%" }

    /// Compact duration: 45s · 12m · 3.4h · 2.1d.
    static func span(_ secs: Double) -> String {
        guard secs.isFinite, secs >= 0 else { return "—" }
        if secs < 60 { return "\(Int(secs.rounded()))s" }
        if secs < 3600 { return "\(Int((secs / 60).rounded()))m" }
        if secs < 86400 { return trim1(secs / 3600) + "h" }
        return trim1(secs / 86400) + "d"
    }

    private static func trim1(_ n: Double) -> String {
        let r = (n * 10).rounded() / 10
        return r == r.rounded() ? String(Int(r)) : String(format: "%.1f", r)
    }

    static func cost(_ v: Double) -> String {
        if v >= 100 { return "$\(Int(v.rounded()))" }
        if v >= 1 { return String(format: "$%.2f", v) }
        return String(format: v >= 0.01 ? "$%.2f" : "$%.3f", v)
    }

    private static func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String {
        "\(n) " + (n == 1 ? one : (many ?? one + "s"))
    }

    static func firstPass(_ m: PerfMetricsDto) -> Figure {
        let r = m.firstPassRate
        let sub = "\(r.numerator) of \(plural(r.denominator, "verified task"))"
        guard r.enough, let v = r.value else { return Figure(text: notEnough, known: false, sub: sub) }
        return Figure(text: pct(v), known: true, sub: sub)
    }

    static func median(_ m: PerfMetricsDto) -> Figure {
        let d = m.medianTimeToVerifiedSeconds
        let sub = plural(d.n, "task")
        guard d.enough, let v = d.value else { return Figure(text: notEnough, known: false, sub: sub) }
        return Figure(text: span(v), known: true, sub: sub)
    }

    static func costPerVerified(_ m: PerfMetricsDto) -> Figure {
        let c = m.costPerVerifiedTaskUsd
        let unmet = c.unmeteredTasks > 0 ? " · \(c.unmeteredTasks) not metered" : ""
        let sub = plural(c.meteredTasks, "metered task") + unmet
        if c.meteredTasks == 0 && c.unmeteredTasks == 0 { return Figure(text: notEnough, known: false, sub: sub) }
        if c.meteredTasks == 0 { return Figure(text: notMetered, known: false, sub: sub) }
        guard c.enough, let v = c.value else { return Figure(text: notEnough, known: false, sub: sub) }
        return Figure(text: cost(v), known: true, sub: sub)
    }

    static func planApproval(_ m: PerfMetricsDto) -> Figure {
        let p = m.planApprovalRate
        let sub = "\(p.approved) of \(plural(p.denominator, "plan"))"
        guard p.enough, let v = p.value else { return Figure(text: notEnough, known: false, sub: sub) }
        return Figure(text: pct(v), known: true, sub: sub)
    }

    static func rework(_ m: PerfMetricsDto) -> String {
        "\(plural(m.rework.humanRejections, "rejection")) · \(plural(m.rework.managerSendBacks, "send-back"))"
    }

    enum Tone: Equatable { case good, warn, bad }

    /// Only with enough data — never a default "good".
    static func firstPassTone(_ m: PerfMetricsDto) -> Tone? {
        guard m.firstPassRate.enough, let v = m.firstPassRate.value else { return nil }
        if v >= 0.8 { return .good }
        if v >= 0.5 { return .warn }
        return .bad
    }

    static let definitions: [(term: String, meaning: String)] = [
        ("Verified", "Tasks a human verified in this range. Auto-completed (full autonomy) tasks are not verifications."),
        ("First pass", "Share of verified tasks accepted with no rejection and no manager send-back."),
        ("Rework", "Human rejections plus AI-manager pre-review send-backs in this range."),
        ("Time to verified", "Median time from the task starting to its verification."),
        ("Cost / verified", "Average dollar cost of metered verified tasks. Unmetered tasks are excluded, never $0."),
        ("Plan approval", "Approved plans out of all plan decisions in this range."),
        ("Escalations", "Asks that went to a human (escalated by the agent or after expiring)."),
    ]
}

enum ProjectLimitsUx {
    /// The agent-limit row's description (web `agentLimitDesc`).
    static func agentLimitDesc(inUse: Int?) -> String {
        "Suggested agents that can be created in this project" + (inUse.map { " — \($0) in use" } ?? "")
    }

    static func clampLimit(_ n: Int, _ limits: ContainerLimitsDto) -> Int {
        min(limits.maxMaxAutoAgents, max(limits.minMaxAutoAgents, n))
    }

    static let graceRange = 0...90

    static func clampGrace(_ n: Int) -> Int { min(graceRange.upperBound, max(graceRange.lowerBound, n)) }

    static func worktreeState(_ s: String) -> String {
        switch s {
        case "clean": "Clean"
        case "has-output": "Has output"
        case "unmerged": "Unmerged commits"
        case "in-use": "In use"
        case "not-quorate": "Not an agent worktree"
        default: s.replacingOccurrences(of: "-", with: " ").capitalized
        }
    }

    static func bytes(_ n: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
    }

    /// The objective editor's save-failure line (web `objectiveSaveError`).
    static func objectiveSaveError(_ error: Error) -> String {
        if let api = error as? OrchaApiError {
            if api.status == 404 || api.status == 405 {
                return "This Embodent can't edit objectives yet — update it, or set one by applying a template."
            }
            if api.status >= 500 { return "Couldn't save the objective — Embodent hit an error. Try again." }
            if api.status == 413 { return "That objective is too long — keep it under 4,000 characters." }
        }
        let why = InboxErrorText.describe(error)
        return "Couldn't save the objective — " + why + (why.hasSuffix(".") || why.hasSuffix("!") || why.hasSuffix("?") ? "" : ".")
    }

    static let objectiveMax = 4000
}
