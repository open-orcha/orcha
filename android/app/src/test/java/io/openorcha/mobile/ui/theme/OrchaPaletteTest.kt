package io.openorcha.mobile.ui.theme

import androidx.compose.ui.graphics.Color
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `SkinMode` storage-value contract (shared vocabulary with the web/portal —
 * classic|swiss|minimal — and iOS's `SkinMode` raw value) and [paletteFor]
 * completeness across every skin x dark/light combination. Mirrors
 * `ios/OrchaTests/PaletteTests.swift`.
 */
class OrchaPaletteTest {

    @Test
    fun storageValueRoundTripsForEveryCase() {
        for (skin in SkinMode.entries) {
            assertEquals(skin, SkinMode.fromStorageValue(skin.storageValue))
        }
    }

    @Test
    fun minimalStorageValueMatchesTheWebPrefValueExactly() {
        // The web writes/reads the literal scalar "minimal" (mig 040 prefs bag);
        // iOS's SkinMode.minimal.rawValue is the same "minimal" string.
        assertEquals("minimal", SkinMode.Minimal.storageValue)
        assertEquals(SkinMode.Minimal, SkinMode.fromStorageValue("minimal"))
    }

    @Test
    fun unknownStorageValueFallsBackToClassic() {
        assertEquals(SkinMode.Classic, SkinMode.fromStorageValue("bogus"))
        assertEquals(SkinMode.Classic, SkinMode.fromStorageValue(null))
    }

    @Test
    fun everyCaseHasADistinctNonEmptyLabelAndBlurb() {
        val labels = SkinMode.entries.map { it.label }
        assertEquals(SkinMode.entries.size, labels.toSet().size)
        for (skin in SkinMode.entries) {
            assertTrue(skin.label.isNotEmpty())
            assertTrue(skin.blurb.isNotEmpty())
        }
    }

    @Test
    fun minimalDisplaysAsMinimalist() {
        assertEquals("Minimalist", SkinMode.Minimal.label)
    }

    @Test
    fun everySkinResolvesForBothDarkAndLight() {
        for (skin in SkinMode.entries) {
            assertTrue(paletteFor(skin, dark = true).isDark)
            assertTrue(!paletteFor(skin, dark = false).isDark)
        }
    }

    @Test
    fun minimalDarkAndLightAreDistinctPalettesWithCorrectIsDark() {
        assertTrue(OrchaMinimalDarkPalette.isDark)
        assertTrue(!OrchaMinimalLightPalette.isDark)
        assertNotEquals(OrchaMinimalDarkPalette.bg, OrchaMinimalLightPalette.bg)
        assertNotEquals(OrchaMinimalDarkPalette.text, OrchaMinimalLightPalette.text)
    }

    @Test
    fun swissAndMinimalKeepFlatChromeUnlikeClassic() {
        assertTrue(!OrchaDarkPalette.flatChrome)
        assertTrue(!OrchaLightPalette.flatChrome)
        assertTrue(OrchaSwissDarkPalette.flatChrome)
        assertTrue(OrchaSwissLightPalette.flatChrome)
        assertTrue(OrchaMinimalDarkPalette.flatChrome)
        assertTrue(OrchaMinimalLightPalette.flatChrome)
    }

    @Test
    fun swissSquaresCornersAndSetsMonoPills() {
        assertEquals(2f, OrchaSwissDarkPalette.radiusCard)
        assertEquals(2f, OrchaSwissDarkPalette.radiusButton)
        assertEquals(0f, OrchaSwissDarkPalette.radiusTag)
        assertTrue(OrchaSwissDarkPalette.pillMono)
        assertTrue(OrchaSwissLightPalette.pillMono)
    }

    @Test
    fun minimalUsesLargerRadiiThanClassicAndKeepsPillsNonMono() {
        // Web `.card` grows to 18px, `.btn`/`.tag` to 12px under [data-skin="minimal"] —
        // larger radii read as "decluttered", not sharp like Swiss.
        assertTrue(OrchaMinimalDarkPalette.radiusCard > OrchaDarkPalette.radiusCard)
        assertTrue(OrchaMinimalDarkPalette.radiusTag > OrchaDarkPalette.radiusTag)
        assertTrue(!OrchaMinimalDarkPalette.pillMono)
    }

    @Test
    fun classicUsesTheSystemDefaultDisplayFontFamily() {
        assertNull(OrchaDarkPalette.displayFontFamily)
        assertNull(OrchaLightPalette.displayFontFamily)
    }

    @Test
    fun swissRoutesFontsThroughSpaceGrotesk() {
        assertEquals(SpaceGroteskFontFamily, OrchaSwissDarkPalette.displayFontFamily)
        assertEquals(SpaceGroteskFontFamily, OrchaSwissLightPalette.displayFontFamily)
    }

    @Test
    fun minimalRoutesFontsThroughHankenGrotesk() {
        assertEquals(HankenGroteskFontFamily, OrchaMinimalDarkPalette.displayFontFamily)
        assertEquals(HankenGroteskFontFamily, OrchaMinimalLightPalette.displayFontFamily)
    }

    @Test
    fun minimalAccentIsTheChampagneGoldFromTheWebAndIosSkin() {
        assertEquals(Color(0xFFE7C368), OrchaMinimalDarkPalette.accent)
        // Light mode darkens gold for AA text/interactive contrast.
        assertEquals(Color(0xFF96721A), OrchaMinimalLightPalette.accent)
    }

    @Test
    fun swissAccentIsElectricIndigo() {
        assertNotEquals(OrchaDarkPalette.accent, OrchaSwissDarkPalette.accent)
        assertNotEquals(OrchaLightPalette.accent, OrchaSwissLightPalette.accent)
    }

    @Test
    fun diffTokensStayConstantAcrossSkinsMatchingIos() {
        // iOS's Palette carries no per-skin diff tokens at all (unlike the web, which
        // does vary --diff-* per [data-skin]); Android mirrors iOS here deliberately.
        assertEquals(OrchaDarkPalette.diffAdd, OrchaSwissDarkPalette.diffAdd)
        assertEquals(OrchaDarkPalette.diffAdd, OrchaMinimalDarkPalette.diffAdd)
        assertEquals(OrchaDarkPalette.diffDel, OrchaSwissDarkPalette.diffDel)
        assertEquals(OrchaDarkPalette.diffDel, OrchaMinimalDarkPalette.diffDel)
        assertEquals(OrchaDarkPalette.diffHunk, OrchaSwissDarkPalette.diffHunk)
        assertEquals(OrchaDarkPalette.diffHunk, OrchaMinimalDarkPalette.diffHunk)

        assertEquals(OrchaLightPalette.diffAdd, OrchaSwissLightPalette.diffAdd)
        assertEquals(OrchaLightPalette.diffAdd, OrchaMinimalLightPalette.diffAdd)
        assertEquals(OrchaLightPalette.diffDel, OrchaSwissLightPalette.diffDel)
        assertEquals(OrchaLightPalette.diffDel, OrchaMinimalLightPalette.diffDel)
        assertEquals(OrchaLightPalette.diffHunk, OrchaSwissLightPalette.diffHunk)
        assertEquals(OrchaLightPalette.diffHunk, OrchaMinimalLightPalette.diffHunk)
    }

    @Test
    fun classicPaletteDefaultsAreUnchanged() {
        // Regression guard: the shipped classic look keeps its original radii/flags.
        assertEquals(12f, OrchaDarkPalette.radiusCard)
        assertEquals(12f, OrchaDarkPalette.radiusButton)
        assertEquals(5f, OrchaDarkPalette.radiusTag)
        assertTrue(!OrchaDarkPalette.pillMono)
        assertTrue(!OrchaDarkPalette.flatChrome)
    }

    @Test
    fun classicSkinIsTheDefaultAndResolvesToLinear() {
        // iOS parity: the classic slot is the Linear skin (label "Linear").
        assertEquals("Linear", SkinMode.Classic.label)
        assertEquals("classic", SkinMode.Classic.storageValue)
        assertEquals(OrchaLinearDarkPalette, paletteFor(SkinMode.Classic, dark = true))
        assertEquals(OrchaLinearLightPalette, paletteFor(SkinMode.Classic, dark = false))
    }

    @Test
    fun linearPalettesCarryTheContractHexes() {
        val d = OrchaLinearDarkPalette
        assertEquals(Color(0xFF0E0F10), d.bg)
        assertEquals(Color(0xFF151618), d.surface)
        assertEquals(Color(0xFF1C1D21), d.surface2)
        assertEquals(Color(0xFF1E1F23), d.raised)
        assertEquals(Color(0xFF25262A), d.border)
        assertEquals(Color(0xFF33353A), d.border2)
        assertEquals(Color(0xFFEEEFF1), d.text)
        assertEquals(Color(0xFFB4B7BE), d.text2)
        assertEquals(Color(0xFF8A8F98), d.muted)
        assertEquals(Color(0xFF82868D), d.faint)
        assertEquals(Color(0xFF8D93F7), d.accent)
        assertEquals(Color(0xFF5E6AD2), d.primaryFill)
        assertEquals(Color(0xFF4CB782), d.ok)
        assertEquals(Color(0xFFE2A336), d.warn)
        assertEquals(Color(0xFFEE7070), d.danger)

        val l = OrchaLinearLightPalette
        assertEquals(Color(0xFFF4F4F5), l.bg)
        assertEquals(Color(0xFFFFFFFF), l.surface)
        assertEquals(Color(0xFFF7F7F8), l.surface2)
        assertEquals(Color(0xFFE6E6E9), l.border)
        assertEquals(Color(0xFFD5D6DA), l.border2)
        assertEquals(Color(0xFF1C1D1F), l.text)
        assertEquals(Color(0xFF4E525A), l.text2)
        assertEquals(Color(0xFF62666E), l.muted)
        assertEquals(Color(0xFF6D7077), l.faint)
        assertEquals(Color(0xFF505AC9), l.accent)
        assertEquals(Color(0xFF5E6AD2), l.primaryFill)
    }

    @Test
    fun linearIsFlatInterAndTenRadius() {
        for (p in listOf(OrchaLinearDarkPalette, OrchaLinearLightPalette)) {
            assertTrue(p.flatChrome)
            assertEquals(Color.Transparent, p.bgGrad1)
            assertEquals(Color.Transparent, p.bgGrad2)
            assertEquals(10f, p.radiusCard)
            assertEquals(7f, p.radiusButton)
            assertTrue(!p.pillMono)
            assertNull(p.displayFontFamily) // null = Inter (the base face)
        }
        assertTrue(OrchaLinearDarkPalette.isDark)
        assertTrue(!OrchaLinearLightPalette.isDark)
    }

    @Test
    fun onlyLinearCarriesASeparatePrimaryFill() {
        assertNull(OrchaSwissDarkPalette.primaryFill)
        assertNull(OrchaMinimalDarkPalette.primaryFill)
        assertNull(OrchaDarkPalette.primaryFill)
    }
}
