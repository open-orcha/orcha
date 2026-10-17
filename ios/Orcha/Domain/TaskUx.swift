import Foundation

/* =============================================================================
   Pure presentation logic for the task-detail parity slice — ports of the web's
   EvidenceSummaryLine.summaryParts, reviewRoute.managerReviewLine, GoalChain
   folding and the routine schedule presets (schedule.ts toCron). Unit-tested.
   ============================================================================= */

enum EvidenceTone: Equatable { case ok, warn, bad, muted, plain }

struct EvidencePart: Equatable, Identifiable {
    let key: String
    let text: String
    let tone: EvidenceTone
    var id: String { key }
}

enum EvidenceUx {
    /// "3/4 DoD items evidenced · 42 tests passed · 1 risk flag · Verdikt pass" — each part
    /// only when it is real (web `summaryParts`).
    static func summaryParts(_ s: EvidenceSummaryDto?, short: Bool = false) -> [EvidencePart] {
        guard let s else { return [] }
        var parts: [EvidencePart] = []
        if let af = autofixPart(s.autofix) { parts.append(af) }
        if let d = s.dod, d.total > 0 {
            let tone: EvidenceTone = d.notProven > 0 ? .bad : (d.proven == d.total ? .ok : .plain)
            parts.append(EvidencePart(
                key: "dod",
                text: short ? "\(d.proven)/\(d.total) DoD" : "\(d.proven)/\(d.total) DoD items evidenced",
                tone: tone
            ))
        }
        if let t = s.tests {
            let bad = t.failed + t.errors
            if t.status == "none" {
                parts.append(EvidencePart(key: "tests", text: "no tests ran", tone: .muted))
            } else if bad > 0 {
                parts.append(EvidencePart(key: "tests", text: "\(bad) test\(bad == 1 ? "" : "s") failing", tone: .bad))
            } else if t.passed > 0 {
                parts.append(EvidencePart(key: "tests", text: "\(t.passed) test\(t.passed == 1 ? "" : "s") passed", tone: .ok))
            } else if t.status == "exit_ok" {
                parts.append(EvidencePart(key: "tests", text: "tests exited 0", tone: .plain))
            } else if t.status == "failed" {
                parts.append(EvidencePart(key: "tests", text: "tests failing", tone: .bad))
            } else if t.status == "unverified" {
                parts.append(EvidencePart(key: "tests", text: "tests ran (result unreadable)", tone: .muted))
            }
        }
        if s.riskFlags > 0 {
            let n = s.riskFlags
            parts.append(EvidencePart(
                key: "risk",
                text: short ? "\(n) risk\(n == 1 ? "" : "s")" : "\(n) risk flag\(n == 1 ? "" : "s")",
                tone: .warn
            ))
        }
        if let v = s.verdikt {
            parts.append(EvidencePart(key: "verdikt", text: verdiktBrief(status: v.status, verdict: v.verdict), tone: verdiktTone(status: v.status, verdict: v.verdict)))
        }
        return parts
    }

    static func autofixPart(_ a: AutofixSummaryDto?) -> EvidencePart? {
        guard let a else { return nil }
        if a.status == "running" {
            return EvidencePart(key: "autofix", text: "Auto-fix: attempt \(a.currentAttempt) of \(a.maxAttempts)", tone: .plain)
        }
        let n = a.attemptsMade
        let why: [String: String] = [
            "pass": "Verdikt passed on attempt \(n)/\(a.maxAttempts)",
            "attempt_limit": "Auto-fix stopped: failed \(n) of \(a.maxAttempts) attempts",
            "no_diff": "Auto-fix stopped: the rework changed no code",
            "same_failure": "Auto-fix stopped: same failure twice",
            "budget": "Auto-fix stopped: budget limit",
            "agent_paused": "Auto-fix stopped: agent paused",
            "stopped_by_human": "Auto-fix stopped by a person",
            "turned_off": "Auto-fix turned off",
            "no_assignee": "Auto-fix stopped: nobody assigned",
        ]
        let text = why[a.stopKind ?? ""] ?? "Auto-fix stopped"
        return EvidencePart(key: "autofix", text: text, tone: a.stopKind == "pass" ? .ok : .warn)
    }

