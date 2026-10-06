import SwiftUI
import UIKit

// MARK: - Linear design kit
//
// The iOS mirror of the web portal's v2 ("Linear") design system
// (`orcha-cli/.../static/styles/v2-tokens.css`). Every component reads the
// active `Palette` from the environment so classic/swiss/minimal skins and
// light/dark keep working; the Linear palettes are the defaults.

// MARK: Typography

/// Linear type scale. Inter (bundled) with an SF fallback; every size scales
/// with Dynamic Type through `Font.custom(_:size:relativeTo:)`.
enum LType {
    case display, title, headline, body, bodyEmph, meta, mono, micro

    var size: CGFloat {
        switch self {
        case .display: 28
        case .title: 20
        case .headline: 15
        case .body, .bodyEmph: 15
        case .meta, .mono: 13
        case .micro: 11
        }
    }

    var weight: Font.Weight {
        switch self {
        case .display, .title, .headline: .semibold
        case .bodyEmph: .medium
        default: .regular
        }
    }

    var textStyle: Font.TextStyle {
        switch self {
        case .display: .title
        case .title: .title3
        case .headline: .headline
        case .body, .bodyEmph: .subheadline
        case .meta, .mono: .footnote
        case .micro: .caption2
        }
    }

    /// Inter is set slightly tight at display sizes (the web uses -0.01em..-0.02em).
    var tracking: CGFloat {
        switch self {
        case .display: -0.5
        case .title: -0.3
        case .headline, .body, .bodyEmph: -0.1
        case .meta: 0
        case .mono: 0
        case .micro: 0.1
        }
    }

    var lineSpacing: CGFloat {
        switch self {
        case .display, .title: 2
        case .body, .bodyEmph: 3
        default: 1
        }
    }

    /// Skin-aware: the Linear skin (and the SF fallback) use Inter; Swiss and
    /// Minimal keep their own bundled display families.
    func font(for p: Palette) -> Font {
        if self != .mono, p.displayFamily != nil || (p.displayFacesByWeight != nil && p.displayFacesByWeight != Palette.interFacesByWeight) {
            return p.uiFont(size, weight)
        }
        return font
    }

    var font: Font {
        if self == .mono {
            return .system(.footnote, design: .monospaced)
        }
        return LFont.inter(size, weight, relativeTo: textStyle)
    }
}

/// Inter face resolution. Static cuts are registered in `UIAppFonts`; each
/// weight is its own PostScript name so weights stay exact (no faux bold).
enum LFont {
    static let faces: [Font.Weight: String] = [
        .regular: "Inter-Regular",
        .medium: "Inter-Medium",
        .semibold: "Inter-SemiBold",
        .bold: "Inter-Bold",
    ]

    static let isInterAvailable: Bool = UIFont(name: "Inter-Regular", size: 12) != nil

    static func inter(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
        guard isInterAvailable else {
            return .system(style).weight(weight)  // keeps Dynamic Type on the fallback path
                .leading(.standard)
        }
        let face = faces[weight] ?? (weight == .heavy || weight == .black ? "Inter-Bold" : "Inter-Regular")
        return .custom(face, size: size, relativeTo: style)
    }

    /// UIKit counterpart for chrome (nav/tab bar appearance).
    static func uiInter(_ size: CGFloat, _ weight: UIFont.Weight) -> UIFont {
        let name: String = switch weight {
        case .medium: "Inter-Medium"
        case .semibold: "Inter-SemiBold"
        case .bold, .heavy, .black: "Inter-Bold"
        default: "Inter-Regular"
        }
        return UIFont(name: name, size: size) ?? .systemFont(ofSize: size, weight: weight)
    }
}

private struct LTypeModifier: ViewModifier {
    @Environment(\.palette) private var p
    let type: LType
    func body(content: Content) -> some View {
        content
            .font(type.font(for: p))
            .tracking(type.tracking)
            .lineSpacing(type.lineSpacing)
    }
}

extension View {
    /// Applies a Linear text style (font + tracking + line spacing).
    func ltype(_ t: LType) -> some View {
        modifier(LTypeModifier(type: t))
    }
}

// MARK: Spacing & motion

enum LSpace {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 24
}

