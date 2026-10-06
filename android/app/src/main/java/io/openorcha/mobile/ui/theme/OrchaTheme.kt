package io.openorcha.mobile.ui.theme

/** Applies Orcha color, typography, shape, and theme-mode tokens to Compose. */

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
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
    // Linear: filled M3 buttons use the indigo fill (web `--v2-primary-bg`) with a white
    // label; [OrchaPalette.accent] stays the brighter accent *text* colour.
    val fill = p.primaryFill ?: p.accent
    val onFill = if (p.primaryFill != null) Color.White else p.accentInk
    return base.copy(
        primary = fill,
        onPrimary = onFill,
        primaryContainer = p.accentSoft,
        onPrimaryContainer = p.accent,
        inversePrimary = p.accent,
        secondary = p.text2,
        onSecondary = p.bg,
        secondaryContainer = p.surface3,
        onSecondaryContainer = p.text,
        tertiary = p.info,
        background = p.bg,
        onBackground = p.text,
        surface = p.surface,
        onSurface = p.text,
        surfaceVariant = p.surface2,
        onSurfaceVariant = p.muted,
        surfaceContainerLowest = p.bg,
        surfaceContainerLow = p.surface,
        surfaceContainer = p.surface2,
        surfaceContainerHigh = p.surface3,
        surfaceContainerHighest = p.raised,
        surfaceBright = p.raised,
        surfaceDim = p.bg,
        // Flat chrome: no Material elevation tint on cards/sheets/menus.
        surfaceTint = Color.Transparent,
        inverseSurface = p.text,
        inverseOnSurface = p.bg,
        outline = p.border2,
        outlineVariant = p.border,
        scrim = Color.Black.copy(alpha = if (p.isDark) 0.6f else 0.32f),
        error = p.danger,
        onError = Color.White,
        errorContainer = p.dangerSoft,
        onErrorContainer = p.danger,
    )
}

/**
 * Token type scale (tokens `typography.scale`; foundations §3). Inter (bundled) is the
 * base face on every skin; JetBrains Mono falls back
 * to the platform mono stack. `displayFamily` swaps in the skin's bundled display font
 * (Space Grotesk for Swiss, Hanken Grotesk for Minimal) — `null` = Inter (Linear).
 *
 * Linear scale: displaySm 26/600 · titleLg 20/600 · titleMd 16/600 · titleSm 15/500 ·
 * body 15 · bodyMd 13 · label 13/500 · labelSm 11/500 · mono 12 · monoSm 10.5.
 * New code should prefer `ltype(LType.*)` from `ui/components/Linear.kt`.
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
    // Linear scale (web v2 tokens / iOS `LType`): calm weights — nothing heavier than
    // SemiBold — and slightly tight tracking at display sizes.
    return Typography(
        displayLarge = TextStyle(fontFamily = display, fontSize = 32.sp, lineHeight = 38.sp, fontWeight = FontWeight.W600, letterSpacing = (-0.6).sp),
        displayMedium = TextStyle(fontFamily = display, fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.W600, letterSpacing = (-0.5).sp),
        displaySmall = TextStyle(fontFamily = display, fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight.W600, letterSpacing = (-0.5).sp),
        headlineLarge = TextStyle(fontFamily = display, fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.W600, letterSpacing = (-0.4).sp),
        headlineMedium = TextStyle(fontFamily = display, fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.W600, letterSpacing = (-0.3).sp),
        headlineSmall = TextStyle(fontFamily = display, fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.W600, letterSpacing = (-0.3).sp),
        titleLarge = TextStyle(fontFamily = display, fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.W600, letterSpacing = (-0.3).sp),
        titleMedium = TextStyle(fontFamily = display, fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.W600, letterSpacing = (-0.1).sp),
        titleSmall = TextStyle(fontFamily = display, fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.W500, letterSpacing = (-0.1).sp),
        bodyLarge = TextStyle(fontFamily = body, fontSize = 15.sp, lineHeight = 22.sp, fontWeight = FontWeight.W400, letterSpacing = (-0.1).sp),
        bodyMedium = TextStyle(fontFamily = body, fontSize = 13.sp, lineHeight = 19.sp, fontWeight = FontWeight.W400),
        bodySmall = TextStyle(fontFamily = body, fontSize = 12.sp, lineHeight = 17.sp, fontWeight = FontWeight.W400),
        labelLarge = TextStyle(fontFamily = body, fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.W500),
        labelMedium = TextStyle(fontFamily = body, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.W500),
        labelSmall = TextStyle(fontFamily = body, fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight.W500, letterSpacing = 0.1.sp),
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
    extraSmall = RoundedCornerShape(minOf(6f, palette.radiusCard).dp),
    small = RoundedCornerShape(minOf(8f, palette.radiusCard).dp),
    medium = RoundedCornerShape(palette.radiusCard.dp),
    // Linear keeps sheets/dialogs modest (12/14) rather than Material's 16/28.
    large = RoundedCornerShape(maxOf(12f, palette.radiusCard).dp),
    extraLarge = RoundedCornerShape(maxOf(14f, palette.radiusCard).dp),
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
    SystemBarAppearance(lightBars = !palette.isDark)
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

/**
 * Status / navigation bar icon colour follows the *resolved* theme (not the system
 * setting), so a Light override on a dark device still gets dark icons. Bars stay
 * transparent (edge-to-edge); screens paint `p.bg` behind them.
 */
@Composable
private fun SystemBarAppearance(lightBars: Boolean) {
    val view = LocalView.current
    if (view.isInEditMode) return
    SideEffect {
        val window = (view.context as? Activity)?.window ?: return@SideEffect
        WindowCompat.getInsetsController(window, view).apply {
            isAppearanceLightStatusBars = lightBars
            isAppearanceLightNavigationBars = lightBars
        }
    }
}