    /// "Verdikt pass" / "Verdikt running" / "Verdikt timeout".
    static func verdiktBrief(status: String, verdict: String?) -> String {
        if status == "completed", let verdict { return "Verdikt \(verdict)" }
        if status == "queued" { return "Verdikt queued" }
        if status == "running" { return "Verdikt running" }
        return "Verdikt \(status)"
    }

    static func verdiktTone(status: String, verdict: String?) -> EvidenceTone {
        if status == "completed", let verdict {
            return verdict == "pass" ? .ok : (verdict == "fail" ? .bad : .warn)
        }
        if status == "queued" || status == "running" { return .plain }
        return status == "cancelled" ? .muted : .warn
    }

    /// The Verdikt panel's status line (web `STATUS_TEXT` + "Verdict: pass").
    static func verdiktStatusText(_ run: VerdiktRunDto) -> String {
        if run.status == "completed", let verdict = run.verdict { return "Verdict: \(verdict)" }
        switch run.status {
        case "queued": return "Queued in Verdikt"
        case "running": return "Verdikt is testing…"
        case "completed": return "Verdikt finished"
        case "failed": return "Verdikt run failed"
        case "unavailable": return "Verdikt unavailable"
        case "timeout": return "Verdikt timed out"
        case "cancelled": return "Verdikt run cancelled"
        default: return "Verdikt \(run.status)"
        }
    }

    static func verdiktIsOpen(_ run: VerdiktRunDto?) -> Bool {
        guard let run else { return false }
        return run.status == "queued" || run.status == "running"
    }

    static func dodStatusLabel(_ status: String) -> String {
        switch status {
        case "proven": "Proven"
        case "not_proven": "Not proven"
        default: "Needs a human"
        }
    }

    /// One test command's result line (web `invText`).
    static func invocationText(_ inv: TestInvocationDto) -> (text: String, tone: EvidenceTone) {
        if let c = inv.counts {
            let bad = c.failed + c.errors
            let unit = (c.unit == nil || c.unit == "tests") ? "" : " \(c.unit ?? "")"
            var text = "\(c.passed) passed"
            if bad > 0 { text += " · \(bad) failed" }
            if c.skipped > 0 { text += " · \(c.skipped) skipped" }
            return (text + unit, bad > 0 ? .bad : (c.passed > 0 ? .ok : .muted))
        }
        if inv.outcome == "exit_ok" { return ("exit 0 · no summary line", .plain) }
        if inv.outcome == "exit_failed" {
            return (inv.exitCode.map { "exit \($0)" } ?? "errored", .bad)
        }
        return ("result not captured", .muted)
    }

    /// "Built 3m ago from 2 runs since the last rejection" (relative part supplied).
    static func builtLine(runs: Int, ago: String?, sinceRejection: Bool) -> String {
        var line = "Built"
        if let ago { line += " \(ago)" }
        line += " from \(runs) run\(runs == 1 ? "" : "s")"
        if sinceRejection { line += " since the last rejection" }
        return line
    }
}

// MARK: - AI manager pre-review

enum ManagerReviewUx {
    /// The one line every surface shows (web `managerReviewLine`). Nil when there is none.
    /// Web `reviewVia`: why this reviewer ("via Atlas’s manager"); nil when nothing was routed.
    static func via(_ routing: ReviewRoutingDto?) -> String? {
        guard let routing else { return nil }
        let who = routing.assigneeAlias ?? "the assignee"
        switch routing.routedVia {
        case "reports_to": return "via \(who)’s " + ((routing.managerDepth ?? 1) > 1 ? "manager chain" : "manager")
        case "owner": return "project owner"
        case "fallback": return "no manager in \(who)’s chain can verify — anyone may"
        case "manual": return routing.setByAlias.map { "set by \($0)" } ?? "set by a person"
        default: return nil
        }
    }

