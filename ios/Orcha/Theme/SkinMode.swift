import SwiftUI

/// Portal-equivalent design pick (the portal's Settings → Appearance card,
/// localStorage "orcha:skin"): Classic is the shipped teal look; Swiss is the
/// sharp indigo direction (Space Grotesk + mono chips on the web); Minimal is
/// the decluttered gold direction (Hanken Grotesk, bundled + font-matched to
/// the web — see `Palette.applyMinimalTraits`). Orthogonal to `ThemeMode` —
/// dark/light/auto keeps working on all three.
enum SkinMode: String, CaseIterable {
    case classic, swiss, minimal

    var label: String {
        switch self {
        case .classic: "Linear"
        case .swiss: "Swiss"
        case .minimal: "Minimalist"
        }
    }

    var blurb: String {
        switch self {
        case .classic: "Calm near-black and paper surfaces, indigo accent, Inter — matches the web portal."
        case .swiss: "Electric indigo, sharp corners, mono status chips."
        case .minimal: "Champagne gold accent, generous whitespace, quieter chrome."
        }
    }
}
