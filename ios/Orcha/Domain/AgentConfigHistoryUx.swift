import Foundation

/// Pure copy for the agent config history — a port of the web's `configHistoryModel.ts`.
enum AgentConfigHistoryUx {
    static func fieldLabel(_ field: String) -> String {
        switch field {
        case "alias": "Name"
        case "role": "Role"
        case "system_prompt": "Prompt"
        case "model": "Model"
        case "reasoning_effort": "Reasoning effort"
        case "auto_wake_interval_secs": "Auto-wake"
        case "autonomy_override": "Autonomy"
        case "provider": "Provider"
        default: field.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private static func interval(_ secs: Int) -> String {
        if secs > 0, secs % 86400 == 0 { return secs == 86400 ? "Daily" : "Every \(secs / 86400) days" }
        if secs > 0, secs % 3600 == 0 { return secs == 3600 ? "Hourly" : "Every \(secs / 3600) h" }
        if secs > 0, secs % 60 == 0 { return "Every \(secs / 60) min" }
        return "Every \(secs) s"
    }

    /// A value the way the Configuration screen shows it. Unset ≠ empty.
    static func value(_ field: String, _ v: ConfigValue) -> String {
        let text: String? = switch v {
        case let .string(s): s
        case let .number(n): n.rounded() == n ? String(Int(n)) : String(n)
        case .null: nil
        }
        switch field {
        case "auto_wake_interval_secs":
            guard case let .number(n) = v else { return "Off" }
            return interval(Int(n))
        case "autonomy_override":
            guard let text else { return "Inherit project" }
            return ["plan": "Plan", "pr": "PR", "full": "Full"][text] ?? text
        case "reasoning_effort":
            guard let text, !text.isEmpty else { return "Default" }
            return text.prefix(1).uppercased() + text.dropFirst()
        case "model":
            return text ?? "Default"
        case "provider":
            guard let text else { return "Unknown" }
            return ["claude": "Claude", "codex": "Codex"][text] ?? text
        default:
            guard let text, !text.isEmpty else { return "Not set" }
            return text
        }
    }

    /// "prompt, model" — the fields a revision touched, derived ones left out.
    static func changedSummary(_ r: ConfigRevisionDto) -> String {
        r.changes.filter { !$0.derived }.map { fieldLabel($0.field).lowercased() }.joined(separator: ", ")
    }

    static func actorName(_ r: ConfigRevisionDto) -> String {
        if r.kind == "initial" { return "Embodent" }
        return r.actor?.alias ?? "Unattributed"
    }

    /// One sentence per revision, as the web history list reads.
    static func sentence(_ r: ConfigRevisionDto) -> String {
        switch r.kind {
        case "initial": return "Initial configuration captured"
        case "restore": return "\(actorName(r)) restored \(changedSummary(r)) from #\(r.restoredFrom.map(String.init) ?? "?")"
        default: return "\(actorName(r)) changed \(changedSummary(r))"
        }
    }
}