    static func line(_ mr: ManagerReviewDto?) -> (text: String, tone: EvidenceTone)? {
        guard let mr, let status = mr.status else { return nil }
        let name = mr.managerAlias ?? "The manager"
        let who = name + " (manager)"
        let why = mr.reasons.flatMap { $0.isEmpty ? nil : ": " + $0 } ?? ""
        switch status {
        case "pending": return (who + " is pre-reviewing — you can still decide now", .plain)
        case "approved": return (who + " recommends approval" + why, .ok)
        case "sent_back": return (who + " sent it back" + why, .bad)
        case "commented": return (who + " commented" + why, .muted)
        case "superseded": return (name + "’s pre-review was skipped — a person decided first", .muted)
        case "overridden": return (who + " sent it back — accepted anyway by a person", .muted)
        default: return nil
        }
    }
}

// MARK: - goal ancestry

enum GoalCrumb: Equatable, Identifiable {
    case objective(text: String?, projectTitle: String)
    case gap(label: String, hint: String)
    case parent(id: String, title: String, status: String?)
    case this

    var id: String {
        switch self {
        case .objective: "objective"
        case .gap: "gap"
        case .parent(let id, _, _): "parent:" + id
        case .this: "this"
        }
    }
}

enum GoalChainUx {
    /// Parents shown in full before the far ones fold into one "…" crumb (web parity).
    static let maxShownParents = 2

    static func crumbs(_ chain: GoalChainDto) -> [GoalCrumb] {
        let nodes = chain.goalChain
        let parents = nodes.filter { $0.kind == "parent" && $0.id != nil }
        let folded = parents.count > maxShownParents ? Array(parents.prefix(parents.count - maxShownParents)) : []
        let shownParents = parents.suffix(min(parents.count, maxShownParents))
        var out: [GoalCrumb] = []
        if let objective = nodes.first(where: { $0.kind == "objective" }) {
            let text = objective.text?.trimmingCharacters(in: .whitespacesAndNewlines)
            out.append(.objective(text: (text?.isEmpty ?? true) ? nil : text, projectTitle: objective.title))
        }
        let note = chain.cycle ? "The parent links loop — showing each task once"
            : (chain.truncated ? "More ancestors exist above these" : "")
        if !folded.isEmpty {
            let names = folded.map(\.title).joined(separator: " › ")
            let count = folded.count
            var hint = "\(count) more parent task\(count == 1 ? "" : "s"): \(names)"
            if !note.isEmpty { hint += " — " + note }
            out.append(.gap(label: "…", hint: hint))
        } else if !note.isEmpty {
            out.append(.gap(label: chain.cycle ? "(loop)" : "(more above)", hint: note))
        }
        for p in shownParents {
            out.append(.parent(id: p.id ?? "", title: p.title, status: p.status))
        }
        if nodes.contains(where: { $0.kind == "task" }) { out.append(.this) }
        return out
    }

    /// Worth showing only when there is more than "This task" alone.
    /// Hidden when nothing sits above the task but the bare project (no objective, no
    /// parent) — the page breadcrumb already says that (Android/web rule).
    static func isWorthShowing(_ crumbs: [GoalCrumb]) -> Bool {
        crumbs.contains {
            switch $0 {
            case .this: false
            case .objective(let text, _): !(text ?? "").isEmpty
            case .gap, .parent: true
            }
        }
    }

    /// One plain sentence for VoiceOver: "Goal chain: Ship v1 › Parent › This task".
    static func spoken(_ crumbs: [GoalCrumb]) -> String {
        "Goal chain: " + crumbs.map { crumb -> String in
            switch crumb {
            case .objective(let text, let project): text ?? "\(project), no objective set"
            case .gap(_, let hint): hint
            case .parent(_, let title, _): title
            case .this: "This task"
            }
        }.joined(separator: ", then ")
    }
}

// MARK: - routines ("Make recurring…")

enum TaskRoutinePreset: String, CaseIterable, Identifiable, Hashable {
    case daily, weekdays, weekly
    var id: String { rawValue }

    var label: String {
        switch self {
        case .daily: "Daily"
        case .weekdays: "Weekdays"
        case .weekly: "Weekly"
        }
    }
}

