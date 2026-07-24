import SwiftUI

// Responsibility: Dashboard statistics, banners, connection chips, and loading placeholders.

struct StatTile: View {
    @Environment(\.palette) private var p
    let value: String
    let label: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.system(size: 20, weight: .heavy))
                .foregroundStyle(tint)
            Text(label.uppercased())
                .font(.system(size: 10.5, weight: .bold))
                .tracking(0.5)
                .foregroundStyle(p.muted)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(p.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

enum BannerKind {
    case warn, danger, info
}

/// `.banner` — inline tinted alert row, optional trailing action.
struct Banner: View {
    @Environment(\.palette) private var p
    let kind: BannerKind
    let text: String
    var action: String?
    var onAction: (() -> Void)?

    private var tint: StatusTint {
        switch kind {
        case .warn: p.tint("warn")
        case .danger: p.tint("danger")
        case .info: p.tint("info")
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            Text(text)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(tint.color)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let action, let onAction {
                Button(action) { onAction() }
                    .buttonStyle(.plain)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(tint.color)
                    .underline()
            }
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 10)
        .background(tint.soft, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(tint.line, lineWidth: 1))
    }
}

/// `.conn` — connection indicator: pulsing dot + word.
struct ConnChip: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let state: String

    var body: some View {
        let (color, word): (Color, String) = switch state.lowercased() {
        case "live", "active": (p.ok, "live")
        case "polling": (p.warn, "polling")
        case "paused": (p.warn, "paused")
        case "unreachable", "off": (p.danger, "unreachable")
        default: (p.idle, state.lowercased())
        }
        HStack(spacing: 6) {
            PulseDot(color: color, animated: !reduceMotion && ["live", "active", "polling"].contains(state.lowercased()))
            Text(word)
                .font(.system(size: 11, weight: .bold))
                .tracking(0.2)
                .foregroundStyle(color)
        }
        .accessibilityElement(children: .combine)
    }
}

/// `.skel` — shimmer-ish loading block.
struct SkeletonBlock: View {
    @Environment(\.palette) private var p
    let height: CGFloat
    @State private var dim = false

    var body: some View {
        RoundedRectangle(cornerRadius: 12)
            .fill(p.surface2)
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border, lineWidth: 1))
            .frame(height: height)
            .opacity(dim ? 0.55 : 1)
            .animation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true), value: dim)
            .onAppear { dim = true }
    }
}

/// `.state` — 72pt glyph tile · 17/750 title · 13.5 sub · actions.
