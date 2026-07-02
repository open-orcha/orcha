package io.openorcha.mobile.ui.theme

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

/**
 * Orcha design tokens (docs/design/mobile/tokens/orcha-mobile-tokens.json v1.0.0).
 *
 * Every value is mapped 1:1 from the token file — which is itself mapped 1:1 from the
 * portal stylesheet — so portal, Android, and iOS share one visual language. Do not
 * invent colors here; change the token file and propagate.
 *
 * The full palette (including the *Soft / *Line badge variants and the two brand
 * background gradients) lives on [OrchaPalette], exposed via [Orcha.palette]. The
 * Material 3 [ColorScheme] is filled per the token file's `platformMapping` so stock
 * M3 components pick up the right roles.
 */
@Immutable
data class OrchaPalette(
    val bg: Color,
    val bgGrad1: Color,
    val bgGrad2: Color,
    val surface: Color,
    val surface2: Color,
    val surface3: Color,
    val raised: Color,
    val border: Color,
    val border2: Color,
    val text: Color,
    val text2: Color,
    val muted: Color,
    val faint: Color,
    val accent: Color,
    val accentInk: Color,
    val accentSoft: Color,
    val accentLine: Color,
    val accentGlow: Color,
    val ok: Color,
    val okSoft: Color,
    val okLine: Color,
    val info: Color,
    val infoSoft: Color,
    val infoLine: Color,
    val warn: Color,
    val warnSoft: Color,
    val warnLine: Color,
    val danger: Color,
    val dangerSoft: Color,
    val dangerLine: Color,
    val violet: Color,
    val violetSoft: Color,
    val violetLine: Color,
    val idle: Color,
    val idleSoft: Color,
    val idleLine: Color,
    val diffAdd: Color,
    val diffAddBg: Color,
    val diffDel: Color,
    val diffDelBg: Color,
    val diffHunk: Color,
    val diffHunkBg: Color,
    val isDark: Boolean,
)

val OrchaDarkPalette = OrchaPalette(
    bg = Color(0xFF0A0D12),
    bgGrad1 = Color(0x0E15C0C6),          // rgba(21,192,198,.055)
    bgGrad2 = Color(0x0B7D91FF),          // rgba(125,145,255,.045)
    surface = Color(0xFF111620),
    surface2 = Color(0xFF161D29),
    surface3 = Color(0xFF1C2532),
    raised = Color(0xFF1A2230),
    border = Color(0xFF232D3D),
    border2 = Color(0xFF2C3848),
    text = Color(0xFFE8EDF6),
    text2 = Color(0xFFC4CEDD),
    muted = Color(0xFF8B98AE),
    faint = Color(0xFF5A6678),
    accent = Color(0xFF1FC7CD),
    accentInk = Color(0xFF04181A),
    accentSoft = Color(0x1F1FC7CD),       // .12
    accentLine = Color(0x571FC7CD),       // .34
    accentGlow = Color(0x381FC7CD),       // .22
    ok = Color(0xFF38D39A),
    okSoft = Color(0x1F38D39A),
    okLine = Color(0x5238D39A),
    info = Color(0xFF5AA6FF),
    infoSoft = Color(0x1F5AA6FF),
    infoLine = Color(0x525AA6FF),
    warn = Color(0xFFF5B13D),
    warnSoft = Color(0x21F5B13D),
    warnLine = Color(0x57F5B13D),
    danger = Color(0xFFF6757E),
    dangerSoft = Color(0x1FF6757E),
    dangerLine = Color(0x52F6757E),
    violet = Color(0xFFB08CFF),
    violetSoft = Color(0x21B08CFF),
    violetLine = Color(0x52B08CFF),
    idle = Color(0xFF6B788E),
    idleSoft = Color(0x246B788E),
    idleLine = Color(0x4D6B788E),
    diffAdd = Color(0xFF8FE3A8),
    diffAddBg = Color(0x1A38D39A),
    diffDel = Color(0xFFF6909A),
    diffDelBg = Color(0x1AF6757E),
    diffHunk = Color(0xFF5AA6FF),
    diffHunkBg = Color(0x125AA6FF),
    isDark = true,
)

val OrchaLightPalette = OrchaPalette(
    bg = Color(0xFFF3F6FA),
    bgGrad1 = Color(0x1215C0C6),          // .07
    bgGrad2 = Color(0x0F7D91FF),          // .06
    surface = Color(0xFFFFFFFF),
    surface2 = Color(0xFFF5F8FC),
    surface3 = Color(0xFFEEF3F9),
    raised = Color(0xFFFFFFFF),
    border = Color(0xFFE4EAF2),
    border2 = Color(0xFFD3DCE8),
    text = Color(0xFF0E1722),
    text2 = Color(0xFF2C3A4D),
    muted = Color(0xFF5A6678),
    faint = Color(0xFF8794A6),
    accent = Color(0xFF0C9AA0),
    accentInk = Color(0xFFFFFFFF),
    accentSoft = Color(0x1A0C9AA0),       // .10
    accentLine = Color(0x4D0C9AA0),       // .30
    accentGlow = Color(0x2E0C9AA0),       // .18
    ok = Color(0xFF11A472),
    okSoft = Color(0x1C11A472),
    okLine = Color(0x4711A472),
    info = Color(0xFF2F74E6),
    infoSoft = Color(0x1A2F74E6),
    infoLine = Color(0x422F74E6),
    warn = Color(0xFFC9871A),
    warnSoft = Color(0x21C9871A),
    warnLine = Color(0x4DC9871A),
    danger = Color(0xFFD94A55),
    dangerSoft = Color(0x1AD94A55),
    dangerLine = Color(0x42D94A55),
    violet = Color(0xFF7B54D6),
    violetSoft = Color(0x1C7B54D6),
    violetLine = Color(0x427B54D6),
    idle = Color(0xFF768296),
    idleSoft = Color(0x21768296),
    idleLine = Color(0x42768296),
    diffAdd = Color(0xFF1C7A4A),
    diffAddBg = Color(0x1F11A472),
    diffDel = Color(0xFFC43D48),
    diffDelBg = Color(0x1AD94A55),
    diffHunk = Color(0xFF2F74E6),
    diffHunkBg = Color(0x142F74E6),
    isDark = false,
)

val LocalOrchaPalette = staticCompositionLocalOf { OrchaDarkPalette }

/** Transitional alias while screens migrate to [Orcha.palette] — dark values only. */
@Deprecated("Use Orcha.palette (theme-aware) instead")
object OrchaColors {
    val Bg = OrchaDarkPalette.bg
    val Surface = OrchaDarkPalette.surface
    val Surface2 = OrchaDarkPalette.surface2
    val Surface3 = OrchaDarkPalette.surface3
    val Border = OrchaDarkPalette.border
    val Border2 = OrchaDarkPalette.border2
    val Text = OrchaDarkPalette.text
    val Text2 = OrchaDarkPalette.text2
    val Muted = OrchaDarkPalette.muted
    val Faint = OrchaDarkPalette.faint
    val Accent = OrchaDarkPalette.accent
    val AccentInk = OrchaDarkPalette.accentInk
    val Ok = OrchaDarkPalette.ok
    val Info = OrchaDarkPalette.info
    val Warn = OrchaDarkPalette.warn
    val Danger = OrchaDarkPalette.danger
    val Violet = OrchaDarkPalette.violet
    val Idle = OrchaDarkPalette.idle
}

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
