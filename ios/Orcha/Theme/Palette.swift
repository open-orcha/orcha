import SwiftUI

/// Orcha design tokens (docs/design/mobile/tokens/orcha-mobile-tokens.json v1.0.0),
/// mapped 1:1 — the same palette the portal and the Android app render. Do not
/// invent colors here; change the token file and propagate.
struct Palette {
    let bg: Color
    let surface: Color
    let surface2: Color
    let surface3: Color
    let raised: Color
    let border: Color
    let border2: Color
    let text: Color
    let text2: Color
    let muted: Color
    let faint: Color
    let accent: Color
    let accentInk: Color
    let accentSoft: Color
    let accentLine: Color
    let ok: Color
    let okSoft: Color
    let okLine: Color
    let info: Color
    let infoSoft: Color
    let infoLine: Color
    let warn: Color
    let warnSoft: Color
    let warnLine: Color
    let danger: Color
    let dangerSoft: Color
    let dangerLine: Color
    let violet: Color
    let violetSoft: Color
    let violetLine: Color
    let idle: Color
    let idleSoft: Color
    let idleLine: Color
    let isDark: Bool

    static let dark = Palette(
        bg: Color(hex: 0x0A0D12),
        surface: Color(hex: 0x111620),
        surface2: Color(hex: 0x161D29),
        surface3: Color(hex: 0x1C2532),
        raised: Color(hex: 0x1A2230),
        border: Color(hex: 0x232D3D),
        border2: Color(hex: 0x2C3848),
        text: Color(hex: 0xE8EDF6),
        text2: Color(hex: 0xC4CEDD),
        muted: Color(hex: 0x8B98AE),
        faint: Color(hex: 0x5A6678),
        accent: Color(hex: 0x1FC7CD),
        accentInk: Color(hex: 0x04181A),
        accentSoft: Color(hex: 0x1FC7CD, alpha: 0.12),
        accentLine: Color(hex: 0x1FC7CD, alpha: 0.34),
        ok: Color(hex: 0x38D39A),
        okSoft: Color(hex: 0x38D39A, alpha: 0.12),
        okLine: Color(hex: 0x38D39A, alpha: 0.32),
        info: Color(hex: 0x5AA6FF),
        infoSoft: Color(hex: 0x5AA6FF, alpha: 0.12),
        infoLine: Color(hex: 0x5AA6FF, alpha: 0.32),
        warn: Color(hex: 0xF5B13D),
        warnSoft: Color(hex: 0xF5B13D, alpha: 0.13),
        warnLine: Color(hex: 0xF5B13D, alpha: 0.34),
        danger: Color(hex: 0xF6757E),
        dangerSoft: Color(hex: 0xF6757E, alpha: 0.12),
        dangerLine: Color(hex: 0xF6757E, alpha: 0.32),
        violet: Color(hex: 0xB08CFF),
        violetSoft: Color(hex: 0xB08CFF, alpha: 0.13),
        violetLine: Color(hex: 0xB08CFF, alpha: 0.32),
        idle: Color(hex: 0x6B788E),
        idleSoft: Color(hex: 0x6B788E, alpha: 0.14),
        idleLine: Color(hex: 0x6B788E, alpha: 0.30),
        isDark: true
    )

    static let light = Palette(
        bg: Color(hex: 0xF3F6FA),
        surface: .white,
        surface2: Color(hex: 0xF5F8FC),
        surface3: Color(hex: 0xEEF3F9),
        raised: .white,
        border: Color(hex: 0xE4EAF2),
        border2: Color(hex: 0xD3DCE8),
        text: Color(hex: 0x0E1722),
        text2: Color(hex: 0x2C3A4D),
        muted: Color(hex: 0x5A6678),
        faint: Color(hex: 0x8794A6),
        accent: Color(hex: 0x0C9AA0),
        accentInk: .white,
        accentSoft: Color(hex: 0x0C9AA0, alpha: 0.10),
        accentLine: Color(hex: 0x0C9AA0, alpha: 0.30),
        ok: Color(hex: 0x11A472),
        okSoft: Color(hex: 0x11A472, alpha: 0.11),
        okLine: Color(hex: 0x11A472, alpha: 0.28),
        info: Color(hex: 0x2F74E6),
        infoSoft: Color(hex: 0x2F74E6, alpha: 0.10),
        infoLine: Color(hex: 0x2F74E6, alpha: 0.26),
        warn: Color(hex: 0xC9871A),
        warnSoft: Color(hex: 0xC9871A, alpha: 0.13),
        warnLine: Color(hex: 0xC9871A, alpha: 0.30),
        danger: Color(hex: 0xD94A55),
        dangerSoft: Color(hex: 0xD94A55, alpha: 0.10),
        dangerLine: Color(hex: 0xD94A55, alpha: 0.26),
        violet: Color(hex: 0x7B54D6),
        violetSoft: Color(hex: 0x7B54D6, alpha: 0.11),
        violetLine: Color(hex: 0x7B54D6, alpha: 0.26),
        idle: Color(hex: 0x768296),
        idleSoft: Color(hex: 0x768296, alpha: 0.13),
        idleLine: Color(hex: 0x768296, alpha: 0.26),
        isDark: false
    )

    /// Resolve for an explicit theme mode; Auto resolves per system in views via
    /// the environment (see `PaletteReader`).
    static func current(_ mode: ThemeMode, systemDark: Bool = true) -> Palette {
        switch mode {
        case .auto: systemDark ? .dark : .light
        case .dark: .dark
        case .light: .light
        }
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}
