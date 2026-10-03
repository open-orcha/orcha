import SwiftUI

/// D14 project icon (web `ProjectIcon` parity): the emoji, or the glyph (SF Symbol closest
/// to the web's Lucide mark) tinted with its avatar-palette hue, on a subtle surface tile.
/// Unset / unknown = the neutral cube glyph — never initials.
struct ProjectIconView: View {
    @Environment(\.palette) private var p
    let icon: ProjectIcon?
    var size: CGFloat = 32
    /// Draw the surface tile behind the mark (off for inline toolbar use).
    var tile = true

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
        mark
            .frame(width: size, height: size)
            .background(tile ? p.surface2 : .clear, in: shape)
            .overlay { if tile { shape.strokeBorder(p.border, lineWidth: 1) } }
            .accessibilityElement()
            .accessibilityLabel(ProjectIconUx.accessibilityLabel(icon))
    }

    @ViewBuilder
    private var mark: some View {
        if case let .emoji(value) = icon {
            Text(value)
                .font(.system(size: size * (tile ? 0.58 : 0.86)))
                .dynamicTypeSize(.large)
        } else {
            Image(systemName: ProjectIconUx.sfSymbol(for: icon))
                .font(.system(size: size * (tile ? 0.48 : 0.72), weight: .medium))
                .foregroundStyle(tint)
        }
    }

    private var tint: Color {
        guard case let .glyph(_, slot) = icon else { return p.text2 }
        return ProjectIconSwatchColor.color(slot: slot, dark: p.isDark, neutral: p.text2)
    }
}

/// A glyph colour swatch for slot 0-9 (or nil = "No colour").
struct ProjectIconSwatchColor {
    static func color(slot: Int?, dark: Bool, neutral: Color) -> Color {
        guard let hsb = ProjectIconUx.glyphHSB(slot: slot, dark: dark) else { return neutral }
        return Color(hue: hsb.h, saturation: hsb.s, brightness: hsb.b)
    }
}
