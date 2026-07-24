import SwiftUI

// Responsibility: Agent avatar and Orcha brand identity components.

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
