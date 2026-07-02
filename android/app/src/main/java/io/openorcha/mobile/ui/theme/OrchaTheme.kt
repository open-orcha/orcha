package io.openorcha.mobile.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

object OrchaColors {
    val Bg = Color(0xFF0A0D12)
    val Surface = Color(0xFF111620)
    val Surface2 = Color(0xFF161D29)
    val Surface3 = Color(0xFF1C2532)
    val Border = Color(0xFF232D3D)
    val Border2 = Color(0xFF2C3848)
    val Text = Color(0xFFE8EDF6)
    val Text2 = Color(0xFFC4CEDD)
    val Muted = Color(0xFF8B98AE)
    val Faint = Color(0xFF5A6678)
    val Accent = Color(0xFF1FC7CD)
    val AccentInk = Color(0xFF04181A)
    val Ok = Color(0xFF38D39A)
    val Info = Color(0xFF5AA6FF)
    val Warn = Color(0xFFF5B13D)
    val Danger = Color(0xFFF6757E)
    val Violet = Color(0xFFB08CFF)
    val Idle = Color(0xFF6B788E)
}

private val OrchaDarkScheme: ColorScheme = darkColorScheme(
    primary = OrchaColors.Accent,
    onPrimary = OrchaColors.AccentInk,
    primaryContainer = OrchaColors.Accent.copy(alpha = 0.12f),
    onPrimaryContainer = OrchaColors.Accent,
    secondary = OrchaColors.Info,
    background = OrchaColors.Bg,
    onBackground = OrchaColors.Text,
    surface = OrchaColors.Surface,
    onSurface = OrchaColors.Text,
    surfaceVariant = OrchaColors.Surface2,
    onSurfaceVariant = OrchaColors.Muted,
    surfaceContainer = OrchaColors.Surface2,
    surfaceContainerHigh = OrchaColors.Surface3,
    outline = OrchaColors.Border2,
    outlineVariant = OrchaColors.Border,
    error = OrchaColors.Danger,
)

private val OrchaTypography = Typography(
    displaySmall = Typography().displaySmall.copy(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.ExtraBold),
    titleLarge = Typography().titleLarge.copy(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.Bold),
    titleMedium = Typography().titleMedium.copy(fontSize = 17.sp, lineHeight = 23.sp, fontWeight = FontWeight.Bold),
    titleSmall = Typography().titleSmall.copy(fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = Typography().bodyLarge.copy(fontSize = 15.sp, lineHeight = 22.sp),
    bodyMedium = Typography().bodyMedium.copy(fontSize = 13.sp, lineHeight = 19.sp),
    labelSmall = Typography().labelSmall.copy(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold),
)

private val OrchaShapes = Shapes(
    extraSmall = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
    small = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
    medium = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
    large = androidx.compose.foundation.shape.RoundedCornerShape(16.dp),
    extraLarge = androidx.compose.foundation.shape.RoundedCornerShape(22.dp),
)

@Composable
fun OrchaTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = OrchaDarkScheme,
        typography = OrchaTypography,
        shapes = OrchaShapes,
        content = content,
    )
}

val MonoFontFamily: FontFamily = FontFamily.Monospace