extension Animation {
    /// ~150ms ease-out — hover/press/selection changes.
    static var lQuick: Animation { .easeOut(duration: 0.15) }
    /// Snappy, barely-bouncy spring for layout changes.
    static var lSpring: Animation { .spring(response: 0.32, dampingFraction: 0.86) }
}

extension View {
    /// `withAnimation` replacement for call sites: no animation under Reduce Motion.
    func lAnimation<V: Equatable>(_ animation: Animation = .lQuick, value: V) -> some View {
        modifier(LReduceMotionAnimation(animation: animation, value: value))
    }
}

private struct LReduceMotionAnimation<V: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let animation: Animation
    let value: V
    func body(content: Content) -> some View {
        content.animation(reduceMotion ? nil : animation, value: value)
    }
}

// MARK: Palette helpers (Linear semantics)

extension Palette {
    /// Fill for primary buttons (web `--v2-primary-bg`), white label on top.
    var lPrimaryFill: Color { primaryFill ?? accent }
    var lPrimaryText: Color { primaryFill == nil ? accentInk : .white }
    /// Row hover / pressed tint (web `--v2-hover` / `--v2-selected`).
    var lHover: Color { isDark ? Color.white.opacity(0.045) : Color(hex: 0x18191C, alpha: 0.045) }
    var lSelected: Color { isDark ? Color.white.opacity(0.08) : Color(hex: 0x18191C, alpha: 0.07) }
    /// Unlit priority bar.
    var lPrioEmpty: Color { isDark ? Color(hex: 0x3A3C42) : Color(hex: 0xD5D6DA) }
    var lUrgent: Color { isDark ? Color(hex: 0xF2994A) : Color(hex: 0xDE6414) }
    var lProgress: Color { isDark ? Color(hex: 0xF0BF4C) : Color(hex: 0xB07D00) }
    var lStatusNeutral: Color { isDark ? Color(hex: 0x8A8F98) : Color(hex: 0x8A8E96) }
    /// Web status-glyph tokens (`--v2-st-todo` / `-faint` / `-muted`).
    var lStatusTodo: Color { isDark ? Color(hex: 0x9EA2AC) : Color(hex: 0x8A8E96) }
    var lStatusFaint: Color { isDark ? Color(hex: 0x6E727C) : Color(hex: 0xA3A6AD) }
    var lStatusMuted: Color { isDark ? Color(hex: 0x7B7F89) : Color(hex: 0x8A8E96) }
}

// MARK: Surfaces & structure

/// Panel surface, 1px hairline border, Linear radius (10 on the Linear skin).
struct LCard<Content: View>: View {
    @Environment(\.palette) private var p
    var padding: CGFloat = 12
    @ViewBuilder var content: Content

    init(padding: CGFloat = 12, @ViewBuilder content: () -> Content) {
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(p.surface, in: RoundedRectangle(cornerRadius: p.radiusCard, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: p.radiusCard, style: .continuous)
                    .strokeBorder(p.border, lineWidth: 1)
            )
    }
}

/// Muted caption header (title · count · trailing) above its content. No band.
struct LSection<Content: View>: View {
    @Environment(\.palette) private var p
    let title: String
    var count: Int?
    var trailing: AnyView?
    /// A model id / runtime / provider: shows its provider mark before the title.
    var markModel: String?
    @ViewBuilder var content: Content

    init(_ title: String, count: Int? = nil, trailing: AnyView? = nil, markModel: String? = nil,
         @ViewBuilder content: () -> Content) {
        self.title = title
        self.count = count
        self.trailing = trailing
        self.markModel = markModel
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: LSpace.s) {
            HStack(spacing: 6) {
                ModelProviderMark(model: markModel, size: 13)
                Text(title)
                    .ltype(.meta)
                    .fontWeight(.medium)
                    .foregroundStyle(p.text2)
                if let count {
                    Text("\(count)")
                        .ltype(.meta)
                        .monospacedDigit()
                        .foregroundStyle(p.muted)
                }
                Spacer(minLength: LSpace.s)
                if let trailing { trailing }
            }
            .padding(.horizontal, 4)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            content
        }
    }
}