/// The create body for `POST …/routines` — a copy of the task, never the task itself.
struct TaskRoutineDraft: Equatable {
    var title: String
    var description: String?
    var definitionOfDone: String
    var assigneeAgentId: String?
    var priority: Int
    var cron: String
    var timezone: String
    var skipIfOpen: Bool
    var originTaskId: String
}

enum TaskRoutineUx {
    static let dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

    /// 5-field cron for a preset (web `toCron`). `weekday` is 0 = Sunday … 6 = Saturday.
    static func cron(_ preset: TaskRoutinePreset, hour: Int, minute: Int, weekday: Int) -> String {
        let h = min(23, max(0, hour))
        let m = min(59, max(0, minute))
        switch preset {
        case .daily: return "\(m) \(h) * * *"
        case .weekdays: return "\(m) \(h) * * 1-5"
        case .weekly: return "\(m) \(h) * * \(((weekday % 7) + 7) % 7)"
        }
    }

    /// Local fallback for the schedule line when the preview endpoint isn't reachable.
    static func describe(_ preset: TaskRoutinePreset, hour: Int, minute: Int, weekday: Int) -> String {
        let time = String(format: "%02d:%02d", min(23, max(0, hour)), min(59, max(0, minute)))
        switch preset {
        case .daily: return "Every day at \(time)"
        case .weekdays: return "Every weekday at \(time)"
        case .weekly: return "Every \(dayNames[((weekday % 7) + 7) % 7]) at \(time)"
        }
    }

    /// The routine template a task becomes (web `routinePrefillFromTask`): assignee only
    /// when it's a live AI agent (routines assign each run to an AI agent).
    static func draft(
        from task: TaskDto, agents: [AgentDto],
        cron: String, timezone: String, skipIfOpen: Bool
    ) -> TaskRoutineDraft {
        let aliases = task.assignees.isEmpty ? (task.ownerAlias.map { [$0] } ?? []) : task.assignees
        let ai = aliases.lazy
            .compactMap { alias in agents.first { $0.alias == alias } }
            .first { $0.kind == "ai" && $0.terminatedAt == nil }
        let description = task.description?.trimmingCharacters(in: .whitespacesAndNewlines)
        return TaskRoutineDraft(
            title: task.title,
            description: (description?.isEmpty ?? true) ? nil : task.description,
            definitionOfDone: task.definitionOfDone ?? "",
            assigneeAgentId: ai?.id,
            priority: max(0, task.priority ?? 100),
            cron: cron,
            timezone: timezone,
            skipIfOpen: skipIfOpen,
            originTaskId: task.id
        )
    }
}

// MARK: - reassign

enum ReassignUx {
    /// Live AI agents of the project (humans don't poll for work — the server refuses them).
    static func candidates(_ agents: [AgentDto]) -> [AgentDto] {
        agents
            .filter { $0.kind == "ai" && $0.terminatedAt == nil }
            .sorted { $0.alias.localizedCaseInsensitiveCompare($1.alias) == .orderedAscending }
    }

    /// The server refuses to (re)assign the root, a finished or a cancelled task.
    static func canReassign(_ task: TaskDto) -> Bool {
        !task.isRoot && !["completed", "needs_verification", "cancelled"].contains(task.status)
    }
}

// MARK: - close implications (Android CloseImplicationsUx parity)

enum CloseImplicationsUx {
    static let genericCopy = "Closes it as cancelled and unblocks anything waiting on it. A running worker isn't stopped. A reason is sent to the assignee."

    /// The lines the destructive close confirm lists. Empty when nothing is worth warning about.
    static func lines(_ response: CloseImplicationsDto?) -> [String] {
        guard let response else { return [] }
        var out: [String] = []
        if let s = response.summary {
            if s.completesContainer {
                out.append("This is the root task — closing it marks the whole project complete.")
            }
            if s.downstreamTotal > 0 {
                out.append("\(count(s.downstreamTotal, "downstream task")) depend on it: \(s.wouldUnblock) would unblock, \(s.stillBlocked) stay blocked.")
            }
            if s.inFlightAgents > 0 {
                out.append("\(count(s.inFlightAgents, "agent")) \(s.inFlightAgents == 1 ? "is" : "are") working on it right now.")
            }
            if s.openRequests > 0 {
                out.append("\(count(s.openRequests, "open request")) from its assignees would be orphaned.")
            }
        }
        out += response.implications.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        return out
    }

