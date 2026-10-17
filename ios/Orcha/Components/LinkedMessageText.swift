import SwiftUI

/// GH #140 — renders a request/conversation/task-thread message body with bare task-id
/// references made tappable. Resolved links render bold + underlined (visually distinct
/// regardless of the ambient `.foregroundStyle`, so it stays readable on a "mine" bubble's
/// accent fill too); tapping one calls `onTapTask` instead of following the in-app-only
/// `orcha-task:` URL. Any other scheme (e.g. a real http(s) URL an author pasted) falls
/// through to the system handler.
struct LinkedMessageText: View {
    @Environment(\.palette) private var p
    let text: String
    let tasks: [TaskDto]
    var onTapTask: (String) -> Void
    /// Portal-link chips (web `portalPaths`): when set, bare portal paths and links on the
    /// paired portal (`portalBase`) render as their label ("Open task · …") and call this.
    var portalBase: String? = nil
    var onTapPortal: ((PortalLink) -> Void)? = nil

    private var attributed: AttributedString {
        var attr = MobileUx.linkifyTaskRefs(text, tasks: tasks)
        if onTapPortal != nil {
            attr = PortalLinks.rewrite(text, baseURL: portalBase, tasks: tasks, base: attr)
        }
        let linkRanges = attr.runs.filter { $0.link != nil }.map(\.range)
        for range in linkRanges {
            attr[range].underlineStyle = .single
            attr[range].inlinePresentationIntent = .stronglyEmphasized
            attr[range].foregroundColor = p.accent
        }
        return attr
    }

    var body: some View {
        Text(attributed)
            .environment(\.openURL, OpenURLAction { url in
                if let link = PortalLinks.link(fromURL: url) {
                    onTapPortal?(link)
                    return .handled
                }
                guard let taskId = MobileUx.taskIdFromLinkURL(url) else { return .systemAction }
                onTapTask(taskId)
                return .handled
            })
    }
}