/// List row: leading glyph · title + one muted subtitle line · trailing meta.
/// Wrap in a `Button`/`NavigationLink` with `.buttonStyle(.lRow)` for the
/// pressed background.
struct LRow<Leading: View, Trailing: View>: View {
    @Environment(\.palette) private var p
    let title: String
    var subtitle: String?
    @ViewBuilder var leading: Leading
    @ViewBuilder var trailing: Trailing

    init(title: String, subtitle: String? = nil,
         @ViewBuilder leading: () -> Leading,
         @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.subtitle = subtitle
        self.leading = leading()
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: subtitle == nil ? .center : .top, spacing: LSpace.m) {
            leading
                .padding(.top, subtitle == nil ? 0 : 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .ltype(.bodyEmph)
                    .foregroundStyle(p.text)
                    .lineLimit(2)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .ltype(.meta)
                        .foregroundStyle(p.muted)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing
                .ltype(.meta)
                .foregroundStyle(p.muted)
        }
        .padding(.horizontal, LSpace.m)
        .padding(.vertical, LSpace.s)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }
}

extension LRow where Trailing == EmptyView {
    init(title: String, subtitle: String? = nil, @ViewBuilder leading: () -> Leading) {
        self.init(title: title, subtitle: subtitle, leading: leading, trailing: { EmptyView() })
    }
}

/// Pressed-state background for tappable rows (web `--v2-selected`).
struct LRowButtonStyle: ButtonStyle {
    @Environment(\.palette) private var p
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? p.lSelected : Color.clear)
            .contentShape(Rectangle())
    }
}

extension ButtonStyle where Self == LRowButtonStyle {
    static var lRow: LRowButtonStyle { LRowButtonStyle() }
}

/// Hairline divider in the palette border colour.
struct LDivider: View {
    @Environment(\.palette) private var p
    @Environment(\.displayScale) private var scale
    var inset: CGFloat = 0

    var body: some View {
        Rectangle()
            .fill(p.border)
            .frame(height: 1 / max(scale, 1))
            .padding(.leading, inset)
            .accessibilityHidden(true)
    }
}

/// Calm empty state: muted glyph, title, one line, optional single action.
struct LEmptyState: View {
    @Environment(\.palette) private var p
    let icon: String
    let title: String
    let message: String
    var actionTitle: String?
    var action: (() -> Void)?

    init(icon: String, title: String, message: String, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        self.icon = icon
        self.title = title
        self.message = message
        self.actionTitle = actionTitle
        self.action = action
    }

    var body: some View {
        VStack(spacing: LSpace.m) {
            Image(systemName: icon)
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(p.muted)
                .frame(width: 44, height: 44)
                .background(p.surface2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(p.border, lineWidth: 1))
                .accessibilityHidden(true)
            VStack(spacing: LSpace.xs) {
                Text(title)
                    .ltype(.headline)
                    .foregroundStyle(p.text)
                Text(message)
                    .ltype(.meta)
                    .foregroundStyle(p.muted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let actionTitle, let action {
                LButton(actionTitle, kind: .secondary, size: .small, action: action)
                    .padding(.top, LSpace.xs)
            }
        }
        .frame(maxWidth: 320)
        .padding(.vertical, LSpace.xl)
        .frame(maxWidth: .infinity)
    }
}

// MARK: Controls

enum LButtonStyleKind { case primary, secondary, ghost, danger }
enum LSize { case small, regular }

/// Compact Linear button. Small = 28pt visual, regular = 34pt; both keep a
/// 44pt hit target.
struct LButton: View {
    let title: String
    var icon: String?
    var kind: LButtonStyleKind = .secondary
    var size: LSize = .regular
    let action: () -> Void

    init(_ title: String, icon: String? = nil, kind: LButtonStyleKind = .secondary, size: LSize = .regular, action: @escaping () -> Void) {
        self.title = title
        self.icon = icon
        self.kind = kind
        self.size = size
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: size == .small ? 11 : 13, weight: .semibold))
                        .accessibilityHidden(true)
                }
                Text(title)
                    .ltype(size == .small ? .meta : .bodyEmph)
                    .fontWeight(.medium)
                    // Large Dynamic Type: shrink slightly, then wrap, instead of "Acc…".
                    .lineLimit(1...2)
                    .minimumScaleFactor(0.85)
                    .multilineTextAlignment(.center)
            }
        }
        .buttonStyle(LButtonStyle(kind: kind, size: size))
    }
}

