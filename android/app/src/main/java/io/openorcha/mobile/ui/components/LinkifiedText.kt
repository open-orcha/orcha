package io.openorcha.mobile.ui.components

/** Renders task references in prose as tappable links without changing the text contract. */

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

private const val TASK_REF_ANNOTATION_TAG = "task-ref"

/** GH #140: renders [body] as plain text, except any substring resolving to a known task
 *  (see [OrchaSelectors.taskRefMatches]) becomes an underlined, tappable span that invokes
 *  [onOpenTask] with that task's id — the same bare-token contract the portal parses. */
@Composable
fun LinkifiedText(
    body: String,
    tasks: List<TaskDto>,
    onOpenTask: ((String) -> Unit)?,
    modifier: Modifier = Modifier,
    style: TextStyle = LocalTextStyle.current,
    color: Color = Color.Unspecified,
    maxLines: Int = Int.MAX_VALUE,
    overflow: TextOverflow = TextOverflow.Clip,
) {
    val effectiveStyle = if (color != Color.Unspecified) style.copy(color = color) else style
    val matches = if (onOpenTask == null) emptyList() else remember(body, tasks) { OrchaSelectors.taskRefMatches(body, tasks) }
    if (matches.isEmpty()) {
        Text(body, modifier = modifier, style = effectiveStyle, maxLines = maxLines, overflow = overflow)
        return
    }
    val annotated = remember(body, matches) {
        buildAnnotatedString {
            append(body)
            matches.forEach { m ->
                addStyle(
                    SpanStyle(textDecoration = TextDecoration.Underline, fontWeight = FontWeight.SemiBold),
                    m.range.first, m.range.last + 1,
                )
                addStringAnnotation(TASK_REF_ANNOTATION_TAG, m.task.id, m.range.first, m.range.last + 1)
            }
        }
    }
    ClickableText(
        text = annotated,
        modifier = modifier,
        style = effectiveStyle,
        maxLines = maxLines,
        overflow = overflow,
        onClick = { offset ->
            annotated.getStringAnnotations(TASK_REF_ANNOTATION_TAG, offset, offset).firstOrNull()?.let {
                onOpenTask?.invoke(it.item)
            }
        },
    )
}

/* =============================================================================
   The Orcha mobile component kit — one Compose composable per row of the
   component inventory (docs/design/mobile/12-component-inventory.md), pixel
   values from mockups/mobile.css. Screens NEVER restyle these.
   ============================================================================= */

/** `.card` — surface, 1dp border, radius 12, padding 14, 8dp internal rhythm. */
