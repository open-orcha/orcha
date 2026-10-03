package io.openorcha.mobile.ui.components

/**
 * Linear design kit — the Android mirror of the web portal's v2 ("Linear") design system
 * and of `ios/Orcha/Components/Linear.swift`. Every component reads [Orcha.palette], so
 * the Linear / Swiss / Minimal skins and light / dark keep working; Linear is the default.
 */

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.InterFontFamily
import io.openorcha.mobile.ui.theme.Orcha
import io.openorcha.mobile.ui.theme.OrchaPalette

// MARK: Typography

/** Linear type scale (Inter). Use via [ltype] instead of ad-hoc TextStyle/fontSize. */
enum class LType { Display, Title, Headline, Body, BodyEmph, Meta, Mono, Micro }

/** Pure style resolver (no composition needed) — testable; [ltype] adds the skin's family. */
internal fun ltypeStyle(t: LType, family: FontFamily = InterFontFamily): TextStyle = when (t) {
    LType.Display -> TextStyle(fontFamily = family, fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.5).sp)
    LType.Title -> TextStyle(fontFamily = family, fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.3).sp)
    LType.Headline -> TextStyle(fontFamily = family, fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.1).sp)
    LType.Body -> TextStyle(fontFamily = family, fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.Normal, letterSpacing = (-0.1).sp)
    LType.BodyEmph -> TextStyle(fontFamily = family, fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.Medium, letterSpacing = (-0.1).sp)
    LType.Meta -> TextStyle(fontFamily = family, fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Normal)
    LType.Mono -> TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 17.sp, fontWeight = FontWeight.Normal)
    LType.Micro -> TextStyle(fontFamily = family, fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.1.sp)
}

/** Skin-aware Linear text style: Inter on Linear; Swiss/Minimal keep their bundled family. */
@Composable
fun ltype(t: LType): TextStyle = ltypeStyle(t, Orcha.palette.displayFontFamily ?: InterFontFamily)

object LSpace {
    val xs = 4.dp
    val s = 8.dp
    val m = 12.dp
    val l = 16.dp
    val xl = 24.dp
}

// MARK: Palette helpers (Linear semantics)

/** Fill for primary buttons (web `--v2-primary-bg`). */
val OrchaPalette.lPrimaryFill: Color get() = primaryFill ?: accent
val OrchaPalette.lPrimaryText: Color get() = if (primaryFill == null) accentInk else Color.White
/** Row hover / pressed tint (web `--v2-selected`). */
val OrchaPalette.lSelected: Color get() = if (isDark) Color.White.copy(alpha = 0.08f) else Color(0x1218191C)
val OrchaPalette.lHover: Color get() = if (isDark) Color.White.copy(alpha = 0.045f) else Color(0x0B18191C)
val OrchaPalette.lPrioEmpty: Color get() = if (isDark) Color(0xFF3A3C42) else Color(0xFFD5D6DA)
val OrchaPalette.lUrgent: Color get() = if (isDark) Color(0xFFF2994A) else Color(0xFFDE6414)
val OrchaPalette.lProgress: Color get() = if (isDark) Color(0xFFF0BF4C) else Color(0xFFB07D00)
val OrchaPalette.lStatusNeutral: Color get() = if (isDark) Color(0xFF8A8F98) else Color(0xFF8A8E96)
/** Web status-glyph tokens (`--v2-st-todo` / `-faint` / `-muted`) — iOS parity. */
val OrchaPalette.lStatusTodo: Color get() = if (isDark) Color(0xFF9EA2AC) else Color(0xFF8A8E96)
val OrchaPalette.lStatusFaint: Color get() = if (isDark) Color(0xFF6E727C) else Color(0xFFA3A6AD)
val OrchaPalette.lStatusMuted: Color get() = if (isDark) Color(0xFF7B7F89) else Color(0xFF8A8E96)

// MARK: Surfaces & structure

