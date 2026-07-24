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
