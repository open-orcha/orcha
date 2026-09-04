package io.openorcha.mobile.ui.theme

/**
 * Bundled display fonts, iOS/web parity (`ios/Orcha/Theme/Palette.swift`,
 * `docs/design/mobile/tokens/orcha-mobile-tokens.json`): Swiss uses Space Grotesk,
 * Minimalist uses Hanken Grotesk. Classic stays on the platform system font (Roboto).
 *
 * TTFs live under `res/font/` (lowercase_underscore, Android resource-name rules);
 * the OFL license for Hanken Grotesk is kept alongside the source cuts at
 * `app/src/main/fontLicenses/OFL-hanken-grotesk.txt`, matching the desktop/portal/iOS
 * convention of shipping the license next to the font files.
 *
 * Space Grotesk ships as one static TTF with several weights baked into its name
 * table (Light/Regular/Medium/Bold); unlike iOS (which can select weight via
 * `Font.custom(_:).weight()` against a single registered face), Compose's
 * `Font(resId, weight)` binds one weight per declared entry, so the single file is
 * registered at every requested weight — Compose treats bold/medium requests as
 * synthetic (faux) weight over the one instance, same visual family as the web/iOS,
 * without shipping duplicate resources for one physical font file.
 *
 * Hanken Grotesk ships as four static cuts (Regular/Medium/SemiBold/Bold) — each
 * gets its own [androidx.compose.ui.text.font.Font] entry at its true weight, so
 * Compose picks the correct bundled face instead of synthesizing weight.
 */

import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import io.openorcha.mobile.R

/** Inter — the tokens' BODY face on every skin (the web ships it; Android
 * previously fell back to Roboto per the token note, which read as "wrong font"
 * next to iOS). Five static cuts at true weights. OFL license:
 * app/src/main/fontLicenses/OFL-inter.txt. */
val InterFontFamily: FontFamily = FontFamily(
    Font(R.font.inter_regular, FontWeight.Normal),
    Font(R.font.inter_medium, FontWeight.Medium),
    Font(R.font.inter_semibold, FontWeight.SemiBold),
    Font(R.font.inter_bold, FontWeight.Bold),
    Font(R.font.inter_extrabold, FontWeight.ExtraBold),
)

val SpaceGroteskFontFamily: FontFamily = FontFamily(
    Font(R.font.space_grotesk, FontWeight.Normal),
    Font(R.font.space_grotesk, FontWeight.Medium),
    Font(R.font.space_grotesk, FontWeight.SemiBold),
    Font(R.font.space_grotesk, FontWeight.Bold),
)

val HankenGroteskFontFamily: FontFamily = FontFamily(
    Font(R.font.hanken_grotesk_regular, FontWeight.Normal),
    Font(R.font.hanken_grotesk_medium, FontWeight.Medium),
    Font(R.font.hanken_grotesk_semibold, FontWeight.SemiBold),
    Font(R.font.hanken_grotesk_bold, FontWeight.Bold),
    // No dedicated 800 cut shipped (iOS parity note in Palette.swift): Bold is the
    // closest weight for a W800 request rather than synthetic double-bold.
    Font(R.font.hanken_grotesk_bold, FontWeight.ExtraBold),
)
