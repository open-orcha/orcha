package io.openorcha.mobile.ui.theme

/** Applies Orcha color, typography, shape, and theme-mode tokens to Compose. */

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val LocalOrchaPalette = staticCompositionLocalOf { OrchaDarkPalette }

/** `Orcha.palette` — the full token palette for the active theme + skin. */
object Orcha {
    val palette: OrchaPalette
        @Composable get() = LocalOrchaPalette.current
}

/** Three-way theme setting, portal-equivalent (foundations §7). Auto = follow system. */
enum class ThemeMode { Auto, Light, Dark }

private fun schemeFor(p: OrchaPalette): ColorScheme {
    val base = if (p.isDark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = p.accent,
        onPrimary = p.accentInk,
        primaryContainer = p.accentSoft,
        onPrimaryContainer = p.accent,
        secondary = p.info,
        background = p.bg,
        onBackground = p.text,
        surface = p.surface,
        onSurface = p.text,
        surfaceVariant = p.surface2,
        onSurfaceVariant = p.muted,
        surfaceContainer = p.surface2,
        surfaceContainerHigh = p.surface3,
        surfaceContainerHighest = p.raised,
        outline = p.border2,
        outlineVariant = p.border,
        error = p.danger,
    )
}

/**
 * Token type scale (tokens `typography.scale`; foundations §3). Inter (bundled) is the
 * base face on every skin; JetBrains Mono falls back
 * to the platform mono stack. `displayFamily` swaps in the skin's bundled display font
 * (Space Grotesk for Swiss, Hanken Grotesk for Minimal) — `null` keeps the platform
 * default for Classic, matching iOS's `uiFont` fallback to `.system`.
 *
 * displaySm 24/800 · titleLg 20/750 · titleMd 17/700 · titleSm 15/650 · body 15 ·
 * bodySm 13 · label 12/650 (+.2) · overline 11/700 (+.8, uppercase at call sites) ·
 * mono 12 · monoSm 10.5
 */
private fun orchaTypography(displayFamily: FontFamily?): Typography {
    // Web parity: a skin's face applies to EVERYTHING, not just headings —
    // `html[data-skin=swiss] body { font-family: "Space Grotesk" }` and
    // skin-minimal set the whole body; base tokens.css uses Inter. Splitting
    // display/body faces here left Swiss/Minimal detail text on Inter while
    // headers switched ("header respects my fonts but not the details").
    val display = displayFamily ?: InterFontFamily
    val body = displayFamily ?: InterFontFamily
    // Every M3 slot is overridden: an unset slot keeps Material's Roboto default,
    // which leaks through components that style themselves (AlertDialog titles use
    // headlineSmall, several widgets use bodySmall) — the "wrong font" bug class.
    return Typography(
        displayLarge = TextStyle(fontFamily = display, fontSize = 34.sp, lineHeight = 40.sp, fontWeight = FontWeight.W800, letterSpacing = (-0.5).sp),
        displayMedium = TextStyle(fontFamily = display, fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.W800, letterSpacing = (-0.4).sp),
        displaySmall = TextStyle(fontFamily = display, fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.W800, letterSpacing = (-0.4).sp),
        headlineLarge = TextStyle(fontFamily = display, fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight.W700, letterSpacing = (-0.3).sp),
        headlineMedium = TextStyle(fontFamily = display, fontSize = 23.sp, lineHeight = 29.sp, fontWeight = FontWeight.W700, letterSpacing = (-0.3).sp),
        headlineSmall = TextStyle(fontFamily = display, fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.W700, letterSpacing = (-0.3).sp),
        titleLarge = TextStyle(fontFamily = display, fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.W700, letterSpacing = (-0.3).sp),
        titleMedium = TextStyle(fontFamily = display, fontSize = 17.sp, lineHeight = 23.sp, fontWeight = FontWeight.W700, letterSpacing = (-0.2).sp),
        titleSmall = TextStyle(fontFamily = display, fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.W600),
        bodyLarge = TextStyle(fontFamily = body, fontSize = 15.sp, lineHeight = 22.sp, fontWeight = FontWeight.W400),
        bodyMedium = TextStyle(fontFamily = body, fontSize = 13.sp, lineHeight = 19.sp, fontWeight = FontWeight.W400),
        bodySmall = TextStyle(fontFamily = body, fontSize = 12.sp, lineHeight = 17.sp, fontWeight = FontWeight.W400),
        labelLarge = TextStyle(fontFamily = body, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.W600, letterSpacing = 0.2.sp),
        labelMedium = TextStyle(fontFamily = body, fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight.W700, letterSpacing = 0.8.sp),
        labelSmall = TextStyle(fontFamily = body, fontSize = 10.5.sp, lineHeight = 14.sp, fontWeight = FontWeight.W700, letterSpacing = 0.5.sp),
    )
}

/**
 * Radii family per skin (tokens `radius`, iOS `Palette` skin traits parity):
 * Classic sm 8 · md 12(card/button) · lg 16 · xl 22, tag 5 (`radiusTag`, applied at
 * call sites like `MetaTag`, not part of the M3 [Shapes] scale). Swiss sharpens to
 * near-zero; Minimal grows card/button/tag per the web's decluttered direction. Only
 * `medium` (card/button) tracks `radiusCard`/`radiusButton` — `small`/`large`/`extraLarge`
 * stay the fixed 8/16/22 scale on all three skins, same as iOS (which only exposes
 * `radiusCard`/`radiusButton`/`radiusTag`, not a full alternate scale).
 */
private fun orchaShapes(palette: OrchaPalette): Shapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(palette.radiusCard.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(22.dp),
)

val MonoFontFamily: FontFamily = FontFamily.Monospace

/** Mono text styles (log lines, ids, model tags): `mono 12` / `monoSm 10.5`. */
val MonoStyle = TextStyle(fontFamily = MonoFontFamily, fontSize = 12.sp, lineHeight = 18.sp)
val MonoSmStyle = TextStyle(fontFamily = MonoFontFamily, fontSize = 10.5.sp, lineHeight = 15.sp)

@Composable
fun OrchaTheme(mode: ThemeMode = ThemeMode.Auto, skin: SkinMode = SkinMode.Classic, content: @Composable () -> Unit) {
    val dark = when (mode) {
        ThemeMode.Auto -> isSystemInDarkTheme()
        ThemeMode.Dark -> true
        ThemeMode.Light -> false
    }
    val palette = paletteFor(skin, dark)
    CompositionLocalProvider(LocalOrchaPalette provides palette) {
        MaterialTheme(
            colorScheme = schemeFor(palette),
            typography = orchaTypography(palette.displayFontFamily),
            shapes = orchaShapes(palette),
        ) {
            // Screens paint the skin gradient themselves and use transparent
            // Scaffolds, so nothing sets LocalContentColor — it stays the
            // default black, and every color-less Text vanishes in dark mode.
            // Anchor it to the palette's text color; M3 components that manage
            // their own content colors are unaffected.
            CompositionLocalProvider(LocalContentColor provides palette.text, content = content)
        }
    }
}