/// The `ButtonStyle` behind `LButton`, reusable on custom labels.
struct LButtonStyle: ButtonStyle {
    @Environment(\.palette) private var p
    @Environment(\.isEnabled) private var isEnabled
    var kind: LButtonStyleKind = .secondary
    var size: LSize = .regular

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        let shape = RoundedRectangle(cornerRadius: p.radiusButton, style: .continuous)
        configuration.label
            .foregroundStyle(foreground)
            .padding(.horizontal, size == .small ? 10 : 12)
            .frame(minHeight: size == .small ? 28 : 34)
            .background(background(pressed: pressed), in: shape)
            .overlay(shape.strokeBorder(borderColor, lineWidth: 1))
            .opacity(isEnabled ? 1 : 0.45)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
    }

    private var foreground: Color {
        switch kind {
        case .primary: p.lPrimaryText
        case .secondary: p.text
        case .ghost: p.text2
        case .danger: p.danger
        }
    }

    private func background(pressed: Bool) -> Color {
        switch kind {
        case .primary: pressed ? p.lPrimaryFill.opacity(0.85) : p.lPrimaryFill
        case .secondary: pressed ? p.surface3 : p.surface2
        case .ghost: pressed ? p.lSelected : .clear
        case .danger: pressed ? p.dangerLine : p.dangerSoft
        }
    }

    private var borderColor: Color {
        switch kind {
        case .primary: .clear
        case .secondary: p.border2
        case .ghost: .clear
        case .danger: p.dangerLine
        }
    }
}

/// Compact filter / label chip.
struct LChip: View {
    @Environment(\.palette) private var p
    let text: String
    var icon: String?
    var tint: Color?
    var selected: Bool = false
    var action: (() -> Void)?

    init(_ text: String, icon: String? = nil, tint: Color? = nil, selected: Bool = false, action: (() -> Void)? = nil) {
        self.text = text
        self.icon = icon
        self.tint = tint
        self.selected = selected
        self.action = action
    }

    var body: some View {
        if let action {
            Button(action: action) { label }
                .buttonStyle(.plain)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
                .accessibilityAddTraits(selected ? .isSelected : [])
        } else {
            label
                .accessibilityElement(children: .combine)
        }
    }

    private var label: some View {
        HStack(spacing: 5) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(tint ?? (selected ? p.text : p.muted))
                    .accessibilityHidden(true)
            } else if let tint {
                Circle().fill(tint).frame(width: 7, height: 7).accessibilityHidden(true)
            }
            Text(text)
                .ltype(.meta)
                .fontWeight(.medium)
                .foregroundStyle(selected ? p.text : p.text2)
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 26)
        .background(selected ? p.lSelected : Color.clear, in: Capsule())
        .overlay(Capsule().strokeBorder(selected ? p.border2 : p.border, lineWidth: 1))
    }
}

/// Pill segmented control (web FilterPills).
struct LSegmented<T: Hashable>: View {
    @Environment(\.palette) private var p
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let options: [(T, String)]
    @Binding var selection: T

