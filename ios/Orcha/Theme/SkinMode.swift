import SwiftUI

/// Portal-equivalent design pick (the portal's Settings → Appearance card,
/// localStorage "orcha:skin"): Classic is the shipped teal look; Swiss is the
/// sharp indigo direction (Space Grotesk + mono chips on the web). Orthogonal
/// to `ThemeMode` — dark/light/auto keeps working on both.
enum SkinMode: String, CaseIterable {
    case classic, swiss

    var label: String {
        switch self {
        case .classic: "Classic"
        case .swiss: "Swiss"
        }
    }

    var blurb: String {
        switch self {
        case .classic: "Teal accent, rounded corners — the original Orcha look."
        case .swiss: "Electric indigo, sharp corners, mono status chips."
        }
    }
}
