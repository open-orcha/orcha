package io.openorcha.mobile.ui.components

/** Provides shared identity, summary, banner, and connectivity presentation components. */

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.ClickableText
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.domain.OrchaSelectors
import io.openorcha.mobile.ui.theme.MonoFontFamily
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.Orcha

enum class AvatarSize(val dp: Dp, val fontSp: Int, val radius: Dp) {
    Sm(30.dp, 12, 9.dp), Md(40.dp, 15, 12.dp), Lg(52.dp, 19, 15.dp)
}

@Composable
fun Avatar(alias: String, human: Boolean, size: AvatarSize = AvatarSize.Md, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    val shape = if (human) CircleShape else RoundedCornerShape(size.radius)
    Box(
        modifier
            .size(size.dp)
            .background(if (human) p.violetSoft else p.accentSoft, shape)
            .border(BorderStroke(1.dp, if (human) p.violetLine else p.accentLine), shape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            alias.take(1).uppercase(),
            color = if (human) p.violet else p.accent,
            fontWeight = FontWeight.W800,
            fontSize = size.fontSp.sp,
        )
    }
}

/** `.brandmark` — the real orca glyph on the radial brand tile (foundations §5). */
@Composable
fun BrandMark(size: Dp = 34.dp, modifier: Modifier = Modifier) {
    Box(
        modifier
            .size(size)
            .background(
                Brush.radialGradient(listOf(Color(0xFF0E2D33), Color(0xFF06171C))),
                RoundedCornerShape(size * 10f / 34f),
            ),
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.foundation.Image(
            painter = androidx.compose.ui.res.painterResource(io.openorcha.mobile.R.drawable.orca_glyph),
            contentDescription = "Orcha",
            modifier = Modifier.size(size * 24f / 34f),
        )
    }
}

/* ---------- stat tiles (`.stat`: 20/800 value + 10.5/700 uppercase key) ---------- */

@Composable
fun StatTile(value: String, label: String, tint: Color, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val base = modifier
        .background(Orcha.palette.surface, RoundedCornerShape(12.dp))
        .border(BorderStroke(1.dp, Orcha.palette.border), RoundedCornerShape(12.dp))
        .let { if (onClick != null) it.clickable(onClick = onClick) else it }
    Column(base.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(value, style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.W800, letterSpacing = (-0.4).sp), color = tint)
        Text(label.uppercase(), style = MaterialTheme.typography.labelSmall, color = Orcha.palette.muted, maxLines = 1)
    }
}

/* ---------- banners (`.banner.warn/.danger/.info`) ---------- */

enum class BannerKind { Warn, Danger, Info }

@Composable
fun Banner(kind: BannerKind, text: String, modifier: Modifier = Modifier, action: String? = null, onAction: (() -> Unit)? = null) {
    val tint = when (kind) {
        BannerKind.Warn -> Orcha.palette.tint("warn")
        BannerKind.Danger -> Orcha.palette.tint("danger")
        BannerKind.Info -> Orcha.palette.tint("info")
    }
    Row(
        modifier
            .fillMaxWidth()
            .background(tint.soft, RoundedCornerShape(12.dp))
            .border(BorderStroke(1.dp, tint.line), RoundedCornerShape(12.dp))
            .padding(horizontal = 13.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.W600),
            color = tint.color,
            modifier = Modifier.weight(1f),
        )
        if (action != null && onAction != null) {
            Text(
                action,
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.W700),
                color = tint.color,
                modifier = Modifier.clickable(onClick = onAction),
            )
        }
    }
}

/* ---------- connection indicator (`.conn`) ---------- */

@Composable
fun ConnChip(state: String, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    val (color, word) = when (state.lowercase()) {
        "live", "active" -> p.ok to "live"
        // iOS Kit.swift parity: polling IS the good state — a reachable
        // workspace reads green "connected", not amber "polling".
        "polling" -> p.ok to "connected"
        "paused" -> p.warn to "paused"
        "unreachable", "off" -> p.danger to "unreachable"
        "signin" -> p.warn to "sign in"
        else -> p.idle to state.lowercase()
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        val alpha = if (state.lowercase() in setOf("live", "active", "polling")) pulseAlpha() else 1f
        Box(Modifier.size(7.dp).alpha(alpha).background(color, CircleShape))
        Text(word, style = MaterialTheme.typography.labelMedium.copy(letterSpacing = 0.2.sp), color = color)
    }
}

/* ---------- skeleton loader (`.skel`) ---------- */

@Composable
fun Skeleton(height: Dp, modifier: Modifier = Modifier) {
    Box(
        modifier
            .fillMaxWidth()
            .height(height)
            .alpha(pulseAlpha())
            .background(Orcha.palette.surface2, RoundedCornerShape(12.dp))
            .border(BorderStroke(1.dp, Orcha.palette.border), RoundedCornerShape(12.dp)),
    )
}

/* ---------- state layout (`.state`: 72dp glyph tile · title 17/750 · sub 13.5) ---------- */
