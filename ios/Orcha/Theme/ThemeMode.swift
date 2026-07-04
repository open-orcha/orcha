import SwiftUI

/// Portal-equivalent three-way theme setting (foundations §7). Auto follows the system.
enum ThemeMode: String, CaseIterable {
    case auto, light, dark

    var colorScheme: ColorScheme? {
        switch self {
        case .auto: nil
        case .light: .light
        case .dark: .dark
        }
    }

    var label: String { rawValue.capitalized }
}
