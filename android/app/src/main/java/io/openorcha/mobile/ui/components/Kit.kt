package io.openorcha.mobile.ui.components

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
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.ui.theme.MonoFontFamily
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   The Orcha mobile component kit — one Compose composable per row of the
   component inventory (docs/design/mobile/12-component-inventory.md), pixel
   values from mockups/mobile.css. Screens NEVER restyle these.
   ============================================================================= */

/** `.card` — surface, 1dp border, radius 12, padding 14, 8dp internal rhythm. */
@Composable
fun OrchaCard(
    modifier: Modifier = Modifier,
    borderColor: Color = Orcha.palette.border,
    container: Color = Orcha.palette.surface,
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val base = modifier
        .fillMaxWidth()
        .background(container, RoundedCornerShape(12.dp))
        .border(BorderStroke(1.dp, borderColor), RoundedCornerShape(12.dp))
        .let { if (onClick != null) it.clickable(onClick = onClick) else it }
    Column(base.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
}

/** `.section-h` — 11/700 +.8 uppercase kicker with faint count. */
@Composable
fun SectionH(title: String, count: String? = null, modifier: Modifier = Modifier, trailing: (@Composable RowScope.() -> Unit)? = null) {
    Row(
        modifier.fillMaxWidth().padding(top = 10.dp, start = 2.dp, end = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title.uppercase(), style = MaterialTheme.typography.labelMedium, color = Orcha.palette.muted)
        if (count != null) Text(count, style = MaterialTheme.typography.labelMedium, color = Orcha.palette.faint)
        Spacer(Modifier.weight(1f))
        trailing?.invoke(this)
    }
}

/** `.tag` — bordered 10.5 meta chip; `.tag.model` mono variant for model ids. */
@Composable
fun MetaTag(text: String, mono: Boolean = false, tint: Color? = null, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier
            .border(BorderStroke(1.dp, tint?.copy(alpha = 0.4f) ?: Orcha.palette.border2), RoundedCornerShape(5.dp))
            .padding(horizontal = 6.dp, vertical = 1.dp),
        style = if (mono) MonoSmStyle else MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.W500, letterSpacing = 0.sp),
        color = tint ?: Orcha.palette.muted,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/* ---------- buttons (`.btn`; Android renders full-radius pills) ---------- */

@Composable
private fun KitButton(
    text: String,
    onClick: () -> Unit,
    container: Color,
    contentColor: Color,
    border: Color? = null,
    enabled: Boolean = true,
    small: Boolean = false,
    modifier: Modifier = Modifier,
    leading: (@Composable () -> Unit)? = null,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.alpha(if (enabled) 1f else 0.45f),
        shape = RoundedCornerShape(999.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = container, contentColor = contentColor,
            disabledContainerColor = container, disabledContentColor = contentColor,
        ),
        border = border?.let { BorderStroke(1.dp, it) },
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            horizontal = if (small) 14.dp else 18.dp, vertical = if (small) 8.dp else 12.dp,
        ),
    ) {
        if (leading != null) { leading(); Spacer(Modifier.width(8.dp)) }
        Text(
            text,
            style = if (small) MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.W700)
            else MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.W700, letterSpacing = (-0.1).sp),
        )
    }
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, small: Boolean = false, leading: (@Composable () -> Unit)? = null) =
    KitButton(text, onClick, Orcha.palette.accent, Orcha.palette.accentInk, enabled = enabled, small = small, modifier = modifier, leading = leading)

@Composable
fun TonalButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, small: Boolean = false) =
    KitButton(text, onClick, Orcha.palette.accentSoft, Orcha.palette.accent, Orcha.palette.accentLine, enabled, small, modifier)

@Composable
fun OkTonalButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, small: Boolean = false) =
    KitButton(text, onClick, Orcha.palette.okSoft, Orcha.palette.ok, Orcha.palette.okLine, enabled, small, modifier)

@Composable
fun DangerTonalButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, small: Boolean = false) =
    KitButton(text, onClick, Orcha.palette.dangerSoft, Orcha.palette.danger, Orcha.palette.dangerLine, enabled, small, modifier)

@Composable
fun NeutralButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, small: Boolean = false) =
    KitButton(text, onClick, Orcha.palette.surface2, Orcha.palette.text, Orcha.palette.border2, enabled, small, modifier)

/* ---------- inputs (`.input`: surface-2 fill, border-2, radius 12) ---------- */

@Composable
fun OrchaField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String? = null,
    minLines: Int = 1,
    maxLines: Int = Int.MAX_VALUE,
    isError: Boolean = false,
    supporting: String? = null,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth(),
        label = label?.let { { Text(it) } },
        placeholder = placeholder?.let { { Text(it, color = Orcha.palette.faint) } },
        minLines = minLines,
        maxLines = maxLines,
        isError = isError,
        supportingText = supporting?.let { { Text(it, color = if (isError) Orcha.palette.danger else Orcha.palette.muted) } },
        shape = RoundedCornerShape(12.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = Orcha.palette.surface2,
            unfocusedContainerColor = Orcha.palette.surface2,
            errorContainerColor = Orcha.palette.surface2,
            focusedBorderColor = Orcha.palette.accent,
            unfocusedBorderColor = Orcha.palette.border2,
            errorBorderColor = Orcha.palette.danger,
            focusedLabelColor = Orcha.palette.accent,
            unfocusedLabelColor = Orcha.palette.muted,
            cursorColor = Orcha.palette.accent,
        ),
    )
}

