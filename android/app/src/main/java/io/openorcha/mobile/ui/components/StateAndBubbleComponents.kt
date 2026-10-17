package io.openorcha.mobile.ui.components

/** Provides loading/error layouts, key-value rows, and conversation bubbles. */

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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
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
        // Linear empty/error state: calm 56dp hairline tile, 16/600 title, muted line.
        Box(
            Modifier
                .size(56.dp)
                .background(p.surface2, RoundedCornerShape(12.dp))
                .border(BorderStroke(1.dp, if (danger) p.dangerLine else p.border), RoundedCornerShape(12.dp)),
            contentAlignment = Alignment.Center,
        ) { glyph() }
        Text(
            title,
            style = ltype(LType.Headline),
            color = if (danger) p.danger else p.text,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { heading() },
        )
        if (sub != null) {
            Text(
                sub, style = ltype(LType.Meta), color = p.muted,
                textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 300.dp),
            )
        }
        content()
    }
}

/* ---------- key-value row (`.kv`) ---------- */

@Composable
fun KVRow(k: String, v: String, mono: Boolean = false, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().heightIn(min = 36.dp).padding(vertical = 8.dp, horizontal = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(k, style = ltype(LType.Meta), color = Orcha.palette.muted)
        Spacer(Modifier.weight(1f))
        Text(
            v,
            style = if (mono) ltype(LType.Mono) else ltype(LType.Meta),
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
    tasks: List<TaskDto> = emptyList(),
    onOpenTask: ((String) -> Unit)? = null,
    trailingContent: (@Composable ColumnScope.() -> Unit)? = null,
) {
    val p = Orcha.palette
    when (kind) {
        BubbleKind.System -> Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            LinkifiedText(
                body,
                tasks,
                onOpenTask,
                modifier = Modifier
                    .background(p.surface2, RoundedCornerShape(p.radiusCard.dp))
                    .border(BorderStroke(1.dp, p.border), RoundedCornerShape(p.radiusCard.dp))
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                style = ltype(LType.Meta),
                color = p.muted,
            )
        }
        else -> {
            val mine = kind == BubbleKind.Mine
            val shape = RoundedCornerShape(
                topStart = 14.dp, topEnd = 14.dp,
                bottomStart = if (mine) 14.dp else 4.dp,
                bottomEnd = if (mine) 4.dp else 14.dp,
            )
            Row(modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
                Column(
                    Modifier
                        .fillMaxWidth(0.82f)
                        .background(if (mine) p.lPrimaryFill else p.surface, shape)
                        .let { if (!mine) it.border(BorderStroke(1.dp, p.border), shape) else it }
                        .padding(horizontal = 13.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    if (!mine && author != null) {
                        Text(author, style = ltype(LType.Meta).copy(fontWeight = FontWeight.SemiBold), color = p.text2)
                    }
                    LinkifiedText(
                        body,
                        tasks,
                        onOpenTask,
                        style = ltype(LType.Body),
                        color = if (mine) p.lPrimaryText else p.text,
                    )
                    if (time != null) {
                        Text(
                            time, style = ltype(LType.Micro).copy(fontWeight = FontWeight.Normal),
                            color = if (mine) p.lPrimaryText.copy(alpha = 0.65f) else p.faint,
                        )
                    }
                    trailingContent?.invoke(this)
                }
            }
        }
    }
}

/* ---------- log line coloring (`.log .ln-*`) ---------- */
