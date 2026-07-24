import Foundation

// Responsibility: Task-reference detection, resolution, deep links, and attributed rendering.

extension MobileUx {
    // MARK: GH #140 — bare task-id links in request/conversation/thread message bodies
    //
    // The backend emits NO markdown/scheme for task references — confirmed against the web
    // portal's own convention (ISS-82/GH #223, `orcha-cli/.../static/app.js` `taskRefs`):
    // a message body simply carries a raw task id (full UUID or a short hex prefix, however
    // an author happened to type it), and the CLIENT resolves it against the known task list.
    // Exact full-id match wins; else a UNIQUE 8+ hex-char prefix; ambiguous/absent → nil
    // (never guessed) — same rule as the web's `taskByRef`.
    private static let taskRefPattern = try! NSRegularExpression(
        pattern: #"\b[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?\b"#
    )

    static func resolveTaskRef(_ token: String, in tasks: [TaskDto]) -> TaskDto? {
        let tok = token.lowercased()
        if let exact = tasks.first(where: { $0.id.lowercased() == tok }) { return exact }
        guard tok.count >= 8, tok.count < 36 else { return nil }
        var hit: TaskDto?
        for t in tasks where t.id.lowercased().hasPrefix(tok) {
            if hit != nil { return nil }
            hit = t
        }
        return hit
    }

    /// `orcha-task:///<id>` is an in-app-only marker — never sent over the wire — used to
    /// carry a resolved task id through `AttributedString.link`/`Text` to an `openURL` handler.
    static func taskLinkURL(_ taskId: String) -> URL? {
        URL(string: "orcha-task:///\(taskId)")
    }

    static func taskIdFromLinkURL(_ url: URL) -> String? {
        guard url.scheme == "orcha-task" else { return nil }
        let id = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return id.isEmpty ? nil : id
    }

    /// Rewrites bare task-id tokens in `body` that resolve to a real task into `.link`-tagged
    /// runs (see `taskLinkURL`); every other token passes through as plain text.
    static func linkifyTaskRefs(_ body: String, tasks: [TaskDto]) -> AttributedString {
        guard !tasks.isEmpty else { return AttributedString(body) }
        let ns = body as NSString
        let matches = taskRefPattern.matches(in: body, range: NSRange(location: 0, length: ns.length))
        guard !matches.isEmpty else { return AttributedString(body) }
        var result = AttributedString()
        var last = 0
        for m in matches {
            if m.range.location > last {
                result += AttributedString(ns.substring(with: NSRange(location: last, length: m.range.location - last)))
            }
            let token = ns.substring(with: m.range)
            if let task = resolveTaskRef(token, in: tasks), let url = taskLinkURL(task.id) {
                var run = AttributedString(token)
                run.link = url
                result += run
            } else {
                result += AttributedString(token)
            }
            last = m.range.location + m.range.length
        }
        if last < ns.length {
            result += AttributedString(ns.substring(from: last))
        }
        return result
    }
}