/** `.seg` — segmented control on surface-2, selected opt on surface-3. */
@Composable
fun SegControl(options: List<String>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .background(Orcha.palette.surface2, RoundedCornerShape(10.dp))
            .border(BorderStroke(1.dp, Orcha.palette.border), RoundedCornerShape(10.dp))
            .padding(3.dp),
    ) {
        options.forEachIndexed { i, opt ->
            val on = i == selected
            Text(
                opt,
                modifier = Modifier
                    .weight(1f)
                    .background(if (on) Orcha.palette.surface3 else Color.Transparent, RoundedCornerShape(8.dp))
                    .clickable { onSelect(i) }
                    .padding(vertical = 7.dp),
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.W600),
                color = if (on) Orcha.palette.text else Orcha.palette.muted,
            )
        }
    }
}

/* ---------- avatars (`.avatar`: square agent / round human; sm 30 · md 40 · lg 52) ---------- */

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
        "polling" -> p.warn to "polling"
        "paused" -> p.warn to "paused"
        "unreachable", "off" -> p.danger to "unreachable"
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

@Composable
fun StateLayout(
    title: String,
    sub: String?,
    modifier: Modifier = Modifier,
    glyph: @Composable () -> Unit = { BrandMark(40.dp) },
    danger: Boolean = false,
    content: @Composable ColumnScope.() -> Unit = {},
) {
    val p = Orcha.palette
    Column(
        modifier.fillMaxSize().padding(horizontal = 36.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier
                .size(72.dp)
                .background(if (danger) p.dangerSoft else p.surface2, RoundedCornerShape(22.dp))
                .border(BorderStroke(1.dp, if (danger) p.dangerLine else p.border), RoundedCornerShape(22.dp)),
            contentAlignment = Alignment.Center,
        ) { glyph() }
        Text(title, style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.W700), textAlign = TextAlign.Center)
        if (sub != null) {
            Text(
                sub, style = MaterialTheme.typography.bodyMedium, color = p.muted,
                textAlign = TextAlign.Center, modifier = Modifier.width(270.dp),
            )
        }
        content()
    }
}

/* ---------- key-value row (`.kv`) ---------- */

@Composable
fun KVRow(k: String, v: String, mono: Boolean = false, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().padding(vertical = 9.dp, horizontal = 2.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(k, style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.muted)
        Spacer(Modifier.weight(1f))
        Text(
            v,
            style = if (mono) MonoSmStyle.copy(fontSize = 12.sp) else MaterialTheme.typography.bodyMedium,
            color = Orcha.palette.text,
            textAlign = TextAlign.End,
        )
    }
}

/* ---------- chat bubbles (`.bubble`: radius 16, tail 6, max 82%) ---------- */

enum class BubbleKind { Mine, Theirs, System }

@Composable
fun Bubble(
    kind: BubbleKind,
    body: String,
    modifier: Modifier = Modifier,
    author: String? = null,
    time: String? = null,
    trailingContent: (@Composable ColumnScope.() -> Unit)? = null,
) {
    val p = Orcha.palette
    when (kind) {
        BubbleKind.System -> Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            Text(
                body,
                modifier = Modifier
                    .border(BorderStroke(1.dp, p.border2), RoundedCornerShape(10.dp))
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.W500, letterSpacing = 0.sp, fontSize = 12.sp),
                color = p.muted,
                textAlign = TextAlign.Center,
            )
        }
        else -> {
            val mine = kind == BubbleKind.Mine
            val shape = RoundedCornerShape(
                topStart = 16.dp, topEnd = 16.dp,
                bottomStart = if (mine) 16.dp else 6.dp,
                bottomEnd = if (mine) 6.dp else 16.dp,
            )
            Row(modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
                Column(
                    Modifier
                        .fillMaxWidth(0.82f)
                        .background(if (mine) p.accent else p.surface2, shape)
                        .let { if (!mine) it.border(BorderStroke(1.dp, p.border), shape) else it }
                        .padding(horizontal = 13.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    if (!mine && author != null) {
                        Text(author, style = MaterialTheme.typography.labelMedium.copy(letterSpacing = 0.2.sp), color = p.accent)
                    }
                    Text(
                        body,
                        style = MaterialTheme.typography.bodyLarge.copy(fontSize = 14.5.sp),
                        color = if (mine) p.accentInk else p.text,
                    )
                    if (time != null) {
                        Text(
                            time, style = MonoSmStyle,
                            color = if (mine) p.accentInk.copy(alpha = 0.55f) else p.faint,
                        )
                    }
                    trailingContent?.invoke(this)
                }
            }
        }
    }
}

/* ---------- log line coloring (`.log .ln-*`) ---------- */

@Composable
fun logLineColor(line: String): Color {
    val p = Orcha.palette
    val l = line.lowercase()
    return when {
        "error" in l || "failed" in l || "traceback" in l -> p.danger
        "warn" in l -> p.warn
        "tool" in l || l.startsWith("run ") -> p.accent
        "done" in l || "complete" in l || "finished" in l || "✓" in line -> p.ok
        l.startsWith("[") || l.startsWith("--") -> p.faint
        else -> p.text2
    }
}

@Composable
fun LogLine(line: String) {
    Text(
        line,
        fontFamily = MonoFontFamily,
        fontSize = 11.5.sp,
        lineHeight = 17.sp,
        color = logLineColor(line),
    )
}
