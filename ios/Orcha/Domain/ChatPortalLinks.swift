import Foundation

/// Portal links inside chat markdown (agent turns, task-thread messages): the same chips
/// the request screens show (`PortalLinks.rewrite`), applied to the already-parsed inline
/// markdown so bold / code / [links](…) survive.
extension ChatMarkdown {

    /// Inline markdown → portal links rewritten to in-app chips → bare task ids linked.
    /// Portal links go first so a task id inside `/tasks?task=…` stays part of its chip.
    static func inline(_ text: String, tasks: [TaskDto], portalBase: String?) -> AttributedString {
        linkifyTaskRefs(rewritePortalLinks(inline(text), portalBase: portalBase, tasks: tasks), tasks: tasks)
    }

    /// - markdown links whose target is a portal path (or a URL on the paired portal) keep
    ///   their label but point at the in-app scheme;
    /// - bare portal paths / portal URLs in plain text become "↗ Open task · …" link runs.
    /// Inline-code runs are never touched.
    static func rewritePortalLinks(_ attr: AttributedString, portalBase: String?, tasks: [TaskDto]) -> AttributedString {
        var result = attr

        // 1. existing link runs → in-app when they point at the portal (attributes only,
        //    so indices stay valid).
        //    An autolinked bare URL (label == the URL itself) also gets the chip label.
        let linkRuns = result.runs.compactMap { run in run.link.map { (run.range, $0) } }
        var relabel: [(offset: Int, length: Int, link: PortalLink)] = []
        for (range, url) in linkRuns {
            guard let link = portalLink(for: url, portalBase: portalBase), let inApp = PortalLinks.linkURL(link) else { continue }
            result[range].link = inApp
            let label = String(result.characters[range])
            if label == url.absoluteString || label == link.path {
                relabel.append((
                    result.characters.distance(from: result.startIndex, to: range.lowerBound),
                    label.count, link
                ))
            }
        }
        for r in relabel.reversed() {
            let a = result.characters.index(result.startIndex, offsetBy: r.offset)
            let b = result.characters.index(a, offsetBy: r.length)
            var run = AttributedString("↗ " + r.link.label(tasks: tasks))
            run.link = PortalLinks.linkURL(r.link)
            result.replaceSubrange(a..<b, with: run)
        }

        // 2. plain-text portal links. Offsets are in Characters of the parsed text.
        let plain = String(result.characters)
        let found = PortalLinks.matches(in: plain, baseURL: portalBase)
        guard !found.isEmpty else { return result }

        var protected: [Range<Int>] = []
        for run in result.runs {
            let isCode = run.inlinePresentationIntent?.contains(.code) ?? false
            guard run.link != nil || isCode else { continue }
            let lo = result.characters.distance(from: result.startIndex, to: run.range.lowerBound)
            let hi = result.characters.distance(from: result.startIndex, to: run.range.upperBound)
            protected.append(lo..<hi)
        }

        var spans: [(range: Range<Int>, link: PortalLink)] = []
        for m in found {
            guard let r = Range(m.range, in: plain) else { continue }
            let lo = plain.distance(from: plain.startIndex, to: r.lowerBound)
            let hi = plain.distance(from: plain.startIndex, to: r.upperBound)
            let span = lo..<hi
            guard !protected.contains(where: { $0.overlaps(span) }) else { continue }
            spans.append((span, m.link))
        }
        // Back to front so earlier offsets stay valid.
        for span in spans.reversed() {
            let chars = result.characters
            guard span.range.upperBound <= chars.count else { continue }
            let a = chars.index(chars.startIndex, offsetBy: span.range.lowerBound)
            let b = chars.index(chars.startIndex, offsetBy: span.range.upperBound)
            var run = AttributedString("↗ " + span.link.label(tasks: tasks))
            run.link = PortalLinks.linkURL(span.link)
            result.replaceSubrange(a..<b, with: run)
        }
        return result
    }

    /// A markdown link target that is a portal path (`/tasks?task=…`) or a URL on the
    /// paired portal — the whole target, never a prefix.
    static func portalLink(for url: URL, portalBase: String?) -> PortalLink? {
        let s = url.absoluteString
        guard let m = PortalLinks.matches(in: s, baseURL: portalBase).first,
              m.range.location == 0, m.range.length == (s as NSString).length else { return nil }
        return m.link
    }
}

/// Where a tapped portal link goes: an in-app screen, or the browser.
enum PortalLinkRouting {
    enum Destination: Equatable {
        case route(WorkspaceRoute)
        case browser(URL)
        case none
    }

    static func resolve(
        _ link: PortalLink,
        tasks: [TaskDto],
        requestIds: [String],
        agents: [(id: String, alias: String)],
        portalBase: String?
    ) -> Destination {
        let web: Destination = link.absoluteURL(base: portalBase).map(Destination.browser) ?? .none
        switch link.target {
        case let .task(id):
            return .route(.task(MobileUx.resolveTaskRef(id, in: tasks)?.id ?? id))
        case let .request(id):
            let match = requestIds.first { $0 == id } ?? requestIds.first { $0.hasPrefix(id) }
            return .route(.request(match ?? id))
        case let .agent(alias):
            if let agent = agents.first(where: { $0.alias == alias }) { return .route(.agent(agent.id)) }
            return web
        case let .githubPull(n): return .route(.githubPull(n))
        case let .githubIssue(n): return .route(.githubIssue(n))
        case .web: return web
        }
    }
}
