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
    @ViewBuilder var trailing: Trailing

    init(
        _ kind: BubbleKind,
        _ body: String,
        author: String? = nil,
        time: String? = nil,
        @ViewBuilder trailing: () -> Trailing = { EmptyView() }
    ) {
        self.kind = kind
        self.body_ = body
        self.author = author
        self.time = time
        self.trailing = trailing()
    }

    var body: some View {
        switch kind {
        case .system:
            HStack {
                Spacer()
                Text(body_)
                    .font(.system(size: 12))
                    .foregroundStyle(p.muted)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .strokeBorder(p.border2, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
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
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(p.accent)
                    }
                    Text(body_)
                        .font(.system(size: 14.5))
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
                    }
                }
                if !mine { Spacer(minLength: 60) }
            }
        }
    }
}
