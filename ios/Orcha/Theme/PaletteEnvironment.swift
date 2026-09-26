import SwiftUI

private struct PaletteKey: EnvironmentKey {
    static let defaultValue: Palette = .dark
}

extension EnvironmentValues {
    /// The resolved Orcha token palette for the active color scheme.
    var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

/// Resolves Auto/Light/Dark + the design skin against the system scheme and
/// injects the palette + the page background. Classic keeps the two faint brand
/// radial gradients from the portal; Swiss is deliberately flat (the portal's
/// `--bg-grad-*: transparent`).
struct OrchaThemed<Content: View>: View {
    @Environment(\.colorScheme) private var systemScheme
    let mode: ThemeMode
    var skin: SkinMode = .classic
    @ViewBuilder let content: Content

    private var palette: Palette {
        Palette.current(mode, skin: skin, systemDark: systemScheme == .dark)
    }

    var body: some View {
        content
            .environment(\.palette, palette)
            .background {
                ZStack {
                    palette.bg
                    if !palette.flatChrome {
                        RadialGradient(
                            colors: [Color(hex: 0x15C0C6, alpha: palette.isDark ? 0.055 : 0.07), .clear],
                            center: .init(x: 0.15, y: 0.0), startRadius: 0, endRadius: 500
                        )
                        RadialGradient(
                            colors: [Color(hex: 0x7D91FF, alpha: palette.isDark ? 0.045 : 0.06), .clear],
                            center: .init(x: 1.0, y: 0.1), startRadius: 0, endRadius: 450
                        )
                    }
                }
                .ignoresSafeArea()
            }
    }
}
