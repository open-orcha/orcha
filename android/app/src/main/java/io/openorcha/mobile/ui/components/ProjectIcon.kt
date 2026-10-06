package io.openorcha.mobile.ui.components

/* D14 — a project's icon (portal ProjectIcon.tsx parity): the user's emoji, or a Lucide app
   glyph tinted with its palette colour; unset = the neutral cube glyph (never initials). */

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.domain.ProjectIconValue
import io.openorcha.mobile.domain.ProjectIcons
import io.openorcha.mobile.ui.icons.ProjectGlyphs
import io.openorcha.mobile.ui.theme.Orcha

/** A glyph colour from the shared avatar palette, toned per theme (portal `glyphColor`);
 *  null slot = neutral (the caller's muted text colour). */
@Composable
fun projectGlyphColor(slot: Int?): Color? {
    slot ?: return null
    val n = ProjectIcons.AVATAR_HUES.size
    val hue = ProjectIcons.AVATAR_HUES[((slot % n) + n) % n].toFloat()
    return if (Orcha.palette.isDark) Color.hsl(hue, 0.70f, 0.70f) else Color.hsl(hue, 0.62f, 0.42f)
}

/** The icon itself (no tile), [size] square. */
@Composable
fun ProjectIconMark(icon: ProjectIconValue?, size: Dp = 18.dp, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    Box(modifier.size(size), contentAlignment = Alignment.Center) {
        when (icon) {
            is ProjectIconValue.Emoji -> {
                // Fixed-size glyph: divide out the font scale so it never overflows its tile.
                val density = LocalDensity.current
                val fs = with(density) { (size * 0.86f).toPx() / (this.density * fontScale) }.sp
                Text(icon.value, style = TextStyle(fontSize = fs, lineHeight = fs), maxLines = 1)
            }
            is ProjectIconValue.Glyph -> ProjectGlyphs.vector(icon.name)?.let {
                Icon(it, null, tint = projectGlyphColor(icon.color) ?: p.text2, modifier = Modifier.size(size * 0.8f))
            }
            null -> Icon(ProjectGlyphs.vector("box")!!, null, tint = p.text2, modifier = Modifier.size(size * 0.8f))
        }
    }
}

/** The icon on a subtle rounded tile (Projects list, Settings). Decorative: the row names it. */
@Composable
fun ProjectIconTile(icon: ProjectIconValue?, size: Dp = 32.dp, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    val shape = RoundedCornerShape(size * 0.28f)
    Box(
        modifier.size(size).background(p.surface2, shape).border(1.dp, p.border, shape),
        contentAlignment = Alignment.Center,
    ) { ProjectIconMark(icon, size * 0.6f) }
}
