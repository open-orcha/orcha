import SwiftUI

/// The request's links as compact chips (web portal-link chips): portal links name where
/// they go ("Open task · Fix login") and open in the app; any other http(s) link opens in
/// the browser, labelled by host + short path.
struct RequestLinkChips: View {
    @Environment(\.openURL) private var openURL
    let portalLinks: [PortalLink]
    let externalTexts: [String]
    var portalBase: String?
    var tasks: [TaskDto] = []
    let onTap: (PortalLink) -> Void

    /// http(s) links that are NOT on the paired portal.
    private var externalURLs: [URL] {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return [] }
        let portalHost = portalBase.flatMap(URL.init(string:))?.host?.lowercased()
        var seen = Set<String>()
        var out: [URL] = []
        for text in externalTexts {
            let range = NSRange(text.startIndex..., in: text)
            for match in detector.matches(in: text, range: range) {
                guard let url = match.url, ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                      seen.insert(url.absoluteString).inserted else { continue }
                if let portalHost, url.host?.lowercased() == portalHost,
                   PortalLinks.matches(in: url.absoluteString, baseURL: portalBase).isEmpty == false { continue }
                out.append(url)
            }
        }
        return out
    }

    private func label(_ url: URL) -> String {
        let host = url.host() ?? url.absoluteString
        let path = url.path()
        return path.isEmpty || path == "/" ? host : "\(host)\(path.count > 24 ? String(path.prefix(24)) + "…" : path)"
    }

    var body: some View {
        let external = externalURLs
        if !portalLinks.isEmpty || !external.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: LSpace.s) {
                    ForEach(portalLinks, id: \.path) { link in
                        let text = link.label(tasks: tasks)
                        LChip(text, icon: "arrow.up.right") { onTap(link) }
                            .accessibilityLabel(text)
                            .accessibilityAddTraits(.isLink)
                    }
                    ForEach(external, id: \.absoluteString) { url in
                        LChip(label(url), icon: "link") { openURL(url) }
                            .accessibilityLabel("Open link \(url.host() ?? "")")
                            .accessibilityAddTraits(.isLink)
                    }
                }
            }
        }
    }
}