    init(_ options: [(T, String)], selection: Binding<T>) {
        self.options = options
        self._selection = selection
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(options.indices, id: \.self) { i in
                    let (value, title) = options[i]
                    let isOn = value == selection
                    Button {
                        if reduceMotion { selection = value } else {
                            withAnimation(.lQuick) { selection = value }
                        }
                    } label: {
                        Text(title)
                            .ltype(.meta)
                            .fontWeight(.medium)
                            .foregroundStyle(isOn ? p.text : p.muted)
                            .padding(.horizontal, 12)
                            .frame(minHeight: 28)
                            .background(isOn ? p.surface3 : Color.clear, in: Capsule())
                            .overlay(Capsule().strokeBorder(isOn ? p.border2 : Color.clear, lineWidth: 1))
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(isOn ? .isSelected : [])
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }
}

/// Compact search input: magnifier, field, clear.
struct LSearchField: View {
    @Environment(\.palette) private var p
    let placeholder: String
    @Binding var text: String

    init(_ placeholder: String, text: Binding<String>) {
        self.placeholder = placeholder
        self._text = text
    }

    var body: some View {
        HStack(spacing: LSpace.s) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(p.muted)
                .accessibilityHidden(true)
            TextField(placeholder, text: $text, prompt: Text(placeholder).foregroundStyle(p.faint))
                .accessibilityLabel(placeholder)
                .ltype(.body)
                .foregroundStyle(p.text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(p.faint)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 36)
        .background(p.surface2, in: RoundedRectangle(cornerRadius: p.radiusButton, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: p.radiusButton, style: .continuous).strokeBorder(p.border, lineWidth: 1))
    }
}

// MARK: Identity

/// Round avatar: deterministic hue from the name, initial, ✦ badge for AI
/// agents, optional presence dot.
struct LAvatar: View {
    @Environment(\.palette) private var p
    let name: String
    var isAI: Bool = false
    var size: CGFloat = 24
    var status: String?

    init(name: String, isAI: Bool = false, size: CGFloat = 24, status: String? = nil) {
        self.name = name
        self.isAI = isAI
        self.size = size
        self.status = status
    }

    /// Stable across launches (Swift's `hashValue` is seeded per process).
    static func hue(for name: String) -> Double {
        var h: UInt32 = 5381
        for s in name.lowercased().unicodeScalars { h = (h &* 33) &+ s.value }
        return Double(h % 360) / 360
    }

    private var initial: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.first.map { String($0).uppercased() } ?? "?"
    }

    var body: some View {
        let hue = Self.hue(for: name)
        let bg = p.isDark
            ? Color(hue: hue, saturation: 0.42, brightness: 0.36)
            : Color(hue: hue, saturation: 0.22, brightness: 0.94)
        let fg = p.isDark
            ? Color(hue: hue, saturation: 0.30, brightness: 0.96)
            : Color(hue: hue, saturation: 0.70, brightness: 0.42)
        Circle()
            .fill(bg)
            .overlay(
                Text(initial)
                    .font(LFont.inter(size * 0.46, .semibold))
                    .foregroundStyle(fg)
                    .dynamicTypeSize(.large)  // fixed-size glyph inside a fixed-size circle
            )
            .frame(width: size, height: size)
            .overlay(alignment: .topTrailing) {
                if isAI {
                    let b = max(9, size * 0.44)
                    Text("✦")
                        .font(.system(size: b * 0.62, weight: .bold))
                        .foregroundStyle(p.lPrimaryText)
                        .frame(width: b, height: b)
                        .background(p.lPrimaryFill, in: Circle())
                        .overlay(Circle().strokeBorder(p.bg, lineWidth: 1.5))
                        .offset(x: b * 0.3, y: -b * 0.3)
                        .dynamicTypeSize(.large)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if let dot = presenceColor {
                    let d = max(7, size * 0.32)
                    Circle()
                        .fill(dot)
                        .frame(width: d, height: d)
                        .overlay(Circle().strokeBorder(p.bg, lineWidth: max(1.5, d * 0.22)))
                        .offset(x: d * 0.2, y: d * 0.2)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText)
    }

    private var presenceColor: Color? {
        guard let s = status?.lowercased(), !s.isEmpty else { return nil }
        switch s {
        case "online", "active", "working", "busy", "running", "live", "in_progress": return p.ok
        // Same meaning as the status pill: waiting (on a request or on you) is warn, idle is quiet.
        case "waiting", "paused", "awaiting_request", "awaiting_human": return p.warn
        case "error", "failed", "blocked", "stuck": return p.danger
        default: return p.faint
        }
    }

    private var accessibilityText: String {
        var parts = [name]
        if isAI { parts.append("AI agent") }
        if let status, !status.isEmpty { parts.append(status.replacingOccurrences(of: "_", with: " ")) }
        return parts.joined(separator: ", ")
    }
}

// MARK: Status & priority glyphs

/// The web `StatusIcon` glyph set (portal `components/primitives/StatusIcon.tsx`),
/// drawn on the same 14×14 grid so every task / request / agent status reads
/// identically on web, iOS and Android. Shape + colour + label all mirror the web.
struct LStatusGlyph: View {
    @Environment(\.palette) private var p
    let status: String
    var size: CGFloat = 14

    init(status: String, size: CGFloat = 14) {
        self.status = status
        self.size = size
    }

    /// Web `StatusShape`.
    enum Kind: CaseIterable {
        case todo, dashed, dotted, progress, paused, attention, review, done
        case blocked, failed, stopped, rejected, escalated, cancelled, closed
        case open, accepted, converted, unknown
    }

    /// Web `StatusColor` (palette tokens `--v2-st-*` / warn / danger / accent).
    enum Tone: Equatable { case todo, faint, progress, warn, review, done, danger, muted, accent }

    /// Web `SHAPE` table, plus a few legacy mobile aliases mapped onto the same family.
    static func style(for status: String) -> (kind: Kind, tone: Tone) {
        switch status.lowercased() {
        case "ready", "todo": (.todo, .todo)
        case "pending", "not_ready", "backlog", "draft", "queued": (.dashed, .todo)
        case "idle", "offline": (.dotted, .faint)
        case "in_progress", "inprogress", "working", "active", "live", "running", "started": (.progress, .progress)
        case "awaiting_request", "paused", "rate_limited", "waiting": (.paused, .warn)
        case "awaiting_human": (.attention, .warn)
        case "needs_verification", "review", "in_review", "needs_review", "verifying": (.review, .review)
        case "completed", "answered", "verified", "done", "merged", "passed", "resolved": (.done, .done)
        case "blocked": (.blocked, .danger)
        case "failed", "error": (.failed, .danger)
        case "terminated": (.stopped, .danger)
        case "orphaned": (.stopped, .muted)
        case "rejected", "refused": (.rejected, .danger)
        case "escalated": (.escalated, .danger)
        case "cancelled", "canceled", "archived", "stopped", "killed", "skipped", "expired": (.cancelled, .muted)
        case "closed": (.closed, .muted)
        case "open": (.open, .todo)
        case "accepted": (.accepted, .accent)
        case "converted_to_task": (.converted, .accent)
        default: (.unknown, .faint)
        }
    }

    static func kind(for status: String) -> Kind { style(for: status).kind }
    static func tone(for status: String) -> Tone { style(for: status).tone }

    /// Web `STAT` labels (lib/status.ts); unknown statuses keep their raw value.
    static func label(for status: String) -> String {
        let s = status.lowercased()
        switch s {
        case "working": return "Working"
        case "in_progress": return "In progress"
        case "idle": return "Idle"
        case "pending": return "Pending"
        case "ready": return "Ready"
        case "blocked": return "Blocked"
        case "awaiting_request": return "Waiting"
        case "awaiting_human": return "Needs human"
        case "needs_verification": return "Needs verification"
        case "completed": return "Completed"
        case "cancelled": return "Cancelled"
        case "failed": return "Failed"
        case "terminated": return "Terminated"
        case "open": return "Open"
        case "accepted": return "Accepted"
        case "rejected": return "Rejected"
        case "answered": return "Answered"
        case "converted_to_task": return "Converted"
        case "closed": return "Closed"
        case "escalated": return "Escalated"
        case "offline": return "Offline"
        case "active": return "Active"
        case "paused": return "Paused"
        case "rate_limited": return "Rate limited"
        case "orphaned": return "Orphaned"
        case "not_ready": return "On hold"
        case "": return "unknown"
        default: return status
        }
    }

    private func color(_ tone: Tone) -> Color {
        switch tone {
        case .todo: p.lStatusTodo
        case .faint: p.lStatusFaint
        case .progress: p.lProgress
        case .warn: p.warn
        case .review, .done: p.ok
        case .danger: p.danger
        case .muted: p.lStatusMuted
        case .accent: p.accent
        }
    }

    var body: some View {
        let (kind, tone) = Self.style(for: status)
        let ink = color(tone)
        let cut = p.bg
        Canvas { ctx, canvasSize in
            let k = min(canvasSize.width, canvasSize.height) / 14
            ctx.scaleBy(x: k, y: k)
            LStatusGlyphDrawing.draw(kind, in: &ctx, ink: ink, cut: cut)
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.label(for: status))
    }
}

/// Path data from the web `Shape` switch, in the 14×14 viewBox (centre 7,7;
/// ring r 5.5 stroke 1.5; inner pie r 2.6; filled disc r 6.25).
enum LStatusGlyphDrawing {
    private static let center = CGPoint(x: 7, y: 7)

    private static func circle(_ r: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: 7 - r, y: 7 - r, width: r * 2, height: r * 2))
    }

    private static func lines(_ segments: [[CGPoint]]) -> Path {
        var path = Path()
        for seg in segments {
            guard let first = seg.first else { continue }
            path.move(to: first)
            for pt in seg.dropFirst() { path.addLine(to: pt) }
        }
        return path
    }

    private static func pie(sweep: Double) -> Path {
        var path = Path()
        path.move(to: center)
        path.addLine(to: CGPoint(x: 7, y: 4.4))
        path.addArc(center: center, radius: 2.6, startAngle: .degrees(-90), endAngle: .degrees(-90 + sweep), clockwise: false)
        path.closeSubpath()
        return path
    }

    private static func line(_ w: CGFloat) -> StrokeStyle {
        StrokeStyle(lineWidth: w, lineCap: .round, lineJoin: .round)
    }

    static func draw(_ kind: LStatusGlyph.Kind, in ctx: inout GraphicsContext, ink: Color, cut: Color) {
        let ring = circle(5.5)
        func strokeRing(_ style: StrokeStyle = StrokeStyle(lineWidth: 1.5), opacity: Double = 1) {
            ctx.stroke(ring, with: .color(ink.opacity(opacity)), style: style)
        }
        func filled(_ mark: Path, width: CGFloat = 1.5) {
            ctx.fill(circle(6.25), with: .color(ink))
            ctx.stroke(mark, with: .color(cut), style: line(width))
        }
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }

        switch kind {
        case .todo:
            strokeRing()
        case .dashed:
            strokeRing(StrokeStyle(lineWidth: 1.5, dash: [2.05, 1.9]))
        case .dotted:
            strokeRing(StrokeStyle(lineWidth: 1.6, lineCap: .round, dash: [0.01, 2.85]))
        case .progress:
            strokeRing()
            ctx.fill(pie(sweep: 180), with: .color(ink))
        case .review:
            strokeRing()
            ctx.fill(pie(sweep: 270), with: .color(ink))
        case .paused:
            strokeRing()
            ctx.stroke(lines([[pt(5.8, 5.3), pt(5.8, 8.7)], [pt(8.2, 5.3), pt(8.2, 8.7)]]), with: .color(ink), style: line(1.3))
        case .attention, .open:
            strokeRing()
            ctx.fill(circle(2), with: .color(ink))
        case .done, .closed:
            filled(lines([[pt(4.4, 7.2), pt(6.2, 9), pt(9.6, 5.2)]]))
        case .failed:
            filled(lines([[pt(5, 5), pt(9, 9)], [pt(9, 5), pt(5, 9)]]))
        case .cancelled:
            filled(lines([[pt(4.9, 9.1), pt(9.1, 4.9)]]))
        case .converted:
            filled(lines([[pt(4.3, 7), pt(9.5, 7)], [pt(7.4, 4.9), pt(9.5, 7), pt(7.4, 9.1)]]), width: 1.4)
        case .blocked:
            strokeRing()
            ctx.stroke(lines([[pt(4.6, 7), pt(9.4, 7)]]), with: .color(ink), style: line(1.6))
        case .stopped:
            strokeRing()
            ctx.fill(Path(roundedRect: CGRect(x: 5.1, y: 5.1, width: 3.8, height: 3.8), cornerRadius: 0.8), with: .color(ink))
        case .rejected:
            strokeRing()
            ctx.stroke(lines([[pt(5.3, 5.3), pt(8.7, 8.7)], [pt(8.7, 5.3), pt(5.3, 8.7)]]), with: .color(ink), style: line(1.4))
        case .escalated:
            strokeRing()
            ctx.stroke(lines([[pt(7, 9.4), pt(7, 4.8)], [pt(5, 6.6), pt(7, 4.6), pt(9, 6.6)]]), with: .color(ink), style: line(1.4))
        case .accepted:
            strokeRing()
            ctx.stroke(lines([[pt(4.9, 7.1), pt(6.4, 8.6), pt(9.2, 5.5)]]), with: .color(ink), style: line(1.4))
        case .unknown:
            strokeRing(opacity: 0.6)
        }
    }
}

