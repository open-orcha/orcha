import SwiftUI
import UIKit

/// Global UIKit chrome (navigation + tab bars) for the Linear look: bars in
/// the window colour with a single hairline separator, Inter titles, muted
/// unselected tab items and an accent selection. Colours are dynamic
/// `UIColor`s resolved per trait collection, so Auto/Light/Dark all render
/// correctly without re-applying; a skin change re-applies (new bars pick it up).
@MainActor
enum ChromeAppearance {
    /// Applies Auto/Light/Dark to every window of the app. `.unspecified` hands
    /// control back to the system, and presented sheets follow immediately.
    static func applyInterfaceStyle(_ mode: ThemeMode) {
        let style: UIUserInterfaceStyle = switch mode {
        case .auto: .unspecified
        case .light: .light
        case .dark: .dark
        }
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                window.overrideUserInterfaceStyle = style
            }
        }
    }

    static func apply(skin: SkinMode) {
        let dark = Palette.current(.dark, skin: skin)
        let light = Palette.current(.light, skin: skin)
        func dyn(_ pick: (Palette) -> Color) -> UIColor {
            let d = UIColor(pick(dark)), l = UIColor(pick(light))
            return UIColor { $0.userInterfaceStyle == .dark ? d : l }
        }

        let barBG = dyn(\.bg)
        let hairline = dyn(\.border)
        let text = dyn(\.text)
        let muted = dyn(\.muted)
        let accent = dyn(\.accent)

        // Navigation bar — inline titles 16/semibold, large 28/semibold, tight tracking.
        let nav = UINavigationBarAppearance()
        nav.configureWithOpaqueBackground()
        nav.backgroundColor = barBG
        nav.shadowColor = hairline
        nav.titleTextAttributes = [
            .foregroundColor: text,
            .font: UIFontMetrics(forTextStyle: .headline).scaledFont(for: titleFont(skin, 16, .semibold), maximumPointSize: 22),
            .kern: -0.2,
        ]
        nav.largeTitleTextAttributes = [
            .foregroundColor: text,
            .font: UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: titleFont(skin, 28, .semibold)),
            .kern: -0.5,
        ]
        let plainButton = UIBarButtonItemAppearance(style: .plain)
        plainButton.normal.titleTextAttributes = [.font: titleFont(skin, 15, .medium)]
        nav.buttonAppearance = plainButton

        let scrollEdge = nav.copy()
        scrollEdge.shadowColor = .clear   // hairline appears only once content scrolls under

        let navProxy = UINavigationBar.appearance()
        navProxy.standardAppearance = nav
        navProxy.compactAppearance = nav
        navProxy.scrollEdgeAppearance = scrollEdge
        navProxy.tintColor = accent

        // Tab bar — panel colour, hairline top, muted items, accent selection.
        let tab = UITabBarAppearance()
        tab.configureWithOpaqueBackground()
        tab.backgroundColor = barBG
        tab.shadowColor = hairline
        let itemFont = titleFont(skin, 10, .medium)
        for layout in [tab.stackedLayoutAppearance, tab.inlineLayoutAppearance, tab.compactInlineLayoutAppearance] {
            layout.normal.iconColor = muted
            layout.normal.titleTextAttributes = [.foregroundColor: muted, .font: itemFont]
            layout.selected.iconColor = accent
            layout.selected.titleTextAttributes = [.foregroundColor: accent, .font: itemFont]
            layout.normal.badgeBackgroundColor = accent
        }
        let tabProxy = UITabBar.appearance()
        tabProxy.standardAppearance = tab
        tabProxy.scrollEdgeAppearance = tab
        tabProxy.tintColor = accent
        tabProxy.unselectedItemTintColor = muted

        // Lists / search bars inherit the accent for carets and controls.
        UISearchBar.appearance().tintColor = accent
    }

    /// Dynamic accent for `.tint` — resolves per colour scheme (Auto included).
    static func accent(skin: SkinMode) -> Color {
        let d = UIColor(Palette.current(.dark, skin: skin).accent)
        let l = UIColor(Palette.current(.light, skin: skin).accent)
        return Color(UIColor { $0.userInterfaceStyle == .dark ? d : l })
    }

    private static func titleFont(_ skin: SkinMode, _ size: CGFloat, _ weight: UIFont.Weight) -> UIFont {
        switch skin {
        case .classic:
            return LFont.uiInter(size, weight)
        case .swiss:
            return UIFont(name: "SpaceGrotesk-Medium", size: size) ?? .systemFont(ofSize: size, weight: weight)
        case .minimal:
            let name = weight == .regular ? "HankenGrotesk-Regular" : (weight == .medium ? "HankenGrotesk-Medium" : "HankenGrotesk-SemiBold")
            return UIFont(name: name, size: size) ?? .systemFont(ofSize: size, weight: weight)
        }
    }
}