    /// The confirm's message: the bulleted impact lines, else the generic copy.
    static func message(_ response: CloseImplicationsDto?) -> String {
        let l = lines(response)
        return l.isEmpty ? genericCopy : l.map { "· " + $0 }.joined(separator: "\n")
    }

    private static func count(_ n: Int, _ noun: String) -> String { "\(n) \(noun)\(n == 1 ? "" : "s")" }
}

// MARK: - deliverables (web deliverables/api.ts parity)

enum DeliverableUx {
    static let textKinds: Set<String> = ["markdown", "text", "csv", "json"]
    static let closedStatuses: Set<String> = ["completed", "cancelled"]

    static func isText(_ kind: String) -> Bool { textKinds.contains(kind) }

    /// Web `KIND_LABEL`.
    static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "markdown": "Markdown document"
        case "text": "Text file"
        case "json": "JSON file"
        case "csv": "Table (CSV)"
        case "pdf": "PDF document"
        case "image": "Image"
        default: "File"
        }
    }

    static func glyph(_ kind: String) -> String {
        switch kind {
        case "csv": "tablecells"
        case "pdf": "doc.richtext"
        case "image": "photo"
        case "json": "curlybraces"
        default: "doc.text"
        }
    }

    /// Web `formatBytes`.
    static func formatBytes(_ n: Int?) -> String {
        guard let n, n >= 0 else { return "—" }
        if n < 1024 { return "\(n) B" }
        if n < 1024 * 1024 {
            let kb = Double(n) / 1024
            return n < 10 * 1024 ? String(format: "%.1f KB", kb) : String(format: "%.0f KB", kb)
        }
        return String(format: "%.1f MB", Double(n) / (1024 * 1024))
    }

    /// Web `dirOf` — "reports/" for "reports/q3.md", "" at the top level.
    static func dirOf(_ path: String) -> String {
        guard let i = path.lastIndex(of: "/"), i > path.startIndex else { return "" }
        return String(path[...i])
    }

    /// Web `sourceLabel` — "Run output · dev" / "Attached · Hussein".
    static func sourceLabel(_ v: DeliverableVersionDto?) -> String {
        guard let v else { return "" }
        let isRun = v.source == "run_output"
        let who = v.authorAlias ?? (isRun ? "agent run" : "")
        return (isRun ? "Run output" : "Attached") + (who.isEmpty ? "" : " · " + who)
    }

    /// Humans attach only to open, non-root tasks (the server re-checks).
    static func canAttach(status: String, isRoot: Bool, canWrite: Bool) -> Bool {
        canWrite && !isRoot && !closedStatuses.contains(status)
    }

    /// Upload toast copy (web `onFiles`).
    static func uploadToast(added: Int, unchanged: Int) -> String {
        if added == 0 { return "No changes — identical to the latest version" }
        return "Attached \(added) file\(added == 1 ? "" : "s")" + (unchanged > 0 ? " · \(unchanged) unchanged" : "")
    }

    /// MIME type for an upload by extension (the server keys the kind off the extension).
    static func mimeType(for fileName: String) -> String {
        switch (fileName as NSString).pathExtension.lowercased() {
        case "md", "markdown": "text/markdown"
        case "txt", "log", "yaml", "yml": "text/plain"
        case "csv": "text/csv"
        case "tsv": "text/tab-separated-values"
        case "json": "application/json"
        case "pdf": "application/pdf"
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "gif": "image/gif"
        case "webp": "image/webp"
        default: "application/octet-stream"
        }
    }

    /// The server's `{"detail": "…"}` string ("file too large (max 25 MiB)"), when present.
    static func serverDetail(_ body: String) -> String? {
        guard let data = body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let detail = obj["detail"] as? String,
              !detail.isEmpty else { return nil }
        return detail
    }

    static let defaultExtensions = ["md", "markdown", "txt", "log", "yaml", "yml", "csv", "tsv", "json", "pdf", "png", "jpg", "jpeg", "gif", "webp"]
}
