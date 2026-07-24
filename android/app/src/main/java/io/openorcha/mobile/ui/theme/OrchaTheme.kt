package io.openorcha.mobile.ui.theme

/** Applies Orcha color, typography, shape, and theme-mode tokens to Compose. */

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
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

/** `Orcha.palette` — the full token palette for the active theme. */
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
 * Token type scale (tokens `typography.scale`; foundations §3). Platform system sans
 * (Roboto) stands in for Inter per the token fallback note; JetBrains Mono falls back
 * to the platform mono stack.
 *
 * displaySm 24/800 · titleLg 20/750 · titleMd 17/700 · titleSm 15/650 · body 15 ·
 * bodySm 13 · label 12/650 (+.2) · overline 11/700 (+.8, uppercase at call sites) ·
 * mono 12 · monoSm 10.5
 */
private val OrchaTypography = Typography(
    displaySmall = TextStyle(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.W800, letterSpacing = (-0.4).sp),
    titleLarge = TextStyle(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.W700, letterSpacing = (-0.3).sp),
    titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 23.sp, fontWeight = FontWeight.W700, letterSpacing = (-0.2).sp),
    titleSmall = TextStyle(fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.W600),
    bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 22.sp, fontWeight = FontWeight.W400),
    bodyMedium = TextStyle(fontSize = 13.sp, lineHeight = 19.sp, fontWeight = FontWeight.W400),
    labelLarge = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.W600, letterSpacing = 0.2.sp),
    labelMedium = TextStyle(fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight.W700, letterSpacing = 0.8.sp),
    labelSmall = TextStyle(fontSize = 10.5.sp, lineHeight = 14.sp, fontWeight = FontWeight.W700, letterSpacing = 0.5.sp),
)

/** Radii family (tokens `radius`): sm 8 · md 12 · lg 16 · xl 22. Pills use full rounding. */
private val OrchaShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(22.dp),
)

val MonoFontFamily: FontFamily = FontFamily.Monospace

/** Mono text styles (log lines, ids, model tags): `mono 12` / `monoSm 10.5`. */
val MonoStyle = TextStyle(fontFamily = MonoFontFamily, fontSize = 12.sp, lineHeight = 18.sp)
val MonoSmStyle = TextStyle(fontFamily = MonoFontFamily, fontSize = 10.5.sp, lineHeight = 15.sp)

@Composable
fun OrchaTheme(mode: ThemeMode = ThemeMode.Auto, content: @Composable () -> Unit) {
    val dark = when (mode) {
        ThemeMode.Auto -> isSystemInDarkTheme()
        ThemeMode.Dark -> true
        ThemeMode.Light -> false
    }
    val palette = if (dark) OrchaDarkPalette else OrchaLightPalette
    CompositionLocalProvider(LocalOrchaPalette provides palette) {
        MaterialTheme(
            colorScheme = schemeFor(palette),
            typography = OrchaTypography,
            shapes = OrchaShapes,
            content = content,
        )
    }
}
