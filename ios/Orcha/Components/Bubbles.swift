import SwiftUI

enum BubbleKind {
    case mine, theirs, system
}

/// Chat messages (Linear / web live-chat parity):
/// - `mine`   — right-aligned, subtle surface bubble, max ~82% width.
/// - `theirs` — full-width, no bubble: a small author line (round avatar · name · time)
///              over the content (rendered markdown when `markdown` is set).
/// - `system` — a centered muted caption between hairlines (day dividers, notices).
struct Bubble<Trailing: View>: View {
    @Environment(\.palette) private var p
    let kind: BubbleKind
    let body_: String
    var author: String?
    var time: String?
    /// GH #140 — the known task list (for resolving bare task-id refs) + a tap handler.
    /// Left empty/nil for bubbles that don't need linkification (e.g. day dividers).
    var tasks: [TaskDto] = []
    var onTapTask: ((String) -> Void)?
    /// Web parity — agent turn content renders as chat-scale markdown. Only `theirs`
    /// bubbles honor this; mine/system (and pending/failed) stay plain.
    var markdown = false
    /// Portal-link chips: portal links open in the app via this handler (nil = plain text).
    var portalBase: String?
    var onTapPortal: ((PortalLink) -> Void)?
    @ViewBuilder var trailing: Trailing

    init(
        _ kind: BubbleKind,
        _ body: String,
        author: String? = nil,
        time: String? = nil,
        tasks: [TaskDto] = [],
        onTapTask: ((String) -> Void)? = nil,
        markdown: Bool = false,
        portalBase: String? = nil,
        onTapPortal: ((PortalLink) -> Void)? = nil,
        @ViewBuilder trailing: () -> Trailing = { EmptyView() }
    ) {
        self.kind = kind
        self.body_ = body
        self.author = author
        self.time = time
        self.tasks = tasks
        self.onTapTask = onTapTask
        self.markdown = markdown
        self.portalBase = portalBase
        self.onTapPortal = onTapPortal
        self.trailing = trailing()
    }

    var body: some View {
        switch kind {
        case .system:
            HStack(spacing: LSpace.s) {
                LDivider().frame(maxWidth: .infinity)
                messageText
                    .ltype(.micro)
                    .foregroundStyle(p.muted)
                    .multilineTextAlignment(.center)
                    .layoutPriority(1)
                LDivider().frame(maxWidth: .infinity)
            }
            .padding(.vertical, LSpace.xs)
        case .mine:
            HStack {
                Spacer(minLength: 56)
                VStack(alignment: .trailing, spacing: 3) {
                    VStack(alignment: .leading, spacing: 3) {
                        messageText
                            .ltype(.body)
                            .foregroundStyle(p.text)
                        trailing
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(p.surface2, in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(p.border, lineWidth: 1).allowsHitTesting(false))
                    if let time {
                        Text(time)
                            .ltype(.micro)
                            .foregroundStyle(p.faint)
                            .padding(.trailing, 4)
                    }
                }
            }
        case .theirs:
            VStack(alignment: .leading, spacing: 6) {
                if author != nil || time != nil {
                    HStack(spacing: 6) {
                        if let author {
                            LAvatar(name: author, isAI: true, size: 20)
                                .accessibilityHidden(true)
                            Text(author)
                                .ltype(.bodyEmph)
                                .foregroundStyle(p.text)
                        }
                        if let time {
                            Text(time)
                                .ltype(.micro)
                                .foregroundStyle(p.faint)
                        }
                    }
                }
                Group {
                    if markdown {
                        ChatMarkdownView(text: body_, tasks: tasks, onTapTask: onTapTask, portalBase: portalBase, onTapPortal: onTapPortal)
                    } else {
                        messageText
                    }
                }
                .ltype(.body)
                .foregroundStyle(p.text)
                trailing
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private var messageText: some View {
        if let onTapTask {
            LinkedMessageText(text: body_, tasks: tasks, onTapTask: onTapTask, portalBase: portalBase, onTapPortal: onTapPortal)
        } else {
            Text(body_)
        }
    }
}