/** Panel surface, 1dp hairline border, radius 10 (skin card radius). */
@Composable
fun LCard(modifier: Modifier = Modifier, padding: Dp = 12.dp, content: @Composable ColumnScope.() -> Unit) {
    val p = Orcha.palette
    val shape = RoundedCornerShape(p.radiusCard.dp)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(p.surface, shape)
            .border(1.dp, p.border, shape)
            .padding(padding),
        content = content,
    )
}

/** Muted caption header (title · count · trailing) above its content. No filled band. */
@Composable
fun LSection(
    title: String,
    modifier: Modifier = Modifier,
    count: Int? = null,
    trailing: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val p = Orcha.palette
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                modifier = Modifier.weight(1f).semantics(mergeDescendants = true) { heading() },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(title, style = ltype(LType.Meta).copy(fontWeight = FontWeight.Medium), color = p.text2)
                if (count != null) {
                    Text("$count", style = ltype(LType.Meta), color = p.muted)
                }
            }
            trailing?.invoke()
        }
        content()
    }
}

/** List row: leading glyph · title + one muted subtitle line · trailing meta. 52dp min height. */
@Composable
fun LRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    onClick: (() -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val p = Orcha.palette
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val clickMod = if (onClick != null) {
        Modifier
            .background(if (pressed) p.lSelected else Color.Transparent)
            .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
    } else Modifier
    val hasSub = !subtitle.isNullOrEmpty()
    Row(
        modifier = modifier
            .fillMaxWidth()
            .then(clickMod)
            .heightIn(min = 52.dp)
            .padding(horizontal = LSpace.m, vertical = LSpace.s),
        verticalAlignment = if (hasSub) Alignment.Top else Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.m),
    ) {
        if (leading != null) {
            Box(Modifier.padding(top = if (hasSub) 3.dp else 0.dp)) { leading() }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = ltype(LType.BodyEmph), color = p.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (hasSub) {
                Text(subtitle!!, style = ltype(LType.Meta), color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (trailing != null) {
            Box(Modifier.align(Alignment.CenterVertically)) {
                androidx.compose.runtime.CompositionLocalProvider(
                    androidx.compose.material3.LocalContentColor provides p.muted,
                    androidx.compose.material3.LocalTextStyle provides ltype(LType.Meta),
                ) { trailing() }
            }
        }
    }
}

/** Hairline divider in the palette border colour. */
@Composable
fun LDivider(modifier: Modifier = Modifier, inset: Dp = 0.dp) {
    val p = Orcha.palette
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    Box(
        modifier
            .fillMaxWidth()
            .padding(start = inset)
            .height(hairline)
            .background(p.border)
            .clearAndSetSemantics { },
    )
}

/** Calm empty state: muted glyph, title, one line, optional single action. */
@Composable
fun LEmptyState(
    icon: ImageVector,
    title: String,
    message: String,
    modifier: Modifier = Modifier,
    actionTitle: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val p = Orcha.palette
    Column(
        modifier = modifier.fillMaxWidth().padding(vertical = LSpace.xl, horizontal = LSpace.l),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(LSpace.m),
    ) {
        val shape = RoundedCornerShape(10.dp)
        Box(
            Modifier.size(44.dp).background(p.surface2, shape).border(1.dp, p.border, shape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = p.muted, modifier = Modifier.size(22.dp))
        }
        Column(
            Modifier.widthIn(max = 320.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(LSpace.xs),
        ) {
            Text(title, style = ltype(LType.Headline), color = p.text, textAlign = TextAlign.Center)
            Text(message, style = ltype(LType.Meta), color = p.muted, textAlign = TextAlign.Center)
        }
        if (actionTitle != null && onAction != null) {
            LButton(actionTitle, onAction, kind = LButtonKind.Secondary, size = LSize.Small)
        }
    }
}

// MARK: Controls

enum class LButtonKind { Primary, Secondary, Ghost, Danger }

/** Small = 28dp visual, Regular = 34dp visual; both keep a 48dp hit target. */
enum class LSize { Small, Regular }

/** Compact Linear button. One Primary per screen; the rest Secondary or Ghost. */
@Composable
fun LButton(
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    kind: LButtonKind = LButtonKind.Secondary,
    size: LSize = LSize.Regular,
    enabled: Boolean = true,
) {
    val p = Orcha.palette
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val shape = RoundedCornerShape(p.radiusButton.dp)
    val fg = when (kind) {
        LButtonKind.Primary -> p.lPrimaryText
        LButtonKind.Secondary -> p.text
        LButtonKind.Ghost -> p.text2
        LButtonKind.Danger -> p.danger
    }
    val bg = when (kind) {
        LButtonKind.Primary -> if (pressed) p.lPrimaryFill.copy(alpha = 0.85f) else p.lPrimaryFill
        LButtonKind.Secondary -> if (pressed) p.surface3 else p.surface2
        LButtonKind.Ghost -> if (pressed) p.lSelected else Color.Transparent
        LButtonKind.Danger -> if (pressed) p.dangerLine else p.dangerSoft
    }
    val borderColor = when (kind) {
        LButtonKind.Secondary -> p.border2
        LButtonKind.Danger -> p.dangerLine
        else -> Color.Transparent
    }
    val small = size == LSize.Small
    Box(
        modifier = modifier
            .defaultMinSize(minHeight = 48.dp)
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            modifier = Modifier
                .heightIn(min = if (small) 28.dp else 34.dp)
                .background(bg, shape)
                .border(BorderStroke(1.dp, borderColor), shape)
                .padding(horizontal = if (small) 10.dp else 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        ) {
            val alpha = if (enabled) 1f else 0.45f
            if (icon != null) {
                Icon(icon, contentDescription = null, tint = fg.copy(alpha = fg.alpha * alpha), modifier = Modifier.size(if (small) 13.dp else 15.dp))
            }
            Text(
                title,
                style = ltype(if (small) LType.Meta else LType.BodyEmph).copy(fontWeight = FontWeight.Medium),
                color = fg.copy(alpha = fg.alpha * alpha),
                // Large font scales wrap to a second line instead of clipping to "Acc…".
                maxLines = 2,
                textAlign = TextAlign.Center,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** Compact filter / label chip. A tint without an icon shows as a leading dot. */
@Composable
fun LChip(
    text: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    tint: Color? = null,
    selected: Boolean = false,
    onClick: (() -> Unit)? = null,
) {
    val p = Orcha.palette
    val label: @Composable () -> Unit = {
        Row(
            modifier = Modifier
                .heightIn(min = 26.dp)
                .background(if (selected) p.lSelected else Color.Transparent, CircleShape)
                .border(1.dp, if (selected) p.border2 else p.border, CircleShape)
                .padding(horizontal = 10.dp, vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            if (icon != null) {
                Icon(icon, contentDescription = null, tint = tint ?: (if (selected) p.text else p.muted), modifier = Modifier.size(12.dp))
            } else if (tint != null) {
                Box(Modifier.size(7.dp).background(tint, CircleShape))
            }
            Text(
                text,
                style = ltype(LType.Meta).copy(fontWeight = FontWeight.Medium),
                color = if (selected) p.text else p.text2,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
    if (onClick != null) {
        Box(
            modifier = modifier
                .defaultMinSize(minHeight = 48.dp)
                .selectable(selected = selected, role = Role.Button, onClick = onClick),
            contentAlignment = Alignment.Center,
        ) { label() }
    } else {
        Box(modifier.semantics(mergeDescendants = true) {}) { label() }
    }
}

/** Pill filter row (web FilterPills), horizontally scrollable. */
@Composable
fun <T> LSegmented(
    options: List<Pair<T, String>>,
    selection: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
) {
    val p = Orcha.palette
    Row(
        modifier = modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        options.forEach { (value, title) ->
            val on = value == selection
            Box(
                modifier = Modifier
                    .defaultMinSize(minHeight = 48.dp)
                    // Keep the press ripple pill-shaped instead of a square over the 48dp target.
                    .clip(CircleShape)
                    .selectable(selected = on, role = Role.Tab, onClick = { onSelect(value) }),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    title,
                    style = ltype(LType.Meta).copy(fontWeight = FontWeight.Medium),
                    color = if (on) p.text else p.muted,
                    maxLines = 1,
                    modifier = Modifier
                        .heightIn(min = 28.dp)
                        .background(if (on) p.surface3 else Color.Transparent, CircleShape)
                        .border(1.dp, if (on) p.border2 else Color.Transparent, CircleShape)
                        .padding(horizontal = 12.dp, vertical = 5.dp),
                )
            }
        }
    }
}

/** Compact search input: magnifier, field, clear. */
@Composable
fun LSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
) {
    val p = Orcha.palette
    val shape = RoundedCornerShape(p.radiusButton.dp)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 40.dp)
            .background(p.surface2, shape)
            .border(1.dp, p.border, shape)
            .padding(start = 10.dp, end = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.s),
    ) {
        Icon(OrchaIcons.Search, contentDescription = null, tint = p.muted, modifier = Modifier.size(16.dp))
        Box(Modifier.weight(1f).padding(vertical = 8.dp)) {
            val style = ltype(LType.Body).copy(color = p.text)
            if (value.isEmpty()) {
                Text(placeholder, style = style, color = p.faint, maxLines = 1)
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                textStyle = style,
                cursorBrush = SolidColor(p.accent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = placeholder },
            )
        }
        if (value.isNotEmpty()) {
            Box(
                Modifier
                    .size(40.dp)
                    .clickable(role = Role.Button, onClickLabel = "Clear search") { onValueChange("") }
                    .semantics { contentDescription = "Clear search" },
                contentAlignment = Alignment.Center,
            ) {
                Icon(OrchaIcons.Close, contentDescription = null, tint = p.faint, modifier = Modifier.size(16.dp))
            }
        } else {
            Spacer(Modifier.size(8.dp))
        }
    }
}

// MARK: Identity

/** Stable djb2 hue (0..1) from a name, identical to iOS `LAvatar.hue(for:)`. */
fun lAvatarHue(name: String): Float {
    var h = 5381u
    for (cp in name.lowercase().codePoints()) h = h * 33u + cp.toUInt()
    return (h % 360u).toFloat() / 360f
}

private fun String.codePoints(): List<Int> {
    val out = ArrayList<Int>(length)
    var i = 0
    while (i < length) {
        val cp = Character.codePointAt(this, i)
        out.add(cp)
        i += Character.charCount(cp)
    }
    return out
}

internal fun avatarInitial(name: String): String {
    val t = name.trim()
    if (t.isEmpty()) return "?"
    val cp = Character.codePointAt(t, 0)
    return String(Character.toChars(cp)).uppercase()
}

internal fun presenceKind(status: String?): Int? {
    val s = status?.lowercase()?.takeIf { it.isNotBlank() } ?: return null
    return when (s) {
        "online", "active", "working", "busy", "running", "live", "in_progress" -> 0
        // Same meaning as the status pill: waiting (on a request or on you) is warn, idle is quiet.
        "waiting", "paused", "awaiting_request", "awaiting_human" -> 1
        "error", "failed", "blocked", "stuck" -> 2
        else -> 3
    }
}

/** Round avatar: deterministic hue, initial, ✦ badge for AI, optional presence dot. */
@Composable
fun LAvatar(
    name: String,
    modifier: Modifier = Modifier,
    isAI: Boolean = false,
    size: Dp = 24.dp,
    status: String? = null,
) {
    val p = Orcha.palette
    val hue = lAvatarHue(name) * 360f
    val bg = if (p.isDark) Color.hsv(hue, 0.42f, 0.36f) else Color.hsv(hue, 0.22f, 0.94f)
    val fg = if (p.isDark) Color.hsv(hue, 0.30f, 0.96f) else Color.hsv(hue, 0.70f, 0.42f)
    val density = LocalDensity.current
    // Fixed-size glyph inside a fixed-size circle: divide out the font scale.
    val initialSp = with(density) { (size * 0.46f).toPx() / (this.density * fontScale) }.sp
    val a11y = buildList {
        add(name)
        if (isAI) add("AI agent")
        if (!status.isNullOrBlank()) add(status.replace('_', ' '))
    }.joinToString(", ")
    Box(modifier.size(size).semantics { contentDescription = a11y }) {
        Box(Modifier.size(size).background(bg, CircleShape), contentAlignment = Alignment.Center) {
            Text(
                avatarInitial(name),
                color = fg,
                style = TextStyle(fontFamily = InterFontFamily, fontWeight = FontWeight.SemiBold, fontSize = initialSp, lineHeight = initialSp),
                maxLines = 1,
            )
        }
        if (isAI) {
            val b = maxOf(9.dp, size * 0.44f)
            val badgeSp = with(density) { (b * 0.62f).toPx() / (this.density * fontScale) }.sp
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .offset(x = b * 0.3f, y = -b * 0.3f)
                    .size(b)
                    .background(p.bg, CircleShape)
                    .padding(1.5.dp)
                    .background(p.lPrimaryFill, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text("✦", color = p.lPrimaryText, style = TextStyle(fontSize = badgeSp, lineHeight = badgeSp, fontWeight = FontWeight.Bold))
            }
        }
        presenceKind(status)?.let { k ->
            val dot = when (k) { 0 -> p.ok; 1 -> p.warn; 2 -> p.danger; else -> p.faint }
            val d = maxOf(7.dp, size * 0.32f)
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .offset(x = d * 0.2f, y = d * 0.2f)
                    .size(d)
                    .background(p.bg, CircleShape)
                    .padding(maxOf(1.5.dp, d * 0.22f))
                    .background(dot, CircleShape),
            )
        }
    }
}

// MARK: Status & priority glyphs

/** Web `StatusShape` (portal `components/primitives/StatusIcon.tsx`) — iOS `LStatusGlyph.Kind`. */
enum class LStatusKind {
    Todo, Dashed, Dotted, Progress, Paused, Attention, Review, Done,
    Blocked, Failed, Stopped, Rejected, Escalated, Cancelled, Closed,
    Open, Accepted, Converted, Unknown,
}

/** Web `StatusColor` — iOS `LStatusGlyph.Tone`. */
enum class LStatusTone { Todo, Faint, Progress, Warn, Review, Done, Danger, Muted, Accent }

/** Web `SHAPE` table, plus a few legacy mobile aliases mapped onto the same family. */
fun lStatusStyle(status: String): Pair<LStatusKind, LStatusTone> = when (status.lowercase()) {
    "ready", "todo" -> LStatusKind.Todo to LStatusTone.Todo
    "pending", "not_ready", "backlog", "draft", "queued" -> LStatusKind.Dashed to LStatusTone.Todo
    "idle", "offline" -> LStatusKind.Dotted to LStatusTone.Faint
    "in_progress", "inprogress", "working", "active", "live", "running", "started" -> LStatusKind.Progress to LStatusTone.Progress
    "awaiting_request", "paused", "rate_limited", "waiting" -> LStatusKind.Paused to LStatusTone.Warn
    "awaiting_human" -> LStatusKind.Attention to LStatusTone.Warn
    "needs_verification", "review", "in_review", "needs_review", "verifying" -> LStatusKind.Review to LStatusTone.Review
    "completed", "answered", "verified", "done", "merged", "passed", "resolved" -> LStatusKind.Done to LStatusTone.Done
    "blocked" -> LStatusKind.Blocked to LStatusTone.Danger
    "failed", "error" -> LStatusKind.Failed to LStatusTone.Danger
    "terminated" -> LStatusKind.Stopped to LStatusTone.Danger
    "orphaned" -> LStatusKind.Stopped to LStatusTone.Muted
    "rejected", "refused" -> LStatusKind.Rejected to LStatusTone.Danger
    "escalated" -> LStatusKind.Escalated to LStatusTone.Danger
    "cancelled", "canceled", "archived", "stopped", "killed", "skipped", "expired" -> LStatusKind.Cancelled to LStatusTone.Muted
    "closed" -> LStatusKind.Closed to LStatusTone.Muted
    "open" -> LStatusKind.Open to LStatusTone.Todo
    "accepted" -> LStatusKind.Accepted to LStatusTone.Accent
    "converted_to_task" -> LStatusKind.Converted to LStatusTone.Accent
    else -> LStatusKind.Unknown to LStatusTone.Faint
}

fun lStatusKind(status: String): LStatusKind = lStatusStyle(status).first
fun lStatusTone(status: String): LStatusTone = lStatusStyle(status).second

/** Web `STAT` labels (lib/status.ts); unknown statuses keep their raw value. */
fun lStatusLabel(status: String): String = when (status.lowercase()) {
    "working" -> "Working"
    "in_progress" -> "In progress"
    "idle" -> "Idle"
    "pending" -> "Pending"
    "ready" -> "Ready"
    "blocked" -> "Blocked"
    "awaiting_request" -> "Waiting"
    "awaiting_human" -> "Needs human"
    "needs_verification" -> "Needs verification"
    "completed" -> "Completed"
    "cancelled" -> "Cancelled"
    "failed" -> "Failed"
    "terminated" -> "Terminated"
    "open" -> "Open"
    "accepted" -> "Accepted"
    "rejected" -> "Rejected"
    "answered" -> "Answered"
    "converted_to_task" -> "Converted"
    "closed" -> "Closed"
    "escalated" -> "Escalated"
    "offline" -> "Offline"
    "active" -> "Active"
    "paused" -> "Paused"
    "rate_limited" -> "Rate limited"
    "orphaned" -> "Orphaned"
    "not_ready" -> "On hold"
    "" -> "unknown"
    else -> status
}

private fun OrchaPalette.statusToneColor(tone: LStatusTone): Color = when (tone) {
    LStatusTone.Todo -> lStatusTodo
    LStatusTone.Faint -> lStatusFaint
    LStatusTone.Progress -> lProgress
    LStatusTone.Warn -> warn
    LStatusTone.Review, LStatusTone.Done -> ok
    LStatusTone.Danger -> danger
    LStatusTone.Muted -> lStatusMuted
    LStatusTone.Accent -> accent
}

/**
 * The web `StatusIcon` glyph drawn on a Canvas using the web's 14×14 grid
 * (centre 7,7; ring r 5.5 stroke 1.5; inner pie r 2.6; filled disc r 6.25) — iOS parity.
 */
@Composable
fun LStatusGlyph(status: String, modifier: Modifier = Modifier, size: Dp = 14.dp) {
    val p = Orcha.palette
    val (kind, tone) = lStatusStyle(status)
    val label = lStatusLabel(status)
    val ink = p.statusToneColor(tone)
    val cut = p.bg
    Canvas(modifier.size(size).semantics { contentDescription = label }) {
        val k = this.size.minDimension / 14f
        val c = Offset(7f * k, 7f * k)
        fun pt(x: Float, y: Float) = Offset(x * k, y * k)
        fun ring(width: Float = 1.5f, effect: PathEffect? = null, cap: StrokeCap = StrokeCap.Butt, alpha: Float = 1f) =
            drawCircle(ink, radius = 5.5f * k, center = c, alpha = alpha,
                style = Stroke(width = width * k, cap = cap, pathEffect = effect))
        fun strokes(color: Color, width: Float, vararg segs: List<Offset>) {
            val path = Path()
            for (seg in segs) {
                path.moveTo(seg[0].x, seg[0].y)
                for (o in seg.drop(1)) path.lineTo(o.x, o.y)
            }
            drawPath(path, color, style = Stroke(width = width * k, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
        fun pie(sweep: Float) = drawArc(ink, startAngle = -90f, sweepAngle = sweep, useCenter = true,
            topLeft = pt(7f - 2.6f, 7f - 2.6f), size = Size(5.2f * k, 5.2f * k))
        fun filled(width: Float = 1.5f, vararg segs: List<Offset>) {
            drawCircle(ink, radius = 6.25f * k, center = c)
            strokes(cut, width, *segs)
        }
        when (kind) {
            LStatusKind.Todo -> ring()
            LStatusKind.Dashed -> ring(effect = PathEffect.dashPathEffect(floatArrayOf(2.05f * k, 1.9f * k)))
            LStatusKind.Dotted -> ring(width = 1.6f, cap = StrokeCap.Round,
                effect = PathEffect.dashPathEffect(floatArrayOf(0.01f * k, 2.85f * k)))
            LStatusKind.Progress -> { ring(); pie(180f) }
            LStatusKind.Review -> { ring(); pie(270f) }
            LStatusKind.Paused -> {
                ring()
                strokes(ink, 1.3f, listOf(pt(5.8f, 5.3f), pt(5.8f, 8.7f)), listOf(pt(8.2f, 5.3f), pt(8.2f, 8.7f)))
            }
            LStatusKind.Attention, LStatusKind.Open -> { ring(); drawCircle(ink, radius = 2f * k, center = c) }
            LStatusKind.Done, LStatusKind.Closed ->
                filled(1.5f, listOf(pt(4.4f, 7.2f), pt(6.2f, 9f), pt(9.6f, 5.2f)))
            LStatusKind.Failed ->
                filled(1.5f, listOf(pt(5f, 5f), pt(9f, 9f)), listOf(pt(9f, 5f), pt(5f, 9f)))
            LStatusKind.Cancelled -> filled(1.5f, listOf(pt(4.9f, 9.1f), pt(9.1f, 4.9f)))
            LStatusKind.Converted ->
                filled(1.4f, listOf(pt(4.3f, 7f), pt(9.5f, 7f)), listOf(pt(7.4f, 4.9f), pt(9.5f, 7f), pt(7.4f, 9.1f)))
            LStatusKind.Blocked -> { ring(); strokes(ink, 1.6f, listOf(pt(4.6f, 7f), pt(9.4f, 7f))) }
            LStatusKind.Stopped -> {
                ring()
                drawRoundRect(ink, topLeft = pt(5.1f, 5.1f), size = Size(3.8f * k, 3.8f * k), cornerRadius = CornerRadius(0.8f * k))
            }
            LStatusKind.Rejected -> {
                ring()
                strokes(ink, 1.4f, listOf(pt(5.3f, 5.3f), pt(8.7f, 8.7f)), listOf(pt(8.7f, 5.3f), pt(5.3f, 8.7f)))
            }
            LStatusKind.Escalated -> {
                ring()
                strokes(ink, 1.4f, listOf(pt(7f, 9.4f), pt(7f, 4.8f)), listOf(pt(5f, 6.6f), pt(7f, 4.6f), pt(9f, 6.6f)))
            }
            LStatusKind.Accepted -> {
                ring()
                strokes(ink, 1.4f, listOf(pt(4.9f, 7.1f), pt(6.4f, 8.6f), pt(9.2f, 5.5f)))
            }
            LStatusKind.Unknown -> ring(alpha = 0.6f)
        }
    }
}

/** Priority level (iOS `LPriorityGlyph.Level`): 0 none · 1 low · 2 normal · 3 high · 4 urgent. */
fun lPriorityLevel(priority: Int?): Int = when {
    priority == null -> 0
    priority <= 5 -> 4
    priority <= 20 -> 3
    priority <= 100 -> 2
    else -> 1
}

/** Urgent / High / Normal / Low / No priority. Buckets: ≤5 urgent, ≤20 high, ≤100 normal, else low. */
fun priorityLabel(priority: Int?): String = when (lPriorityLevel(priority)) {
    4 -> "Urgent"
    3 -> "High"
    2 -> "Normal"
    1 -> "Low"
    else -> "No priority"
}

/** Linear priority: three ascending bars lit by level; urgent is an orange rounded square with "!". */
@Composable
fun LPriorityGlyph(priority: Int?, modifier: Modifier = Modifier, size: Dp = 14.dp) {
    val p = Orcha.palette
    val level = lPriorityLevel(priority)
    val label = if (level == 4) "Urgent" else if (level == 0) "No priority" else "${priorityLabel(priority)} priority"
    val lit = p.text2
    val empty = p.lPrioEmpty
    val urgent = p.lUrgent
    val neutral = p.lStatusNeutral
    Canvas(modifier.size(size).semantics { contentDescription = label }) {
        val s = this.size.minDimension
        when (level) {
            4 -> {
                val inset = s * 0.04f
                drawRoundRect(urgent, topLeft = Offset(inset, inset), size = Size(s - inset * 2, s - inset * 2), cornerRadius = CornerRadius(s * 0.22f))
                // "!" drawn as a bar + dot so it stays crisp and font-independent.
                val w = s * 0.14f
                drawRoundRect(Color.White, topLeft = Offset((s - w) / 2f, s * 0.2f), size = Size(w, s * 0.38f), cornerRadius = CornerRadius(w / 2f))
                drawCircle(Color.White, radius = w * 0.6f, center = Offset(s / 2f, s * 0.75f))
            }
            0 -> {
                val bw = s * 0.2f; val bh = s * 0.12f; val gap = s * 0.12f
                val total = bw * 3 + gap * 2
                val x0 = (s - total) / 2f
                repeat(3) { i ->
                    drawRoundRect(neutral, topLeft = Offset(x0 + i * (bw + gap), (s - bh) / 2f), size = Size(bw, bh), cornerRadius = CornerRadius(bh / 2f))
                }
            }
            else -> {
                val bw = s * 0.2f; val gap = s * 0.12f
                val total = bw * 3 + gap * 2
                val x0 = (s - total) / 2f
                val bottom = s * 0.9f
                repeat(3) { i ->
                    val h = s * (0.38f + 0.25f * i)
                    drawRoundRect(
                        if (i < levelBars(level)) lit else empty,
                        topLeft = Offset(x0 + i * (bw + gap), bottom - h.coerceAtMost(bottom)),
                        size = Size(bw, h.coerceAtMost(bottom)),
                        cornerRadius = CornerRadius(s * 0.06f),
                    )
                }
            }
        }
    }
}

/** Bars lit for a level: low 1 · normal 2 · high 3. */
internal fun levelBars(level: Int): Int = level.coerceIn(0, 3)

// MARK: Small labels

/** Small count pill. */
@Composable
fun LBadgeCount(n: Int, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    Box(
        modifier
            .sizeIn(minWidth = 18.dp, minHeight = 18.dp)
            .background(p.surface3, CircleShape)
            .padding(horizontal = 6.dp, vertical = 1.dp)
            .semantics { contentDescription = "$n" },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            if (n > 99) "99+" else "$n",
            style = ltype(LType.Micro).copy(fontWeight = FontWeight.SemiBold),
            color = p.text2,
            maxLines = 1,
        )
    }
}

/** Compact neutral tag; a tint shows as a leading dot (when [dot]) or tints the text. */
@Composable
fun LTag(text: String, modifier: Modifier = Modifier, tint: Color? = null, dot: Boolean = false) {
    val p = Orcha.palette
    val shape = RoundedCornerShape(p.radiusTag.dp)
    Row(
        modifier
            .background(p.surface2, shape)
            .border(1.dp, p.border, shape)
            .padding(horizontal = 6.dp, vertical = 2.dp)
            .semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (dot || tint != null) {
            Box(Modifier.size(6.dp).background(tint ?: p.muted, CircleShape))
        }
        Text(
            text,
            style = ltype(LType.Micro).copy(fontWeight = FontWeight.Medium),
            color = p.text2,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
