import Foundation

/// Portal links in message text → compact chips that open in the app (web
/// `lib/format.ts` `portalPaths` / `portalLinkLabel` parity).
///
/// Two shapes match:
/// - a bare portal path at a word start: `/tasks?task=…`, `/requests?req=…`, `/agents?agent=…`,
///   `/code?path=…&thread=…`, `/github?pr=12` … (never inside a longer path like `/codex`);
/// - an absolute http(s) URL on the PAIRED portal's host (+ port) whose path is one of those.
/// Trailing punctuation stays outside the link.
struct PortalLink: Hashable {
    enum Target: Hashable {
        case task(String)
        case request(String)
        case agent(alias: String)
        case githubPull(Int)
        case githubIssue(Int)
        /// Somewhere the phone has no screen for (Code, Routines…) — opens in the browser.
        case web
    }

    /// Portal-relative path with query, e.g. `/tasks?task=abc`.
    let path: String
    let section: String
    let query: [String: String]

    var target: Target {
        switch section {
        case "tasks": if let t = query["task"], !t.isEmpty { return .task(t) }
        case "requests": if let r = query["req"], !r.isEmpty { return .request(r) }
        case "agents": if let a = query["agent"], !a.isEmpty { return .agent(alias: a) }
        case "github":
            if let pr = query["pr"].flatMap(Int.init) { return .githubPull(pr) }
            if let issue = query["issue"].flatMap(Int.init) { return .githubIssue(issue) }
        default: break
        }
        return .web
    }

    /// What the link opens, in words ("Open thread in Code") — never a raw URL.
    func label(tasks: [TaskDto] = []) -> String {
        switch section {
        case "code":
            if query["thread"] != nil { return "Open thread in Code" }
            if let p = query["path"], !p.isEmpty {
                let trimmed = p.hasSuffix("/") ? String(p.dropLast()) : p
                return "Open \(trimmed.split(separator: "/").last.map(String.init) ?? p) in Code"
            }
            return "Open Code"
        case "tasks":
            if let t = query["task"] {
                if let task = MobileUx.resolveTaskRef(t, in: tasks), !task.title.isEmpty {
                    return "Open task · " + PortalLinks.trunc(task.title, 48)
                }
                return "Open task " + PortalLinks.shortId(t)
            }
        case "requests":
            if let r = query["req"] { return "Open request " + PortalLinks.shortId(r) }
        case "agents":
            if let a = query["agent"] { return "Open agent " + a }
        case "github":
            if let pr = query["pr"] { return "Open PR #" + pr }
            if let issue = query["issue"] { return "Open issue #" + issue }
        default: break
        }
        return "Open " + (PortalLinks.sectionNames[section] ?? section)
    }

    /// Absolute URL on the paired portal (for `.web` targets).
    func absoluteURL(base: String?) -> URL? {
        guard let base, !base.isEmpty else { return nil }
        let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
        return URL(string: trimmed + path)
    }
}

enum PortalLinks {
    static let sectionNames: [String: String] = [
        "code": "Code", "tasks": "Tasks", "requests": "Requests", "agents": "Agents", "needs": "Needs you",
        "activity": "Activity", "routines": "Routines", "github": "GitHub", "metrics": "Metrics",
        "members": "Members", "settings": "Settings",
    ]

    struct Match: Equatable {
        /// The range in the source text (UTF-16, `NSString` semantics) the chip replaces.
        let range: NSRange
        let link: PortalLink
    }

    private static let sectionAlt = "code|tasks|requests|agents|needs|activity|routines|github|metrics|members|settings"

    // Bare path at a word start (web PORTAL_PATH_RE).
    private static let pathRegex = try? NSRegularExpression(
        pattern: "(^|[\\s(])(/(?:\(sectionAlt))(?:\\?[^\\s<]*)?)(?=[\\s<).,;:!?]|$)",
        options: [.anchorsMatchLines]
    )
    private static let urlRegex = try? NSRegularExpression(pattern: "https?://[^\\s<]+", options: [])

