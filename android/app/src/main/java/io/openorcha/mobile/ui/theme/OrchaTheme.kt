package io.openorcha.mobile.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

object OrchaColors {
    val Ink = Color(0xFFEAF0FF)
    val Muted = Color(0xFF9AA6BD)
    val Surface = Color(0xFF111722)
    val SurfaceHigh = Color(0xFF192230)
    val Stroke = Color(0xFF283548)
    val Accent = Color(0xFF78DCE8)
    val Success = Color(0xFF88D18A)
    val Warning = Color(0xFFFFC857)
    val Danger = Color(0xFFFF6B6B)
    val Info = Color(0xFF8EA7FF)
}

private val OrchaDarkScheme: ColorScheme = darkColorScheme(
    primary = OrchaColors.Accent,
    onPrimary = Color(0xFF061115),
    secondary = OrchaColors.Info,
    background = Color(0xFF0B0F16),
    onBackground = OrchaColors.Ink,
    surface = OrchaColors.Surface,
    onSurface = OrchaColors.Ink,
    surfaceVariant = OrchaColors.SurfaceHigh,
    onSurfaceVariant = OrchaColors.Muted,
    outline = OrchaColors.Stroke,
    error = OrchaColors.Danger,
)

@Composable
fun OrchaTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = OrchaDarkScheme,
        typography = MaterialTheme.typography,
        content = content,
    )
}

