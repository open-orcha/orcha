import SwiftUI

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
struct AgentAvatar: View {
    @Environment(\.palette) private var p
    let alias: String
    var human = false
    var size: CGFloat = 40

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: human ? size / 2 : size * 12 / 40)
        Text(alias.prefix(1).uppercased())
            .font(.system(size: size * 15 / 40, weight: .heavy))
            .foregroundStyle(human ? p.violet : p.accent)
            .frame(width: size, height: size)
            .background(human ? p.violetSoft : p.accentSoft, in: shape)
            .overlay(shape.strokeBorder(human ? p.violetLine : p.accentLine, lineWidth: 1))
            .accessibilityLabel(alias)
    }
}

/// `.brandmark` — the orca glyph on the radial brand tile (foundations §5).
struct BrandMark: View {
    var size: CGFloat = 34

    var body: some View {
        OrcaGlyph()
            .frame(width: size * 0.7, height: size * 0.7)
            .frame(width: size, height: size)
            .background(
                RadialGradient(
                    colors: [Color(hex: 0x0E2D33), Color(hex: 0x06171C)],
                    center: .init(x: 0.5, y: 0.3), startRadius: 0, endRadius: size * 1.2
                ),
                in: RoundedRectangle(cornerRadius: size * 10 / 34)
            )
            .accessibilityLabel("Orcha")
    }
}

/// The orca/orchestration glyph from desktop/resources/icon.svg (native 0..100 space).
struct OrcaGlyph: View {
    var body: some View {
        Canvas { context, canvasSize in
            let s = min(canvasSize.width, canvasSize.height) / 100
            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * s, y: y * s) }

            var body = Path()
            body.move(to: pt(27, 83))
            body.addCurve(to: pt(45.5, 22.5), control1: pt(28, 55), control2: pt(33, 32))
            body.addCurve(to: pt(60, 27), control1: pt(51.5, 18), control2: pt(57.5, 19.5))
            body.addCurve(to: pt(73, 83), control1: pt(64.5, 46), control2: pt(70.5, 67))
            body.closeSubpath()
            context.fill(body, with: .color(Color(hex: 0xF3FBFB)))

            var strings = Path()
            strings.move(to: pt(49, 38)); strings.addLine(to: pt(40, 62))
            strings.move(to: pt(49, 38)); strings.addLine(to: pt(56, 62))
            strings.move(to: pt(49, 38)); strings.addLine(to: pt(50, 74))
            context.stroke(strings, with: .color(Color(hex: 0x06171C)), style: StrokeStyle(lineWidth: 2.4 * s, lineCap: .round))

            for (cx, cy) in [(39.0, 64.0), (57.0, 64.0), (50.0, 76.0)] {
                let dot = Path(ellipseIn: CGRect(x: (cx - 4) * s, y: (cy - 4) * s, width: 8 * s, height: 8 * s))
                context.fill(dot, with: .color(Color(hex: 0x06171C)))
            }
            let head = Path(ellipseIn: CGRect(x: 43 * s, y: 29 * s, width: 12 * s, height: 12 * s))
            context.fill(head, with: .color(Color(hex: 0x1FC7CD)))

            var wave = Path()
            wave.move(to: pt(13, 86))
            wave.addCurve(to: pt(50, 82.5), control1: pt(28, 82), control2: pt(38, 82))
            wave.addCurve(to: pt(87, 86), control1: pt(62, 82), control2: pt(72, 82))
            context.stroke(wave, with: .color(Color(hex: 0x1FC7CD)), style: StrokeStyle(lineWidth: 5 * s, lineCap: .round))
        }
    }
}

/// `.stat` — KPI tile: 20/800 colored numeral + 10.5/700 uppercase key.
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
struct StateLayout<Glyph: View, Actions: View>: View {
    @Environment(\.palette) private var p
    let title: String
    var sub: String?
    var danger = false
    @ViewBuilder let glyph: Glyph
    @ViewBuilder let actions: Actions

    var body: some View {
        VStack(spacing: 12) {
            glyph
                .frame(width: 72, height: 72)
                .background(danger ? p.dangerSoft : p.surface2, in: RoundedRectangle(cornerRadius: 22))
                .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(danger ? p.dangerLine : p.border, lineWidth: 1))
            Text(title)
                .font(.system(size: 17, weight: .bold))
                .multilineTextAlignment(.center)
            if let sub {
                Text(sub)
                    .font(.system(size: 13.5))
                    .foregroundStyle(p.muted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 290)
            }
            actions
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 36)
    }
}

/// `.kv` — key/value detail row.
struct KVRow: View {
    @Environment(\.palette) private var p
    let key: String
    let value: String
    var mono = false

    var body: some View {
        HStack(spacing: 12) {
            Text(key)
                .font(.system(size: 13.5))
                .foregroundStyle(p.muted)
            Spacer()
            Text(value)
                .font(mono ? .system(size: 12, design: .monospaced) : .system(size: 13.5))
                .foregroundStyle(p.text)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

/// `.log` line — 11.5 mono, color-keyed by line kind (flow 06).
struct LogLine: View {
    @Environment(\.palette) private var p
    let line: String

    private var color: Color {
        let l = line.lowercased()
        if l.contains("error") || l.contains("failed") || l.contains("traceback") { return p.danger }
        if l.contains("warn") { return p.warn }
        if l.contains("tool") || l.hasPrefix("run ") { return p.accent }
        if l.contains("done") || l.contains("complete") || l.contains("finished") { return p.ok }
        if l.hasPrefix("[") || l.hasPrefix("--") { return p.faint }
        return p.text2
    }

    var body: some View {
        Text(line)
            .font(.system(size: 11.5, design: .monospaced))
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
