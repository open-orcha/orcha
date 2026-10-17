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
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
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

/**
 * Linear avatar: round for everyone, deterministic hue from the alias (same djb2 hue as
 * iOS / [LAvatar]), ✦ badge for AI agents. Delegates to [LAvatar].
 */
@Composable
fun Avatar(alias: String, human: Boolean, size: AvatarSize = AvatarSize.Md, modifier: Modifier = Modifier) {
    LAvatar(name = alias, modifier = modifier, isAI = !human, size = size.dp)
}

/**
 * Brand tile — the Embodent mark (light | grey halves) on its near-black #121314 rounded
 * tile in both themes, so the light half never disappears on a light background.
 */
@Composable
fun BrandMark(size: Dp = 34.dp, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    val shape = RoundedCornerShape(size * 9f / 34f)
    Box(
        modifier
            .size(size)
            .background(Color(0xFF121314), shape)
            .border(BorderStroke(1.dp, p.border), shape),
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.foundation.Image(
            painter = androidx.compose.ui.res.painterResource(io.openorcha.mobile.R.drawable.embodent_mark),
            contentDescription = "Embodent",
            modifier = Modifier.size(size * 0.9f),
        )
    }
}

/* ---------- stat tiles (Linear: 20/600 value + 13 muted label, hairline card) ---------- */

@Composable
fun StatTile(value: String, label: String, tint: Color, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val p = Orcha.palette
    val shape = RoundedCornerShape(p.radiusCard.dp)
    val base = modifier
        .clip(shape)
        .background(p.surface, shape)
        .border(BorderStroke(1.dp, p.border), shape)
        .let { if (onClick != null) it.clickable(onClick = onClick) else it }
    Column(
        base.padding(horizontal = 12.dp, vertical = 10.dp).semantics(mergeDescendants = true) {},
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(value, style = ltype(LType.Title), color = tint)
        Text(label, style = ltype(LType.Meta), color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/* ---------- banners (Linear: calm surface card, tinted leading dot, accent action) ---------- */

enum class BannerKind { Warn, Danger, Info }

@Composable
fun Banner(kind: BannerKind, text: String, modifier: Modifier = Modifier, action: String? = null, onAction: (() -> Unit)? = null) {
    val p = Orcha.palette
    val tint = when (kind) {
        BannerKind.Warn -> p.tint("warn")
        BannerKind.Danger -> p.tint("danger")
        BannerKind.Info -> p.tint("info")
    }
    val shape = RoundedCornerShape(p.radiusCard.dp)
    Row(
        modifier
            .fillMaxWidth()
            .background(p.surface, shape)
            .border(BorderStroke(1.dp, p.border), shape)
            .padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp)
            .heightIn(min = 40.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.size(8.dp).background(tint.color, CircleShape))
        Text(
            text,
            style = ltype(LType.Meta).copy(fontWeight = FontWeight.Medium),
            color = p.text,
            modifier = Modifier.weight(1f).padding(vertical = 6.dp),
        )
        if (action != null && onAction != null) {
            Box(
                Modifier
                    .defaultMinSize(minHeight = 48.dp)
                    .clickable(role = Role.Button, onClick = onAction)
                    .padding(horizontal = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(action, style = ltype(LType.Meta).copy(fontWeight = FontWeight.SemiBold), color = p.accent)
            }
        } else {
            Spacer(Modifier.width(8.dp))
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
        Text(word, style = ltype(LType.Meta).copy(fontWeight = FontWeight.Medium), color = p.text2)
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
            .background(Orcha.palette.surface2, RoundedCornerShape(Orcha.palette.radiusCard.dp)),
    )
}

/* ---------- state layout (`.state`: 72dp glyph tile · title 17/750 · sub 13.5) ---------- */
