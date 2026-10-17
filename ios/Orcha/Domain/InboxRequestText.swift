import Foundation

/// Human text vs agent instructions on a request (backend mig 065; web `lib/requestText.ts`).
///
/// `payload` is what a person reads; `agent_payload` is the agent's wake text and is
/// NEVER shown. Rows stored before the split may still carry the combined code-thread
/// text in `payload` — `humanize` strips the agent-only blocks from those.
enum InboxRequestText {

    struct Human: Equatable {
        /// What a person reads as the ask.
        var question: String
        /// A display title when the request has one (code-thread questions).
        var title: String?
        /// Portal deep link to the code thread (`/code?path=…&thread=…`), when known.
        var threadLink: String?
    }

    static func humanize(payload: String, detail: InboxRequestDetailDto?) -> Human {
        let legacy = parseLegacyCodeThread(payload)
        let question = legacy?.question ?? payload
        let stored = detail?.displayTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = (stored?.isEmpty == false) ? stored : nil
        let link = detail?.codeThread?.link ?? legacy?.link
        return Human(question: question, title: title, threadLink: link)
    }

    /// "[code thread — teach] local@8cf5234 path:1-1\n<question>\n\nanswer as a short lesson…\n\nreply via POST …"
    static func parseLegacyCodeThread(_ text: String) -> (question: String, link: String?)? {
        guard text.hasPrefix("[code thread — "), let nl = text.firstIndex(of: "\n") else { return nil }
        let head = text[..<nl]
        guard head.contains("] "), head.contains("@") else { return nil }
        let rest = String(text[text.index(after: nl)...])
        var cuts: [String.Index] = []
        if let g = rest.range(of: "\n\nanswer as a short lesson") { cuts.append(g.lowerBound) }
        if let r = rest.range(of: "\n\nreply via POST /api/code/threads/") { cuts.append(r.lowerBound) }
        let question = (cuts.min().map { String(rest[..<$0]) } ?? rest)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        var link: String?
        if let r = rest.range(of: "view/reply in the portal: ") {
            let tail = rest[r.upperBound...]
            link = tail.prefix { !$0.isWhitespace }.description
            if link?.isEmpty == true { link = nil }
        }
        return (question, link)
    }

    /// The web's auto-resolve wording (RequestsPage timeline), or nil.
    static func autoResolvedCopy(_ code: String?) -> String? {
        guard let code, !code.isEmpty else { return nil }
        return "Resolved automatically — " + (code == "thread_resolved"
            ? "the code thread was resolved"
            : "answered in the code thread")
    }

    /// "Atlas closed it — reason" / "Closed — no further action" (web timeline).
    static func closedCopy(closedBy: String?, reason: String?) -> String {
        let r = reason?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let closedBy, !closedBy.isEmpty {
            return "\(closedBy) closed it" + (r?.isEmpty == false ? " — \(r!)" : "")
        }
        return "Closed" + (r?.isEmpty == false ? " — \(r!)" : " — no further action")
    }
}
