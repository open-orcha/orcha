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

    var body: some View {
        let blocks = ChatMarkdown.blocks(text)
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .environment(\.openURL, OpenURLAction { url in
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
                .font(p.uiFont(headingSize(level), level <= 2 ? .bold : .semibold))
                .foregroundStyle(p.text)
                .padding(.top, 2)
                .accessibilityAddTraits(.isHeader)
        case let .paragraph(text):
            Text(styledInline(text))
                .font(p.uiFont(14.5))
                .foregroundStyle(p.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        case let .code(code):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(p.text2)
                    .textSelection(.enabled)
                    .padding(10)
            }
            .background(p.surface3, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(p.border, lineWidth: 1))
        case let .listItem(depth, marker, text):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(marker)
                    .font(p.uiFont(14.5, .semibold))
                    .foregroundStyle(p.muted)
                Text(styledInline(text))
                    .font(p.uiFont(14.5))
                    .foregroundStyle(p.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.leading, CGFloat(min(depth, 4)) * 14)
        case .rule:
            Rectangle()
                .fill(p.border2)
                .frame(height: 1)
                .padding(.vertical, 2)
                .accessibilityHidden(true)
        }
    }

    /// Chat-scale heading sizes over the 14.5 body (h5/h6 already clamp to 4).
    private func headingSize(_ level: Int) -> CGFloat {
        switch level {
        case 1: 18
        case 2: 16.5
        case 3: 15.5
        default: 14.5
        }
    }

    /// Inline markdown + task-ref links, with every link run made visually
    /// distinct (accent + underline) whatever the ambient foreground.
    private func styledInline(_ text: String) -> AttributedString {
        var attr = ChatMarkdown.inline(text, tasks: tasks)
        let linkRanges = attr.runs.filter { $0.link != nil }.map(\.range)
        for range in linkRanges {
            attr[range].underlineStyle = .single
            attr[range].foregroundColor = p.accent
        }
        return attr
    }
}
