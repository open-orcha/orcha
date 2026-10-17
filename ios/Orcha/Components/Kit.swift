import SwiftUI

// The Orcha mobile component kit — one view per row of the component inventory
// (doc 12), pixel values from mockups/mobile.css. Screens never restyle these.

/// `.card` — Linear panel surface: hairline border, skin radius (10 on Linear), padding 14.
struct OrchaCard<Content: View>: View {
    @Environment(\.palette) private var p
    var borderColor: Color?
    var container: Color?
    @ViewBuilder let content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: p.radiusCard, style: .continuous)
        VStack(alignment: .leading, spacing: 8) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(container ?? p.surface, in: shape)
        .overlay(shape.strokeBorder(borderColor ?? p.border, lineWidth: 1))
    }
}

/// Section header — Linear muted caption (13/medium, sentence case) with a
/// quiet count. Swiss keeps its mono-uppercase kicker.
struct SectionH: View {
    @Environment(\.palette) private var p
    let title: String
    var count: String?

    var body: some View {
        HStack(spacing: 6) {
            Text(p.pillMono ? title.uppercased() : title)
                .font(p.pillMono ? p.uiFont(11, .bold) : p.uiFont(13, .medium))
                .tracking(p.pillMono ? 0.8 : -0.05)
                .foregroundStyle(p.text2)
            if let count {
                Text(count)
                    .font(p.uiFont(13))
                    .monospacedDigit()
                    .foregroundStyle(p.muted)
            }
            Spacer()
        }
        .padding(.top, 8)
        .padding(.horizontal, 2)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// `.tag` — compact neutral tag (Linear): faint fill, hairline, radius 5; mono for model ids.
struct MetaTag: View {
    @Environment(\.palette) private var p
    let text: String
    var mono = false
    var tint: Color?
    /// A model id / runtime: shows its provider mark (Claude / OpenAI) before the text.
    var markModel: String?

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: p.radiusTag, style: .continuous)
        HStack(spacing: 4) {
            if let tint {
                Circle().fill(tint).frame(width: 6, height: 6).accessibilityHidden(true)
            }
            ModelProviderMark(model: markModel, size: 11)
            Text(text)
                .font(mono ? .system(size: 11, design: .monospaced) : p.uiFont(11, .medium))
                .foregroundStyle(p.text2)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(p.surface2, in: shape)
        .overlay(shape.strokeBorder(p.border, lineWidth: 1))
        .lineLimit(1)
    }
}

enum KitButtonRole {
    case primary, tonal, okTonal, dangerTonal, neutral
}

/// `.btn` family — Linear: compact 14/medium (13 small), skin radius (7 on
/// Linear), one flat indigo primary; tonal roles become quiet secondary
/// buttons with a semantic label colour instead of loud tinted fills.
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
        case .primary: (p.lPrimaryFill, p.lPrimaryText, nil)
        case .tonal: (p.surface2, p.accent, p.border2)
        case .okTonal: (p.surface2, p.ok, p.border2)
        case .dangerTonal: (p.dangerSoft, p.danger, p.dangerLine)
        case .neutral: (p.surface2, p.text, p.border2)
        }
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: p.radiusButton, style: .continuous)
        Button(action: action) {
            HStack(spacing: 6) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: small ? 12 : 13, weight: .semibold))
                        .accessibilityHidden(true)
                }
                Text(title)
                    .font(p.uiFont(small ? 13 : 14, .medium))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, small ? 7 : 10)
            .padding(.horizontal, small ? 12 : 16)
            .contentShape(shape)
        }
        .buttonStyle(KitButtonPressStyle(colors: colors, radius: p.radiusButton))
        .opacity(enabled ? 1 : 0.45)
        .disabled(!enabled)
    }
}

/// Flat Linear surface with a subtle pressed state (no glass, no glow).
private struct KitButtonPressStyle: ButtonStyle {
    let colors: (fill: Color, fg: Color, line: Color?)
    let radius: CGFloat

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        configuration.label
            .foregroundStyle(colors.fg)
            .background(colors.fill, in: shape)
            .overlay {
                if let line = colors.line {
                    shape.strokeBorder(line, lineWidth: 1)
                }
            }
            .overlay(shape.fill(Color.primary.opacity(configuration.isPressed ? 0.08 : 0)))
    }
}