/// Right half of a circle (the in-progress fill).
struct LHalfPie: Shape {
    var fraction: Double = 0.5
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let r = min(rect.width, rect.height) / 2
        path.move(to: c)
        path.addArc(center: c, radius: r, startAngle: .degrees(-90), endAngle: .degrees(-90 + 360 * fraction), clockwise: false)
        path.closeSubpath()
        return path
    }
}

struct LCheckmark: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY + rect.height * 0.55))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.38, y: rect.maxY - rect.height * 0.08))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + rect.height * 0.1))
        return path
    }
}

struct LCross: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.move(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        return path
    }
}

/// Linear priority: three ascending bars lit by level; urgent is an orange
/// rounded square with "!". Buckets match the web: <=5 urgent, <=20 high,
/// <=100 normal, else low; nil = no priority (three dim dashes).
struct LPriorityGlyph: View {
    @Environment(\.palette) private var p
    let priority: Int?
    var size: CGFloat = 14

    init(priority: Int?, size: CGFloat = 14) {
        self.priority = priority
        self.size = size
    }

    enum Level: Int { case none = 0, low = 1, normal = 2, high = 3, urgent = 4 }

    static func level(for priority: Int?) -> Level {
        guard let priority else { return .none }
        if priority <= 5 { return .urgent }
        if priority <= 20 { return .high }
        if priority <= 100 { return .normal }
        return .low
    }

