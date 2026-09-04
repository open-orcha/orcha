package io.openorcha.mobile.ui.theme

/** Defines the shared light and dark Orcha color-token palettes, per skin. */
import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily

/**
 * Three-way design pick, portal-equivalent (Settings → Appearance card,
 * localStorage "orcha:skin") and iOS-equivalent (`SkinMode`): Classic is the
 * shipped teal look; Swiss is the sharp indigo direction (Space Grotesk + mono
 * status chips); Minimal is the decluttered gold direction (Hanken Grotesk).
 * Orthogonal to [ThemeMode] — dark/light/auto keeps working on all three.
 */
enum class SkinMode {
    Classic, Swiss, Minimal;

    val label: String
        get() = when (this) {
            Classic -> "Classic"
            Swiss -> "Swiss"
            Minimal -> "Minimalist"
        }

    val blurb: String
        get() = when (this) {
            Classic -> "Teal accent, rounded corners — the original Orcha look."
            Swiss -> "Electric indigo, sharp corners, mono status chips."
            Minimal -> "Champagne gold accent, generous whitespace, quieter chrome."
        }

    /** The literal scalar this skin persists as (parity with the web prefs bag / iOS raw value). */
    val storageValue: String
        get() = when (this) {
            Classic -> "classic"
            Swiss -> "swiss"
            Minimal -> "minimal"
        }

    companion object {
        fun fromStorageValue(value: String?): SkinMode = when (value) {
            "swiss" -> Swiss
            "minimal" -> Minimal
            else -> Classic
        }
    }
}

/**
 * Orcha design tokens (docs/design/mobile/tokens/orcha-mobile-tokens.json v1.0.0).
 *
 * Every value is mapped 1:1 from the token file — which is itself mapped 1:1 from the
 * portal stylesheet and iOS `Palette.swift` — so portal, Android, and iOS share one
 * visual language. Do not invent colors here; change the token file and propagate.
 *
 * The full palette (including the *Soft / *Line badge variants and the two brand
 * background gradients) lives on [OrchaPalette], exposed via [Orcha.palette]. The
 * Material 3 [androidx.compose.material3.ColorScheme] is filled per the token file's
 * `platformMapping` so stock M3 components pick up the right roles.
 *
 * Skin traits (portal `[data-skin]` / iOS `Palette` parity) ride alongside the colors:
 * Classic keeps the shipped geometry; Swiss squares everything off and sets status text
 * in mono; Minimal grows radii and quiets the chrome. `diffAdd`/`diffDel`/`diffHunk` are
 * deliberately held constant across skins — iOS's `Palette` carries no per-skin diff
 * tokens at all, so Android mirrors that rather than the web's per-skin diff variants.
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
    // Skin traits (portal [data-skin] / iOS Palette parity). Classic keeps the shipped
    // geometry; Swiss squares everything off and sets status text in mono; Minimal grows
    // radii and quiets the chrome.
    val radiusCard: Float = 12f,
    val radiusButton: Float = 12f,
    val radiusTag: Float = 5f,
    val pillMono: Boolean = false,
    val flatChrome: Boolean = false,   // Swiss + Minimal: no brand radial glow behind content
    val displayFontFamily: FontFamily? = null,   // Swiss: Space Grotesk; Minimal: Hanken Grotesk; null = system default
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

/**
 * Swiss skin (portal `[data-skin="swiss"]` tokens 1:1, iOS `Palette.swissDark` parity):
 * warm near-blacks, hairline borders, electric indigo — sharp corners + mono status chips.
 * `diffAdd`/`diffDel`/`diffHunk` are carried over unchanged from [OrchaDarkPalette] (see
 * type doc — iOS keeps no per-skin diff tokens).
 */
val OrchaSwissDarkPalette = OrchaPalette(
    bg = Color(0xFF0E0E10),
    bgGrad1 = OrchaDarkPalette.bgGrad1,
    bgGrad2 = OrchaDarkPalette.bgGrad2,
    surface = Color(0xFF151517),
    surface2 = Color(0xFF1C1C1F),
    surface3 = Color(0xFF242428),
    raised = Color(0xFF242428),
    border = Color(0xFF3A3A40),
    border2 = Color(0xFF4A4A52),
    text = Color(0xFFF2F2EE),
    text2 = Color(0xFFC9C9C2),
    muted = Color(0xFFA2A29A),
    faint = Color(0xFF6A6A64),
    accent = Color(0xFF5A72FF),
    accentInk = Color(0xFFFFFFFF),
    accentSoft = Color(0x215A72FF),       // .13
    accentLine = Color(0x6B5A72FF),       // .42
    accentGlow = Color(0x385A72FF),       // .22 (unspecified by iOS; kept proportional to accentSoft/Line)
    ok = Color(0xFF42B877),
    okSoft = Color(0x2642B877),          // .15
    okLine = Color(0x6642B877),          // .40
    info = Color(0xFF5A72FF),
    infoSoft = Color(0x265A72FF),        // .15
    infoLine = Color(0x665A72FF),        // .40
    warn = Color(0xFFE0A13A),
    warnSoft = Color(0x29E0A13A),        // .16
    warnLine = Color(0x75E0A13A),        // .46
    danger = Color(0xFFFF5A5F),
    dangerSoft = Color(0x26FF5A5F),      // .15
    dangerLine = Color(0x75FF5A5F),      // .46
    violet = Color(0xFF9A7BFF),
    violetSoft = Color(0x269A7BFF),      // .15
    violetLine = Color(0x669A7BFF),      // .40
    idle = Color(0xFF6A6A64),
    idleSoft = Color(0x296A6A64),        // .16
    idleLine = Color(0x576A6A64),        // .34
    diffAdd = OrchaDarkPalette.diffAdd,
    diffAddBg = OrchaDarkPalette.diffAddBg,
    diffDel = OrchaDarkPalette.diffDel,
    diffDelBg = OrchaDarkPalette.diffDelBg,
    diffHunk = OrchaDarkPalette.diffHunk,
    diffHunkBg = OrchaDarkPalette.diffHunkBg,
    isDark = true,
    radiusCard = 2f,
    radiusButton = 2f,
    radiusTag = 0f,
    pillMono = true,
    flatChrome = true,
    displayFontFamily = SpaceGroteskFontFamily,
)

