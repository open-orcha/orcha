import SwiftUI

/// Renders agent-authored chat content as chat-scale markdown (web `mdText`
/// parity): headings, bold/italic, inline code, fenced blocks (mono + horizontal
/// scroll), lists, links, and rules. Task-id references stay tappable (GH #140),
/// external links open in Safari; any other scheme is discarded, mirroring the
/// portal's http(s)-only rule.
struct ChatMarkdownView: View {
    @Environment(\.palette) private var p
    let text: String
    var tasks: [TaskDto] = []
    var onTapTask: ((String) -> Void)?
    /// Portal-link chips (request-screen parity): when set, portal paths and links on the
    /// paired portal (`portalBase`) render as "↗ Open task · …" and call this on tap.
    var portalBase: String? = nil
    var onTapPortal: ((PortalLink) -> Void)? = nil

    var body: some View {
        let blocks = ChatMarkdown.blocks(text)
        VStack(alignment: .leading, spacing: LSpace.s) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            if let link = PortalLinks.link(fromURL: url) {
                onTapPortal?(link)
                return .handled
            }
            if let taskId = MobileUx.taskIdFromLinkURL(url) {
                onTapTask?(taskId)
                return .handled
            }
            // Portal parity: only http(s) links are followable — anything else
            // (javascript:, data:, custom schemes) stays inert text.
            return ["http", "https"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
        })
    }

    @ViewBuilder
    private func blockView(_ block: ChatMarkdown.Block) -> some View {
        switch block {
        case let .heading(level, text):
            Text(styledInline(text))
                .ltype(level <= 2 ? .headline : .bodyEmph)
                .foregroundStyle(p.text)
                .padding(.top, level <= 2 ? 6 : 2)
                .accessibilityAddTraits(.isHeader)
        case let .paragraph(text):
            Text(styledInline(text))
                .ltype(.body)
                .foregroundStyle(p.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        case let .code(code):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .ltype(.mono)
                    .foregroundStyle(p.text2)
                    .textSelection(.enabled)
                    .padding(.horizontal, LSpace.m)
                    .padding(.vertical, 10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(p.surface, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(p.border, lineWidth: 1).allowsHitTesting(false))
        case let .listItem(depth, marker, text):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(marker)
                    .ltype(.body)
                    .foregroundStyle(p.muted)
                Text(styledInline(text))
                    .ltype(.body)
                    .foregroundStyle(p.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.leading, CGFloat(min(depth, 4)) * 14)
        case .rule:
            LDivider()
                .padding(.vertical, 4)
                .accessibilityHidden(true)
        }
    }

    /// Inline markdown + task-ref links, with every link run made visually
    /// distinct (accent + underline) whatever the ambient foreground.
    private func styledInline(_ text: String) -> AttributedString {
        var attr = onTapPortal == nil
            ? ChatMarkdown.inline(text, tasks: tasks)
            : ChatMarkdown.inline(text, tasks: tasks, portalBase: portalBase)
        let linkRanges = attr.runs.filter { $0.link != nil }.map(\.range)
        for range in linkRanges {
            attr[range].underlineStyle = .single
            attr[range].foregroundColor = p.accent
        }
        return attr
    }
}