    /// Every portal link in `text`, in order, non-overlapping.
    static func matches(in text: String, baseURL: String?) -> [Match] {
        let ns = text as NSString
        let whole = NSRange(location: 0, length: ns.length)
        var out: [Match] = []
        var taken: [NSRange] = []

        // 1. absolute URLs on the paired host
        if let base = baseURL.flatMap(URL.init(string:)), let host = base.host?.lowercased(), let urlRegex {
            for m in urlRegex.matches(in: text, range: whole) {
                var raw = ns.substring(with: m.range)
                var length = m.range.length
                while let last = raw.last, ")].,;:!?".contains(last) {
                    raw.removeLast()
                    length -= 1
                }
                guard let url = URL(string: raw), url.host?.lowercased() == host,
                      (url.port ?? defaultPort(url)) == (base.port ?? defaultPort(base)) else { continue }
                let pathOnly = url.path.isEmpty ? "/" : url.path
                let candidate = pathOnly + (url.query.map { "?" + $0 } ?? "")
                guard let link = parse(candidate) else { continue }
                let r = NSRange(location: m.range.location, length: length)
                out.append(Match(range: r, link: link))
                taken.append(r)
            }
        }

        // 2. bare portal paths (never inside an URL already matched)
        if let pathRegex {
            for m in pathRegex.matches(in: text, range: whole) {
                var r = m.range(at: 2)
                var p = ns.substring(with: r)
                if p.contains("?") {
                    while let last = p.last, ")].,;:!?".contains(last) {
                        p.removeLast()
                        r.length -= 1
                    }
                }
                guard !taken.contains(where: { NSIntersectionRange($0, r).length > 0 }),
                      let link = parse(p) else { continue }
                out.append(Match(range: r, link: link))
            }
        }
        return out.sorted { $0.range.location < $1.range.location }
    }

    /// Unique links in order of appearance, across several texts.
    static func links(in texts: [String], baseURL: String?) -> [PortalLink] {
        var seen = Set<String>()
        var out: [PortalLink] = []
        for text in texts {
            for m in matches(in: text, baseURL: baseURL) where seen.insert(m.link.path).inserted {
                out.append(m.link)
            }
        }
        return out
    }

    /// `/section?query` → a link, when `section` is a portal section (exactly — `/codex` is not).
    static func parse(_ path: String) -> PortalLink? {
        guard path.hasPrefix("/") else { return nil }
        let parts = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let section = String(parts[0].dropFirst())
        guard sectionNames[section] != nil else { return nil }
        var query: [String: String] = [:]
        if parts.count > 1, let items = URLComponents(string: "?" + parts[1])?.queryItems {
            for item in items where query[item.name] == nil { query[item.name] = item.value ?? "" }
        }
        return PortalLink(path: path, section: section, query: query)
    }

    static func shortId(_ id: String) -> String {
        String(id.prefix(8))
    }

    static func trunc(_ s: String, _ n: Int) -> String {
        s.count > n ? String(s.prefix(n - 1)) + "…" : s
    }

    private static func defaultPort(_ url: URL) -> Int {
        url.scheme?.lowercased() == "https" ? 443 : 80
    }

    /// In-app scheme for a portal link inside rendered text (handled, never opened by iOS).
    static let scheme = "orcha-portal"

    static func linkURL(_ link: PortalLink) -> URL? {
        var c = URLComponents()
        c.scheme = scheme
        c.host = "link"
        c.queryItems = [URLQueryItem(name: "p", value: link.path)]
        return c.url
    }

    static func link(fromURL url: URL) -> PortalLink? {
        guard url.scheme == scheme,
              let p = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "p" })?.value
        else { return nil }
        return parse(p)
    }

    /// Replace each portal link in `attr` (built from `text`) with its label as a link run.
    static func rewrite(_ text: String, baseURL: String?, tasks: [TaskDto], base attr: AttributedString) -> AttributedString {
        let found = matches(in: text, baseURL: baseURL)
        guard !found.isEmpty else { return attr }
        var result = attr
        // Walk back to front so earlier ranges stay valid.
        for m in found.reversed() {
            guard let strRange = Range(m.range, in: text) else { continue }
            let lower = text.distance(from: text.startIndex, to: strRange.lowerBound)
            let upper = text.distance(from: text.startIndex, to: strRange.upperBound)
            let chars = result.characters
            guard upper <= chars.count else { continue }
            let a = chars.index(chars.startIndex, offsetBy: lower)
            let b = chars.index(chars.startIndex, offsetBy: upper)
            var run = AttributedString("↗ " + m.link.label(tasks: tasks))
            run.link = linkURL(m.link)
            result.replaceSubrange(a..<b, with: run)
        }
        return result
    }
}
