import Foundation
import Testing
@testable import Orcha

/// The pure prefs-sync mapping (mig 040): server wins on read, whole-bag-safe
/// merge on write, shared value vocabulary with the web (auto|light|dark,
/// classic|swiss — exactly the iOS raw values).

@Suite struct PrefsSyncResolveTests {

    @Test func validThemeAndSkinResolve() {
        #expect(PrefsSync.resolveTheme(["theme": "dark"]) == .dark)
        #expect(PrefsSync.resolveTheme(["theme": "auto"]) == .auto)
        #expect(PrefsSync.resolveSkin(["skin": "swiss"]) == .swiss)
        #expect(PrefsSync.resolveSkin(["skin": "classic"]) == .classic)
    }

    @Test func webSetMinimalPrefResolvesOnIOS() {
        // A web-set "minimal" pref (mig 040 bag) must apply on iOS without any
        // extra mapping — SkinMode's raw value IS the wire value.
        #expect(PrefsSync.resolveSkin(["skin": "minimal"]) == .minimal)
    }

    @Test func missingKeysResolveToNil() {
        #expect(PrefsSync.resolveTheme([:]) == nil)
        #expect(PrefsSync.resolveSkin(["theme": "dark"]) == nil)
    }

    @Test func unknownValuesAreIgnoredNeverApplied() {
        // A future web-only skin must not clobber a working local setting.
        #expect(PrefsSync.resolveTheme(["theme": "solarized"]) == nil)
        #expect(PrefsSync.resolveSkin(["skin": "brutalist"]) == nil)
    }

    @Test func nonStringValuesAreIgnored() {
        #expect(PrefsSync.resolveTheme(["theme": 3]) == nil)
        #expect(PrefsSync.resolveSkin(["skin": true]) == nil)
    }
}

@Suite struct PrefsSyncMergeTests {

    @Test func mergePreservesKeysTheAppDoesNotManage() {
        // Whole-bag replace server-side: dropping sidebar/default_cid would unset
        // them for the web — the merge must carry them through.
        let bag = PrefsSync.mergedBag(
            ["theme": "light", "sidebar": "collapsed", "default_cid": "abc"],
            theme: .dark, skin: .swiss
        )
        #expect(bag["theme"] as? String == "dark")
        #expect(bag["skin"] as? String == "swiss")
        #expect(bag["sidebar"] as? String == "collapsed")
        #expect(bag["default_cid"] as? String == "abc")
    }

    @Test func mergeFromAnEmptyOrAbsentBagWritesJustTheAppKeys() {
        let bag = PrefsSync.mergedBag(nil, theme: .auto, skin: .classic)
        #expect(bag.count == 2)
        #expect(bag["theme"] as? String == "auto")
        #expect(bag["skin"] as? String == "classic")
    }

    @Test func iOSSetMinimalSyncsBackToTheWebWireValue() {
        // An iOS-side pick of Minimalist must PUT the same "minimal" scalar
        // the web reads back — round-trip parity, not a translated id.
        let bag = PrefsSync.mergedBag(nil, theme: .dark, skin: .minimal)
        #expect(bag["skin"] as? String == "minimal")
        #expect(PrefsSync.resolveSkin(bag) == .minimal)
    }
}