    var body: some View {
        let level = Self.level(for: priority)
        Group {
            if level == .urgent {
                RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                    .fill(p.lUrgent)
                    .overlay(
                        Text("!")
                            .font(.system(size: size * 0.72, weight: .heavy, design: .rounded))
                            .foregroundStyle(.white)
                    )
                    .padding(size * 0.04)
            } else if level == .none {
                HStack(spacing: size * 0.12) {
                    ForEach(0..<3, id: \.self) { _ in
                        Capsule().fill(p.lStatusNeutral).frame(width: size * 0.2, height: size * 0.12)
                    }
                }
            } else {
                HStack(alignment: .bottom, spacing: size * 0.12) {
                    ForEach(0..<3, id: \.self) { i in
                        RoundedRectangle(cornerRadius: size * 0.06)
                            .fill(i < level.rawValue ? p.text2 : p.lPrioEmpty)
                            .frame(width: size * 0.2, height: size * (0.38 + 0.25 * Double(i)))
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .dynamicTypeSize(.large)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.label(for: level))
    }

    static func label(for level: Level) -> String {
        switch level {
        case .none: "No priority"
        case .low: "Low priority"
        case .normal: "Normal priority"
        case .high: "High priority"
        case .urgent: "Urgent"
        }
    }
}

// MARK: Small labels

/// Small count pill.
struct LBadgeCount: View {
    @Environment(\.palette) private var p
    let n: Int

    init(_ n: Int) { self.n = n }

    var body: some View {
        Text(n > 99 ? "99+" : "\(n)")
            .ltype(.micro)
            .fontWeight(.semibold)
            .monospacedDigit()
            .foregroundStyle(p.text2)
            .padding(.horizontal, 6)
            .frame(minWidth: 18, minHeight: 18)
            .background(p.surface3, in: Capsule())
            .accessibilityLabel("\(n)")
    }
}

/// Compact neutral tag; an optional tint shows as a leading dot.
struct LTag: View {
    @Environment(\.palette) private var p
    let text: String
    var tint: Color?
    /// A model id / runtime: shows its provider mark (Claude / OpenAI) before the text.
    var markModel: String?

    init(_ text: String, tint: Color? = nil, markModel: String? = nil) {
        self.text = text
        self.tint = tint
        self.markModel = markModel
    }

    var body: some View {
        HStack(spacing: 5) {
            if let tint {
                Circle().fill(tint).frame(width: 6, height: 6).accessibilityHidden(true)
            }
            ModelProviderMark(model: markModel, size: 11)
            Text(text)
                .ltype(.micro)
                .fontWeight(.medium)
                .foregroundStyle(p.text2)
                .lineLimit(1)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(p.surface2, in: RoundedRectangle(cornerRadius: p.radiusTag, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: p.radiusTag, style: .continuous).strokeBorder(p.border, lineWidth: 1))
    }
}