/// `.avatar` — Linear round avatar (deterministic hue, ✦ badge for agents).
/// Collab v1: a human with a `githubLogin` renders their real GitHub avatar
/// over the letter circle — the circle stays visible while loading and when
/// the image fails (offline / no avatar), so the fallback is structural.
struct AgentAvatar: View {
    let alias: String
    var human = false
    var githubLogin: String? = nil
    var size: CGFloat = 40

    var body: some View {
        LAvatar(name: alias, isAI: !human, size: size)
            .overlay {
                if human, let url = MobileUx.githubAvatarURL(githubLogin) {
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Color.clear   // letter circle shows through until (unless) the face loads
                    }
                    .frame(width: size, height: size)
                    .clipShape(Circle())
                    .accessibilityHidden(true)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(githubLogin ?? alias)
    }
}

/// `.brandmark` — the Embodent mark (vector `EmbodentMark` asset) on its dark
/// `#121314` rounded tile. The tile is always dark so the mark's light half
/// stays legible on light backgrounds too.
struct BrandMark: View {
    var size: CGFloat = 34

    var body: some View {
        Image("EmbodentMark")
            .resizable()
            .scaledToFit()
            .frame(width: size * 0.82, height: size * 0.82)
            .frame(width: size, height: size)
            .background(Color(hex: 0x121314), in: .rect(cornerRadius: size * 10 / 34))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Embodent")
    }
}

/// `.stat` — KPI tile, Linear: neutral 20/semibold numeral, muted label with a
/// small semantic dot (colour is never the only signal — the label carries it).
struct StatTile: View {
    @Environment(\.palette) private var p
    let value: String
    let label: String
    let tint: Color

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: p.radiusCard, style: .continuous)
        VStack(alignment: .leading, spacing: 4) {
            Text(value)
                .font(p.uiFont(20, .semibold))
                .monospacedDigit()
                .foregroundStyle(p.text)
            HStack(spacing: 5) {
                Circle().fill(tint).frame(width: 6, height: 6).accessibilityHidden(true)
                Text(label)
                    .font(p.uiFont(12, .medium))
                    .foregroundStyle(p.muted)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(p.surface, in: shape)
        .overlay(shape.strokeBorder(p.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

enum BannerKind {
    case warn, danger, info
}

/// `.banner` — Linear inline notice: panel surface + hairline, a tinted
/// leading glyph, neutral text (no tinted band), optional trailing action.
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

    private var icon: String {
        switch kind {
        case .warn: "exclamationmark.triangle.fill"
        case .danger: "xmark.octagon.fill"
        case .info: "info.circle.fill"
        }
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: p.radiusCard, style: .continuous)
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(tint.color)
                .accessibilityHidden(true)
            Text(text)
                .font(p.uiFont(13, .medium))
                .foregroundStyle(p.text)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let action, let onAction {
                Button(action) { onAction() }
                    .buttonStyle(.plain)
                    .font(p.uiFont(13, .semibold))
                    .foregroundStyle(p.accent)
                    .frame(minHeight: 32)
                    .contentShape(Rectangle())
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(kind == .danger ? tint.soft : p.surface, in: shape)
        .overlay(shape.strokeBorder(kind == .danger ? tint.line : p.border, lineWidth: 1))
    }
}

/// `.conn` — connection indicator: pulsing dot + word. `compact` drops the word
/// (toolbar use, where "polling" truncated to "p…" and squeezed the nav title);
/// VoiceOver keeps the full state either way.
struct ConnChip: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let state: String
    var compact = false

    var body: some View {
        let (color, word): (Color, String) = switch state.lowercased() {
        case "live", "active": (p.ok, "live")
        // A successful probe = healthy; "polling" is the refresh MECHANISM,
        // not a degraded state (SSE remains the listed follow-up) — render it
        // as the good state so reachable workspaces read green "connected".
        case "polling": (p.ok, "connected")
        case "paused": (p.warn, "paused")
        case "unreachable", "off": (p.danger, "unreachable")
        default: (p.idle, state.lowercased())
        }
        HStack(spacing: 6) {
            PulseDot(color: color, animated: !reduceMotion && ["live", "active", "polling"].contains(state.lowercased()))
            if !compact {
                Text(word)
                    .font(p.uiFont(12, .medium))
                    .foregroundStyle(p.text2)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Connection: \(word)")
    }
}

/// `.skel` — quiet loading block; the breathing pulse stops under Reduce Motion.
struct SkeletonBlock: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let height: CGFloat
    @State private var dim = false

    var body: some View {
        RoundedRectangle(cornerRadius: p.radiusCard, style: .continuous)
            .fill(p.surface2)
            .frame(height: height)
            .opacity(dim ? 0.55 : 1)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: dim)
            .onAppear { if !reduceMotion { dim = true } }
            .accessibilityHidden(true)
    }
}

/// `.state` — Linear empty/error state: 56pt glyph tile · 17/semibold title · 13 sub · actions.
struct StateLayout<Glyph: View, Actions: View>: View {
    @Environment(\.palette) private var p
    let title: String
    var sub: String?
    var danger = false
    @ViewBuilder let glyph: Glyph
    @ViewBuilder let actions: Actions

    var body: some View {
        let tile = RoundedRectangle(cornerRadius: 14, style: .continuous)
        VStack(spacing: 12) {
            glyph
                .frame(width: 56, height: 56)
                .background(danger ? p.dangerSoft : p.surface2, in: tile)
                .overlay(tile.strokeBorder(danger ? p.dangerLine : p.border, lineWidth: 1))
            VStack(spacing: 4) {
                Text(title)
                    .font(p.uiFont(17, .semibold))
                    .foregroundStyle(p.text)
                    .multilineTextAlignment(.center)
                if let sub {
                    Text(sub)
                        .font(p.uiFont(13))
                        .foregroundStyle(p.muted)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 290)
                }
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
                .font(p.uiFont(13))
                .foregroundStyle(p.muted)
            Spacer()
            Text(value)
                .font(mono ? .system(size: 12, design: .monospaced) : p.uiFont(13, .medium))
                .foregroundStyle(p.text)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

/// Per-type tint for a run-feed row — a 1:1 mirror of Android `feedTint` (Kit.kt).
private func feedTint(_ type: String, _ p: Palette) -> Color {
    switch type {
    case "boot": p.faint
    case "think": p.muted
    case "tool": p.accent
    case "result": p.text2
    case "subagent": p.info
    case "decision": p.violet
    case "error": p.danger
    case "done": p.ok
    default: p.text // narrate
    }
}

/// One classified run-feed row (flow 06): uppercase label tag + body text; narration
/// reads as plain prose, everything else is label-tinted; `detail` starts collapsed and
/// expands on tap (the web's <details> affordance). 1:1 with Android `FeedRow`.
struct FeedRow: View {
    @Environment(\.palette) private var p
    let row: RunFeedRow
    @State private var expanded = false

    private var hasDetail: Bool {
        !(row.detail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        let tint = feedTint(row.type, p)
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Circle().fill(tint).frame(width: 5, height: 5).accessibilityHidden(true)
                Text(row.label.lowercased())
                    .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(p.muted)
                if hasDetail {
                    Text(expanded ? "▾" : "▸")
                        .font(p.uiFont(10))
                        .foregroundStyle(p.faint)
                }
            }
            if !row.text.isEmpty {
                // Narration is prose → the skin's display face (Space Grotesk on
                // Swiss); everything else stays mono like the portal's log.
                Text(row.text)
                    .font(row.type == "narrate" ? p.uiFont(14) : .system(size: 11.5, design: .monospaced))
                    .foregroundStyle(row.type == "narrate" ? p.text : (row.type == "error" ? p.danger : p.text2))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if expanded, let detail = row.detail, hasDetail {
                Text(detail)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(p.muted)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(p.surface2, in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onTapGesture { if hasDetail { expanded.toggle() } }
        .accessibilityAddTraits(hasDetail ? .isButton : [])
        .accessibilityHint(hasDetail ? (expanded ? "Collapses details" : "Expands details") : "")
    }
}
