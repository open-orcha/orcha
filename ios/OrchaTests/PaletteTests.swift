import Foundation
import SwiftUI
import Testing
import UIKit
@testable import Orcha

/// `SkinMode` raw-value contract (shared vocabulary with the web/portal —
/// classic|swiss|minimal, exactly the iOS raw values) and `Palette.current`
/// completeness across every skin × theme-mode combination.

@Suite struct SkinModeTests {

    @Test func rawValueRoundTripsForEveryCase() {
        for skin in SkinMode.allCases {
            #expect(SkinMode(rawValue: skin.rawValue) == skin)
        }
    }

    @Test func minimalRawValueMatchesTheWebPrefValueExactly() {
        // The web writes/reads the literal scalar "minimal" (mig 040 prefs bag).
        #expect(SkinMode.minimal.rawValue == "minimal")
        #expect(SkinMode(rawValue: "minimal") == .minimal)
    }

    @Test func everyCaseHasADistinctNonEmptyLabelAndBlurb() {
        let labels = SkinMode.allCases.map(\.label)
        #expect(Set(labels).count == SkinMode.allCases.count)
        for skin in SkinMode.allCases {
            #expect(!skin.label.isEmpty)
            #expect(!skin.blurb.isEmpty)
        }
    }

    @Test func minimalDisplaysAsMinimalist() {
        #expect(SkinMode.minimal.label == "Minimalist")
    }
}

@Suite struct PaletteCompletenessTests {

    @Test func everySkinResolvesForBothThemeModesInBothColorSchemes() {
        for skin in SkinMode.allCases {
            for mode in [ThemeMode.dark, .light] {
                for systemDark in [true, false] {
                    let p = Palette.current(mode, skin: skin, systemDark: systemDark)
                    #expect(p.isDark == (mode == .dark))
                }
            }
            // Auto: follows the system flag, both directions.
            #expect(Palette.current(.auto, skin: skin, systemDark: true).isDark)
            #expect(!Palette.current(.auto, skin: skin, systemDark: false).isDark)
        }
    }

    @Test func minimalDarkAndLightAreDistinctPalettesWithCorrectIsDark() {
        #expect(Palette.minimalDark.isDark)
        #expect(!Palette.minimalLight.isDark)
        #expect(Palette.minimalDark.bg != Palette.minimalLight.bg)
        #expect(Palette.minimalDark.text != Palette.minimalLight.text)
    }

    @Test func minimalKeepsFlatChromeLikeSwiss() {
        // Declutter brief: flat elevation, no brand radial glow — same
        // `flatChrome` gate `OrchaThemed` already uses for Swiss.
        #expect(Palette.minimalDark.flatChrome)
        #expect(Palette.minimalLight.flatChrome)
    }

    @Test func minimalRoutesFontsThroughBundledHankenGroteskNotDisplayFamily() {
        // Minimal uses `displayFacesByWeight` (bundled static Hanken Grotesk
        // cuts), not the single-family `displayFamily` path Swiss uses for
        // Space Grotesk — the variable Hanken font can't reliably drive
        // weight through `Font.custom(_:).weight()` on iOS (see Palette.swift).
        #expect(Palette.minimalDark.displayFamily == nil)
        #expect(Palette.minimalLight.displayFamily == nil)
        #expect(Palette.minimalDark.displayFacesByWeight == Palette.hankenGroteskFacesByWeight)
        #expect(Palette.minimalLight.displayFacesByWeight == Palette.hankenGroteskFacesByWeight)
    }

    @Test func minimalUsesLargerRadiiThanClassicPerWebParity() {
        // Web `.card` grows to 18px, `.btn`/`.tag` to 12px under
        // [data-skin="minimal"] — larger radii read as "decluttered", not sharp
        // like Swiss (which shrinks to near-zero).
        #expect(Palette.minimalDark.radiusCard > Palette.dark.radiusCard)
        #expect(Palette.minimalDark.radiusTag > Palette.dark.radiusTag)
        #expect(!Palette.minimalDark.pillMono)
    }

    @Test func minimalAccentIsTheChampagneGoldFromTheWebSkin() {
        #expect(Palette.minimalDark.accent == Color(hex: 0xE7C368))
        // Light mode darkens gold for AA text/interactive contrast.
        #expect(Palette.minimalLight.accent == Color(hex: 0x96721A))
    }
}

/// Hanken Grotesk bundling (font parity with web, Minimalist skin only —
/// classic/swiss/mono surfaces are untouched). `UIAppFonts` in Info.plist
/// registers the bundled static TTF cuts at process launch, so if bundling
/// broke (missing file, bad Info.plist entry, wrong PostScript name)
/// `UIFont(name:size:)` returns nil here exactly as it would in the app.
@Suite struct HankenGroteskFontTests {

    @Test func everyBundledFaceResolvesAsARegisteredUIFont() {
        for (_, postScriptName) in Palette.hankenGroteskFacesByWeight {
            #expect(UIFont(name: postScriptName, size: 15) != nil, "\(postScriptName) did not register")
        }
    }

    @Test func regularAndBoldResolveToDistinctRegisteredFonts() {
        let regular = UIFont(name: "Hanken Grotesk", size: 15)
        let bold = UIFont(name: "Hanken Grotesk Bold", size: 15)
        #expect(regular != nil)
        #expect(bold != nil)
        #expect(regular?.fontName != bold?.fontName)
    }

    @Test func semiboldResolvesToARegisteredFontDistinctFromRegular() {
        let regular = UIFont(name: "Hanken Grotesk", size: 15)
        let semibold = UIFont(name: "Hanken Grotesk SemiBold", size: 15)
        #expect(semibold != nil)
        #expect(regular?.fontName != semibold?.fontName)
    }

    @Test func onlyMinimalExposesDisplayFacesByWeight() {
        #expect(Palette.dark.displayFacesByWeight == nil)
        #expect(Palette.light.displayFacesByWeight == nil)
        #expect(Palette.swissDark.displayFacesByWeight == nil)
        #expect(Palette.swissLight.displayFacesByWeight == nil)
        #expect(Palette.minimalDark.displayFacesByWeight != nil)
        #expect(Palette.minimalLight.displayFacesByWeight != nil)
    }

    @Test func classicAndSwissUiFontNeverProducesAHankenGroteskFace() {
        // Regression guard: classic stays system font, Swiss stays Space
        // Grotesk — neither skin should route through Hanken Grotesk.
        let classicFont = Palette.dark.uiFont(15, .bold)
        let swissFont = Palette.swissDark.uiFont(15, .bold)
        #expect(classicFont != Font.custom("Hanken Grotesk Bold", size: 15))
        #expect(swissFont != Font.custom("Hanken Grotesk Bold", size: 15))
    }

    @Test func minimalUiFontPicksTheClosestBundledWeightWithoutSyntheticBold() {
        // `.heavy` (800) has no dedicated cut — it should fall back to the
        // Bold (700) face rather than SwiftUI applying synthetic emboldening
        // on top of a mismatched face.
        #expect(Palette.hankenGroteskFacesByWeight[.heavy] == Palette.hankenGroteskFacesByWeight[.bold])
    }

    @Test func minimalUiFontRegularWeightMatchesTheBundledRegularFace() {
        let font = Palette.minimalDark.uiFont(15)
        #expect(font == Font.custom("Hanken Grotesk", size: 15))
    }

    @Test func minimalUiFontBoldWeightMatchesTheBundledBoldFace() {
        let font = Palette.minimalDark.uiFont(15, .bold)
        #expect(font == Font.custom("Hanken Grotesk Bold", size: 15))
    }
}
