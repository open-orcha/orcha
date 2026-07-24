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
                    .border(BorderStroke(1.dp, p.border2), RoundedCornerShape(10.dp))
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.W500, letterSpacing = 0.sp, fontSize = 12.sp),
                color = p.muted,
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
                    LinkifiedText(
                        body,
                        tasks,
                        onOpenTask,
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
