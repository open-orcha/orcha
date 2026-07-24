import SwiftUI

enum BubbleKind {
    case mine, theirs, system
}

/// `.bubble` — chat bubbles: radius 16 / tail 6, max 82% width; mine = accent fill,
/// theirs = surface-2 + border with accent author label, system = centered dashed.
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
    @ViewBuilder var trailing: Trailing

    init(
        _ kind: BubbleKind,
        _ body: String,
        author: String? = nil,
        time: String? = nil,
        tasks: [TaskDto] = [],
        onTapTask: ((String) -> Void)? = nil,
        @ViewBuilder trailing: () -> Trailing = { EmptyView() }
    ) {
        self.kind = kind
        self.body_ = body
        self.author = author
        self.time = time
        self.tasks = tasks
        self.onTapTask = onTapTask
        self.trailing = trailing()
    }

    var body: some View {
        switch kind {
        case .system:
            HStack {
                Spacer()
                Group {
                    if let onTapTask {
                        LinkedMessageText(text: body_, tasks: tasks, onTapTask: onTapTask)
                    } else {
                        Text(body_)
                    }
                }
                .font(p.uiFont(12))
                .foregroundStyle(p.muted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(p.border2, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                        .allowsHitTesting(false)
                )
                Spacer()
            }
        case .mine, .theirs:
            let mine = kind == .mine
            let shape = UnevenRoundedRectangle(
                topLeadingRadius: 16,
                bottomLeadingRadius: mine ? 16 : 6,
                bottomTrailingRadius: mine ? 6 : 16,
                topTrailingRadius: 16
            )
            HStack {
                if mine { Spacer(minLength: 60) }
                VStack(alignment: .leading, spacing: 3) {
                    if !mine, let author {
                        Text(author)
                            .font(p.uiFont(11, .bold))
                            .foregroundStyle(p.accent)
                    }
                    Group {
                        if let onTapTask {
                            LinkedMessageText(text: body_, tasks: tasks, onTapTask: onTapTask)
                        } else {
                            Text(body_)
                        }
                    }
                    .font(p.uiFont(14.5))
                    .foregroundStyle(mine ? p.accentInk : p.text)
                    if let time {
                        Text(time)
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(mine ? p.accentInk.opacity(0.55) : p.faint)
                    }
                    trailing
                }
                .padding(.horizontal, 13)
                .padding(.vertical, 10)
                .background(mine ? AnyShapeStyle(p.accent) : AnyShapeStyle(p.surface2), in: shape)
                .overlay {
                    if !mine {
                        shape.strokeBorder(p.border, lineWidth: 1)
                            .allowsHitTesting(false)
                    }
                }
                if !mine { Spacer(minLength: 60) }
            }
        }
    }
}
