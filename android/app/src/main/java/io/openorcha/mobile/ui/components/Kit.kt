package io.openorcha.mobile.ui.components

/** Provides shared cards, headings, fields, segmented controls, and button primitives. */

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
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
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

/** Linear card: panel surface, 1dp hairline border, skin card radius (10 on Linear). */
@Composable
fun OrchaCard(
    modifier: Modifier = Modifier,
    borderColor: Color = Orcha.palette.border,
    container: Color = Orcha.palette.surface,
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val cardShape = RoundedCornerShape(Orcha.palette.radiusCard.dp)
    val base = modifier
        .fillMaxWidth()
        .clip(cardShape)
        .background(container, cardShape)
        .border(BorderStroke(1.dp, borderColor), cardShape)
        .let { if (onClick != null) it.clickable(onClick = onClick) else it }
    Column(base.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
}

/** Linear section header: muted 13/500 caption + count, no band, no uppercase. */
@Composable
fun SectionH(title: String, count: String? = null, modifier: Modifier = Modifier, trailing: (@Composable RowScope.() -> Unit)? = null) {
    Row(
        modifier.fillMaxWidth().padding(top = 10.dp, start = 4.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            Modifier.weight(1f).semantics(mergeDescendants = true) { heading() },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(title, style = ltype(LType.Meta).copy(fontWeight = FontWeight.Medium), color = Orcha.palette.text2)
            if (count != null) Text(count, style = ltype(LType.Meta), color = Orcha.palette.muted)
        }
        trailing?.invoke(this)
    }
}

/** Linear tag — compact neutral chip on surface2 with a hairline; mono variant for model ids. */
@Composable
fun MetaTag(text: String, mono: Boolean = false, tint: Color? = null, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    val shape = RoundedCornerShape(p.radiusTag.dp)
    Text(
        text,
        modifier = modifier
            .background(p.surface2, shape)
            .border(BorderStroke(1.dp, p.border), shape)
            .padding(horizontal = 6.dp, vertical = 1.dp),
        style = if (mono) MonoSmStyle.copy(fontSize = 11.sp) else ltype(LType.Micro),
        color = tint ?: p.text2,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/* ---------- buttons (Linear: compact, skin button radius; 48dp hit target) ---------- */

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
    pressedContainer: Color = container.copy(alpha = container.alpha * 0.85f),
) {
    val p = Orcha.palette
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val shape = RoundedCornerShape(p.radiusButton.dp)
    Box(
        modifier
            .defaultMinSize(minHeight = 48.dp)
            .alpha(if (enabled) 1f else 0.45f)
            .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            Modifier
                .heightIn(min = if (small) 28.dp else 34.dp)
                .background(if (pressed) pressedContainer else container, shape)
                .let { if (border != null) it.border(BorderStroke(1.dp, border), shape) else it }
                .padding(horizontal = if (small) 10.dp else 14.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
        ) {
            if (leading != null) {
                CompositionLocalProvider(LocalContentColor provides contentColor) { leading() }
                Spacer(Modifier.width(6.dp))
            }
            Text(
                text,
                style = ltype(if (small) LType.Meta else LType.BodyEmph).copy(fontWeight = FontWeight.Medium),
                color = contentColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, small: Boolean = false, leading: (@Composable () -> Unit)? = null) =
    KitButton(text, onClick, Orcha.palette.lPrimaryFill, Orcha.palette.lPrimaryText, enabled = enabled, small = small, modifier = modifier, leading = leading)

@Composable
fun TonalButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, small: Boolean = false) =
    // Linear: tonal = secondary surface with the accent label (no tinted fill).
    KitButton(text, onClick, Orcha.palette.surface2, Orcha.palette.accent, Orcha.palette.border2, enabled, small, modifier, pressedContainer = Orcha.palette.surface3)

@Composable
fun OkTonalButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, small: Boolean = false) =
    KitButton(text, onClick, Orcha.palette.okSoft, Orcha.palette.ok, Orcha.palette.okLine, enabled, small, modifier, pressedContainer = Orcha.palette.okLine)

@Composable
fun DangerTonalButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, small: Boolean = false) =
    KitButton(text, onClick, Orcha.palette.dangerSoft, Orcha.palette.danger, Orcha.palette.dangerLine, enabled, small, modifier, pressedContainer = Orcha.palette.dangerLine)

@Composable
fun NeutralButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, small: Boolean = false) =
    KitButton(text, onClick, Orcha.palette.surface2, Orcha.palette.text, Orcha.palette.border2, enabled, small, modifier, pressedContainer = Orcha.palette.surface3)

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
    /** Fires on the IME "search"/"done" action (single-line fields only) — lets a
     *  server-backed field (e.g. the PR list's author/search filters) commit on submit
     *  instead of firing a network request per keystroke. No-op for the multi-line
     *  fields that don't pass it. */
    onSearch: (() -> Unit)? = null,
    /** Device-token auth: mask input like iOS's `SecureField` — the access-token
     *  entry fields (sign-in fallback, Settings token update). */
    masked: Boolean = false,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth(),
        label = label?.let { { Text(it) } },
        placeholder = placeholder?.let { { Text(it, color = Orcha.palette.faint) } },
        textStyle = ltype(LType.Body).copy(color = Orcha.palette.text),
        minLines = minLines,
        maxLines = maxLines,
        isError = isError,
        supportingText = supporting?.let { { Text(it, color = if (isError) Orcha.palette.danger else Orcha.palette.muted) } },
        shape = RoundedCornerShape(Orcha.palette.radiusButton.dp),
        singleLine = onSearch != null || masked,
        visualTransformation = if (masked) androidx.compose.ui.text.input.PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = when {
            masked -> androidx.compose.foundation.text.KeyboardOptions(
                imeAction = androidx.compose.ui.text.input.ImeAction.Done,
                keyboardType = androidx.compose.ui.text.input.KeyboardType.Password,
            )
            onSearch != null -> androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Search)
            else -> androidx.compose.foundation.text.KeyboardOptions.Default
        },
        keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = { onSearch?.invoke() }),
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = Orcha.palette.surface2,
            unfocusedContainerColor = Orcha.palette.surface2,
            errorContainerColor = Orcha.palette.surface2,
            focusedBorderColor = Orcha.palette.accentLine,
            unfocusedBorderColor = Orcha.palette.border,
            errorBorderColor = Orcha.palette.danger,
            focusedLabelColor = Orcha.palette.accent,
            unfocusedLabelColor = Orcha.palette.muted,
            cursorColor = Orcha.palette.accent,
        ),
    )
}

/** Linear segmented control: surface2 track, selected option raised on surface3 + hairline. */
@Composable
fun SegControl(options: List<String>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    val track = RoundedCornerShape(p.radiusButton.dp + 2.dp)
    val seg = RoundedCornerShape(p.radiusButton.dp)
    Row(
        modifier
            .fillMaxWidth()
            .background(p.surface2, track)
            .border(BorderStroke(1.dp, p.border), track)
            .padding(2.dp),
    ) {
        options.forEachIndexed { i, opt ->
            val on = i == selected
            Box(
                Modifier
                    .weight(1f)
                    .defaultMinSize(minHeight = 44.dp)
                    .selectable(selected = on, role = Role.Tab) { onSelect(i) }
                    .padding(2.dp)
                    .background(if (on) p.surface3 else Color.Transparent, seg)
                    .border(BorderStroke(1.dp, if (on) p.border2 else Color.Transparent), seg),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    opt,
                    textAlign = TextAlign.Center,
                    style = ltype(LType.Meta).copy(fontWeight = FontWeight.Medium),
                    color = if (on) p.text else p.muted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 6.dp),
                )
            }
        }
    }
}

/* ---------- avatars (`.avatar`: square agent / round human; sm 30 · md 40 · lg 52) ---------- */