/** Swiss light: paper surfaces with near-black hairlines — the editorial grid. */
val OrchaSwissLightPalette = OrchaPalette(
    bg = Color(0xFFF3F3F0),
    bgGrad1 = OrchaLightPalette.bgGrad1,
    bgGrad2 = OrchaLightPalette.bgGrad2,
    surface = Color(0xFFFBFBF9),
    surface2 = Color(0xFFECEBE4),
    surface3 = Color(0xFFE3E2DA),
    raised = Color(0xFFFBFBF9),
    border = Color(0xFF16161A),
    border2 = Color(0xFF16161A),
    text = Color(0xFF16161A),
    text2 = Color(0xFF3A3931),
    muted = Color(0xFF6A685F),
    faint = Color(0xFF9A988C),
    accent = Color(0xFF1B4DFF),
    accentInk = Color(0xFFFFFFFF),
    accentSoft = Color(0x1A1B4DFF),       // .10
    accentLine = Color(0x6B1B4DFF),       // .42
    accentGlow = Color(0x2E1B4DFF),       // .18 (unspecified by iOS; kept proportional)
    ok = Color(0xFF157A4A),
    okSoft = Color(0x1F157A4A),          // .12
    okLine = Color(0x61157A4A),          // .38
    info = Color(0xFF1B4DFF),
    infoSoft = Color(0x1A1B4DFF),        // .10
    infoLine = Color(0x611B4DFF),        // .38
    warn = Color(0xFFB26B00),
    warnSoft = Color(0x1FB26B00),        // .12
    warnLine = Color(0x6BB26B00),        // .42
    danger = Color(0xFFE5484D),
    dangerSoft = Color(0x1CE5484D),      // .11
    dangerLine = Color(0x6BE5484D),      // .42
    violet = Color(0xFF6D4BD6),
    violetSoft = Color(0x1C6D4BD6),      // .11
    violetLine = Color(0x616D4BD6),      // .38
    idle = Color(0xFF9A988C),
    idleSoft = Color(0x299A988C),        // .16
    idleLine = Color(0x669A988C),        // .40
    diffAdd = OrchaLightPalette.diffAdd,
    diffAddBg = OrchaLightPalette.diffAddBg,
    diffDel = OrchaLightPalette.diffDel,
    diffDelBg = OrchaLightPalette.diffDelBg,
    diffHunk = OrchaLightPalette.diffHunk,
    diffHunkBg = OrchaLightPalette.diffHunkBg,
    isDark = false,
    radiusCard = 2f,
    radiusButton = 2f,
    radiusTag = 0f,
    pillMono = true,
    flatChrome = true,
    displayFontFamily = SpaceGroteskFontFamily,
)

/**
 * Minimalist skin (portal `[data-skin="minimal"]` tokens 1:1, iOS `Palette.minimalDark`
 * parity, mig-045 web parity): deep warm near-black surfaces, one champagne-gold accent
 * used sparingly, larger radii + hairline borders instead of boxed shadows. UI face is
 * the web's self-hosted Hanken Grotesk, bundled as static TTF cuts (font parity with web
 * and iOS) — see [HankenGroteskFontFamily].
 */
