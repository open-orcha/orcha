import Foundation

/// Turns raw backend activity text (decision markers, verification markers, snake_case
/// event kinds) into friendly, sentence-case copy for user-facing feeds. Pure: no I/O.
enum ActivityCopy {
    static func humanize(_ raw: String) -> String {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return text }

        // [DECISION · plan_approval = APPROVED by alice] — reason
        if let decision = parseDecision(text) { return decision }

        // [verification rejected] note / [verification approved] note
        if let (verb, rest) = parseBracketPrefix(text) {
            switch verb.lowercased() {
            case "verification rejected":
                return join("Rejected verification", rest)
            case "verification approved":
                return join("Verified", rest)
            default:
                break
            }
        }

        // Bare event kind like task_assigned / conversation_turn / "task assigned".
        if isEventKind(text) { return sentenceCase(text.replacingOccurrences(of: "_", with: " ")) }

        return text
    }

    // MARK: - helpers

    private static func parseDecision(_ text: String) -> String? {
        guard let (inside, rest) = parseBracketPrefix(text),
              inside.uppercased().hasPrefix("DECISION") else { return nil }
        // inside: "DECISION · plan_approval = APPROVED by alice"
        guard let eq = inside.firstIndex(of: "=") else { return nil }
        let left = inside[..<eq]
        let subject = left
            .replacingOccurrences(of: "DECISION", with: "", options: .caseInsensitive)
            .replacingOccurrences(of: "·", with: "")
            .trimmingCharacters(in: .whitespaces)
        let rhs = inside[inside.index(after: eq)...].trimmingCharacters(in: .whitespaces)
        let outcome = (rhs.split(separator: " ").first.map(String.init) ?? "").uppercased()

        let noun: String
        switch subject.lowercased() {
        case "plan_approval", "plan": noun = "the plan"
        case "verification", "verify": noun = "verification"
        default: noun = subject.replacingOccurrences(of: "_", with: " ").lowercased()
        }
        let verb: String
        switch outcome {
        case "APPROVED", "APPROVE": verb = "Approved"
        case "REJECTED", "REJECT": verb = "Rejected"
        default: verb = sentenceCase(outcome.lowercased())
        }
        return join(noun.isEmpty ? verb : "\(verb) \(noun)", rest)
    }

    /// Splits "[inside] rest" → (inside, rest without leading dash separators).
    private static func parseBracketPrefix(_ text: String) -> (String, String)? {
        guard text.hasPrefix("["), let close = text.firstIndex(of: "]") else { return nil }
        let inside = text[text.index(after: text.startIndex)..<close].trimmingCharacters(in: .whitespaces)
        var rest = text[text.index(after: close)...].trimmingCharacters(in: .whitespacesAndNewlines)
        while let first = rest.first, "—–-:".contains(first) {
            rest = String(rest.dropFirst()).trimmingCharacters(in: .whitespaces)
        }
        return (inside, rest)
    }

    private static func join(_ head: String, _ rest: String) -> String {
        rest.isEmpty ? head : "\(head) — \(rest)"
    }

    /// A short all-lowercase label ("task_assigned", "task assigned") — an event kind,
    /// not prose. Capped at four words so ordinary lowercase chat is left untouched.
    private static func isEventKind(_ text: String) -> Bool {
        text.allSatisfy { $0.isLowercase || $0.isNumber || $0 == "_" || $0 == " " }
            && text.split(whereSeparator: { $0 == "_" || $0 == " " }).count <= 4
            && (text.contains("_") || text.contains(" "))
    }

    static func sentenceCase(_ text: String) -> String {
        guard let first = text.first else { return text }
        return first.uppercased() + text.dropFirst()
    }

    /// One-line feed preview: humanized, markdown markers (`##`, backticks, `**`) dropped,
    /// lines joined — so a plan reads "Plan 1. Add POST /webhooks/stripe…" not "## Plan".
    static func preview(_ raw: String) -> String {
        let text = humanize(raw)
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true).map { line -> String in
            var l = line.trimmingCharacters(in: .whitespaces)
            while l.hasPrefix("#") { l.removeFirst() }
            return l.trimmingCharacters(in: .whitespaces)
        }
        return lines.joined(separator: " ")
            .replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "`", with: "")
    }
}
