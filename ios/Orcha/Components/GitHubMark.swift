import SwiftUI

/// The official GitHub mark — the same 16×16 SVG path the portal inlines in
/// `home-github.js` (`ghMarkSVG`), converted offline to cubic segments (the one
/// arc command included). As a `Shape` it fills with the current foreground
/// style, so it follows Palette/skins exactly like the web's `currentColor`.
struct GitHubMark: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 16
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * s, y: rect.minY + y * s)
        }
        var p = Path()
        p.move(to: pt(8, 0))
        p.addCurve(to: pt(0, 8), control1: pt(3.58, 0), control2: pt(0, 3.58))
        p.addCurve(to: pt(5.47, 15.59), control1: pt(0, 11.54), control2: pt(2.29, 14.53))
        p.addCurve(to: pt(6.02, 15.21), control1: pt(5.87, 15.66), control2: pt(6.02, 15.42))
        p.addCurve(to: pt(6.01, 13.72), control1: pt(6.02, 15.02), control2: pt(6.01, 14.39))
        p.addCurve(to: pt(3.32, 12.78), control1: pt(4, 14.09), control2: pt(3.48, 13.23))
        p.addCurve(to: pt(2.5, 11.65), control1: pt(3.23, 12.55), control2: pt(2.84, 11.84))
        p.addCurve(to: pt(2.49, 11.12), control1: pt(2.22, 11.5), control2: pt(1.82, 11.13))
        p.addCurve(to: pt(3.72, 11.94), control1: pt(3.12, 11.11), control2: pt(3.57, 11.7))
        p.addCurve(to: pt(6.05, 12.6), control1: pt(4.44, 13.15), control2: pt(5.59, 12.81))
        p.addCurve(to: pt(6.56, 11.53), control1: pt(6.12, 12.08), control2: pt(6.33, 11.73))
        p.addCurve(to: pt(2.92, 7.58), control1: pt(4.78, 11.33), control2: pt(2.92, 10.64))
        p.addCurve(to: pt(3.74, 5.43), control1: pt(2.92, 6.71), control2: pt(3.23, 5.99))
        p.addCurve(to: pt(3.82, 3.31), control1: pt(3.66, 5.23), control2: pt(3.38, 4.41))
        p.addCurve(to: pt(6.02, 4.13), control1: pt(3.82, 3.31), control2: pt(4.49, 3.1))
        p.addCurve(to: pt(8.02, 3.86), control1: pt(6.66, 3.95), control2: pt(7.34, 3.86))
        p.addCurve(to: pt(10.02, 4.13), control1: pt(8.7, 3.86), control2: pt(9.38, 3.95))
        p.addCurve(to: pt(12.22, 3.31), control1: pt(11.55, 3.09), control2: pt(12.22, 3.31))
        p.addCurve(to: pt(12.3, 5.43), control1: pt(12.66, 4.41), control2: pt(12.38, 5.23))
        p.addCurve(to: pt(13.12, 7.58), control1: pt(12.81, 5.99), control2: pt(13.12, 6.7))
        p.addCurve(to: pt(9.47, 11.53), control1: pt(13.12, 10.65), control2: pt(11.25, 11.33))
        p.addCurve(to: pt(10.01, 13.01), control1: pt(9.76, 11.78), control2: pt(10.01, 12.26))
        p.addCurve(to: pt(10, 15.21), control1: pt(10.01, 14.08), control2: pt(10, 14.94))
        p.addCurve(to: pt(10.55, 15.59), control1: pt(10, 15.42), control2: pt(10.15, 15.67))
        p.addCurve(to: pt(16, 8), control1: pt(13.799, 14.494), control2: pt(16, 11.429))
        p.addCurve(to: pt(8, 0), control1: pt(16, 3.58), control2: pt(12.42, 0))
        p.closeSubpath()
        return p
    }
}

/// The workspace's repo-binding chip — the iOS `.tag.gh` (portal context card):
/// GitHub mark + mono "owner/name" when bound, "Connect repo" when not. Tapping
/// opens the Connect-repo sheet either way.
struct GitHubRepoChip: View {
    @Environment(\.palette) private var p
    /// "owner/name", or nil when unbound.
    let repo: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                GitHubMark()
                    .frame(width: 13, height: 13)
                Text(repo ?? "Connect repo")
                    .font(repo == nil ? p.uiFont(12, .semibold) : .system(size: 12, design: .monospaced))
                    .lineLimit(1)
            }
            .foregroundStyle(repo == nil ? p.accent : p.text2)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(p.surface, in: RoundedRectangle(cornerRadius: p.radiusTag + 4))
            .overlay(
                RoundedRectangle(cornerRadius: p.radiusTag + 4)
                    .strokeBorder(repo == nil ? p.accentLine : p.border2, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: p.radiusTag + 4))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(repo.map { "GitHub repository: \($0)" } ?? "Connect a GitHub repository")
        .accessibilityHint(repo == nil ? "Opens the repository picker" : "Change or unbind the repository")
    }
}
