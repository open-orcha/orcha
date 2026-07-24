import SwiftUI

// Responsibility: Core Orcha cards, section headings, metadata tags, and buttons.

// The Orcha mobile component kit — one view per row of the component inventory
// (doc 12), pixel values from mockups/mobile.css. Screens never restyle these.

/// `.card` — surface, hairline border, radius 12, padding 14.
struct OrchaCard<Content: View>: View {
    @Environment(\.palette) private var p
    var borderColor: Color?
    var container: Color?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(container ?? p.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(borderColor ?? p.border, lineWidth: 1))
    }
}

/// `.section-h` — 11/700 +.8 uppercase kicker with faint count.
struct SectionH: View {
    @Environment(\.palette) private var p
    let title: String
    var count: String?

    var body: some View {
        HStack(spacing: 8) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(p.muted)
            if let count {
                Text(count)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(p.faint)
            }
            Spacer()
        }
        .padding(.top, 6)
        .accessibilityAddTraits(.isHeader)
    }
}

/// `.tag` / `.tag.model` — bordered 10.5 meta chip; mono for model ids.
struct MetaTag: View {
    @Environment(\.palette) private var p
    let text: String
    var mono = false
    var tint: Color?

    var body: some View {
        Text(text)
            .font(mono ? .system(size: 10.5, design: .monospaced) : .system(size: 10.5, weight: .medium))
            .foregroundStyle(tint ?? p.muted)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .overlay(
                RoundedRectangle(cornerRadius: 5)
                    .strokeBorder((tint ?? p.border2).opacity(tint == nil ? 1 : 0.4), lineWidth: 1)
            )
            .lineLimit(1)
    }
}

enum KitButtonRole {
    case primary, tonal, okTonal, dangerTonal, neutral
}

/// `.btn` family — 15/700, radius 12, tonal fills with line borders.
struct KitButton: View {
    @Environment(\.palette) private var p
    let title: String
    var role: KitButtonRole = .primary
    var small = false
    var enabled = true
    var systemImage: String?
    let action: () -> Void

    private var colors: (fill: Color, fg: Color, line: Color?) {
        switch role {
        case .primary: (p.accent, p.accentInk, nil)
        case .tonal: (p.accentSoft, p.accent, p.accentLine)
        case .okTonal: (p.okSoft, p.ok, p.okLine)
        case .dangerTonal: (p.dangerSoft, p.danger, p.dangerLine)
        case .neutral: (p.surface2, p.text, p.border2)
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: small ? 13 : 15, weight: .semibold))
                }
                Text(title)
                    .font(.system(size: small ? 13 : 15, weight: .bold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, small ? 8 : 12)
            .padding(.horizontal, small ? 14 : 18)
        }
        .buttonStyle(.plain)
        .foregroundStyle(colors.fg)
        .background(colors.fill, in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            if let line = colors.line {
                RoundedRectangle(cornerRadius: 12).strokeBorder(line, lineWidth: 1)
            }
        }
        .opacity(enabled ? 1 : 0.45)
        .disabled(!enabled)
    }
}

/// `.avatar` — square agent tile / round human dot with the initial.