val OrchaMinimalDarkPalette = OrchaPalette(
    bg = Color(0xFF141414),
    bgGrad1 = OrchaDarkPalette.bgGrad1,
    bgGrad2 = OrchaDarkPalette.bgGrad2,
    surface = Color(0xFF1B1B1A),
    surface2 = Color(0xFF212120),
    surface3 = Color(0xFF282826),
    raised = Color(0xFF212120),
    border = Color(0xFF322F2B),
    border2 = Color(0xFF3D3934),
    text = Color(0xFFF5F0E6),
    text2 = Color(0xFFCEC7B8),
    muted = Color(0xFF958D7D),
    faint = Color(0xFF696153),
    accent = Color(0xFFE7C368),
    accentInk = Color(0xFF221B10),
    accentSoft = Color(0x1FE7C368),       // .12
    accentLine = Color(0x57E7C368),       // .34
    accentGlow = Color(0x38E7C368),       // .22 (unspecified by iOS; kept proportional)
    ok = Color(0xFF6FB894),
    okSoft = Color(0x1F6FB894),           // .12
    okLine = Color(0x4C6FB894),           // .30
    info = Color(0xFF7EA3C9),
    infoSoft = Color(0x1F7EA3C9),         // .12
    infoLine = Color(0x4C7EA3C9),         // .30
    warn = Color(0xFFCC9F5A),
    warnSoft = Color(0x21CC9F5A),         // .13
    warnLine = Color(0x52CC9F5A),         // .32
    danger = Color(0xFFC97A72),
    dangerSoft = Color(0x1FC97A72),       // .12
    dangerLine = Color(0x4CC97A72),       // .30
    violet = Color(0xFFA693C4),
    violetSoft = Color(0x1FA693C4),       // .12
    violetLine = Color(0x4CA693C4),       // .30
    idle = Color(0xFF6E6558),
    idleSoft = Color(0x296E6558),         // .16
    idleLine = Color(0x4C6E6558),         // .30
    diffAdd = OrchaDarkPalette.diffAdd,
    diffAddBg = OrchaDarkPalette.diffAddBg,
    diffDel = OrchaDarkPalette.diffDel,
    diffDelBg = OrchaDarkPalette.diffDelBg,
    diffHunk = OrchaDarkPalette.diffHunk,
    diffHunkBg = OrchaDarkPalette.diffHunkBg,
    isDark = true,
    radiusCard = 18f,
    radiusButton = 12f,
    radiusTag = 12f,
    pillMono = false,
    flatChrome = true,
    displayFontFamily = HankenGroteskFontFamily,
)

/**
 * Minimalist light: calm near-white surfaces, the gold accent darkened for AA
 * text/interactive contrast (same relationship the web skin uses between `--gold`
 * and `--accent-text`).
 */
val OrchaMinimalLightPalette = OrchaPalette(
    bg = Color(0xFFFAF8F2),
    bgGrad1 = OrchaLightPalette.bgGrad1,
    bgGrad2 = OrchaLightPalette.bgGrad2,
    surface = Color(0xFFFFFFFF),
    surface2 = Color(0xFFF6F3EC),
    surface3 = Color(0xFFF0EBE0),
    raised = Color(0xFFFFFFFF),
    border = Color(0xFFE7E0D2),
    border2 = Color(0xFFDCD3BF),
    text = Color(0xFF1A1A1A),
    text2 = Color(0xFF423D33),
    muted = Color(0xFF7C7264),
    faint = Color(0xFFA49A89),
    accent = Color(0xFF96721A),
    accentInk = Color(0xFFFFFFFF),
    accentSoft = Color(0x1A96721A),       // .10
    accentLine = Color(0x5296721A),       // .32
    accentGlow = Color(0x2E96721A),       // .18 (unspecified by iOS; kept proportional)
    ok = Color(0xFF3F8462),
    okSoft = Color(0x1C3F8462),           // .11
    okLine = Color(0x473F8462),           // .28
    info = Color(0xFF3F6C96),
    infoSoft = Color(0x1A3F6C96),         // .10
    infoLine = Color(0x423F6C96),         // .26
    warn = Color(0xFF9C7218),
    warnSoft = Color(0x1F9C7218),         // .12
    warnLine = Color(0x4C9C7218),         // .30
    danger = Color(0xFFA4483E),
    dangerSoft = Color(0x1AA4483E),       // .10
    dangerLine = Color(0x42A4483E),       // .26
    violet = Color(0xFF6F5A92),
    violetSoft = Color(0x1C6F5A92),       // .11
    violetLine = Color(0x426F5A92),       // .26
    idle = Color(0xFF918879),
    idleSoft = Color(0x21918879),         // .13
    idleLine = Color(0x42918879),         // .26
    diffAdd = OrchaLightPalette.diffAdd,
    diffAddBg = OrchaLightPalette.diffAddBg,
    diffDel = OrchaLightPalette.diffDel,
    diffDelBg = OrchaLightPalette.diffDelBg,
    diffHunk = OrchaLightPalette.diffHunk,
    diffHunkBg = OrchaLightPalette.diffHunkBg,
    isDark = false,
    radiusCard = 18f,
    radiusButton = 12f,
    radiusTag = 12f,
    pillMono = false,
    flatChrome = true,
    displayFontFamily = HankenGroteskFontFamily,
)

/** Resolve the token palette for a (skin, dark) combination — see [OrchaTheme]. */
fun paletteFor(skin: SkinMode, dark: Boolean): OrchaPalette = when (skin) {
    SkinMode.Classic -> if (dark) OrchaDarkPalette else OrchaLightPalette
    SkinMode.Swiss -> if (dark) OrchaSwissDarkPalette else OrchaSwissLightPalette
    SkinMode.Minimal -> if (dark) OrchaMinimalDarkPalette else OrchaMinimalLightPalette
}
