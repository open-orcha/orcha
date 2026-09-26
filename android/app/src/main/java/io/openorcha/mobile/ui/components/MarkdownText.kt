package io.openorcha.mobile.ui.components

/** Renders [MarkdownLite] blocks with the portal's `.md-*` visual language: heading
 *  spans, mono code chips/blocks, task-list checkboxes, bullets/ordered items, pipe
 *  tables, and tappable links — GitHub bodies stop reading as raw `## Summary` text.
 *  iOS renders these bodies as plain text; this follows the WEB, the richer parity
 *  target the user pointed at. */

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.domain.MarkdownLite
import io.openorcha.mobile.domain.MdBlock
import io.openorcha.mobile.domain.MdSpan
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.MonoFontFamily
import io.openorcha.mobile.ui.theme.Orcha

@Composable
fun MarkdownText(body: String, modifier: Modifier = Modifier) {
    val blocks = remember(body) { MarkdownLite.parse(body) }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        blocks.forEach { block -> MdBlockView(block) }
    }
}

@Composable
private fun MdBlockView(block: MdBlock) {
    val p = Orcha.palette
    when (block) {
        is MdBlock.Code -> Text(
            block.text,
            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = MonoFontFamily, fontSize = 11.5.sp, lineHeight = 17.sp),
            color = p.text2,
            modifier = Modifier
                .fillMaxWidth()
                .background(p.surface2, RoundedCornerShape(8.dp))
                .border(BorderStroke(1.dp, p.border), RoundedCornerShape(8.dp))
                .horizontalScroll(rememberScrollState())
                .padding(10.dp),
        )
        is MdBlock.Heading -> Text(
            annotate(block.spans),
            style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.W700),
            color = p.text,
            modifier = Modifier.padding(top = 4.dp),
        )
        is MdBlock.Task -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (block.checked) {
                Icon(OrchaIcons.Check, null, tint = p.ok, modifier = Modifier.size(14.dp))
            } else {
                androidx.compose.foundation.layout.Box(
                    Modifier.size(12.dp).border(BorderStroke(1.5.dp, p.border2), RoundedCornerShape(3.dp)),
                )
            }
            InlineText(block.spans, color = if (block.checked) p.muted else p.text2)
        }
        is MdBlock.Bullet -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("•", color = p.accent, style = MaterialTheme.typography.bodyMedium)
            InlineText(block.spans, color = p.text2)
        }
        is MdBlock.Ordered -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "${block.num}.",
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = MonoFontFamily, fontSize = 12.sp),
                color = p.accent,
            )
            InlineText(block.spans, color = p.text2)
        }
        is MdBlock.Table -> MdTable(block)
        is MdBlock.Para -> InlineText(block.spans, color = p.text2)
    }
}

@Composable
private fun InlineText(spans: List<MdSpan>, color: androidx.compose.ui.graphics.Color) {
    Text(annotate(spans), style = MaterialTheme.typography.bodyMedium, color = color)
}

@Composable
private fun annotate(spans: List<MdSpan>): AnnotatedString {
    val p = Orcha.palette
    return buildAnnotatedString {
        spans.forEach { s ->
            when {
                s.link != null -> withLink(
                    LinkAnnotation.Url(
                        s.link,
                        TextLinkStyles(style = SpanStyle(color = p.accent, textDecoration = TextDecoration.Underline)),
                    ),
                ) { append(s.text) }
                s.code -> withStyle(
                    SpanStyle(fontFamily = MonoFontFamily, fontSize = 12.sp, color = p.text, background = p.surface3),
                ) { append(s.text) }
                else -> withStyle(
                    SpanStyle(
                        fontWeight = if (s.bold) FontWeight.W700 else null,
                        fontStyle = if (s.italic) FontStyle.Italic else null,
                        color = if (s.bold) p.text else androidx.compose.ui.graphics.Color.Unspecified,
                    ),
                ) { append(s.text) }
            }
        }
    }
}

@Composable
private fun MdTable(table: MdBlock.Table) {
    val p = Orcha.palette
    Column(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .border(BorderStroke(1.dp, p.border), RoundedCornerShape(8.dp))
            .padding(1.dp)
            .width(IntrinsicSize.Max),
    ) {
        Row(Modifier.background(p.surface2)) {
            table.header.forEach { cell ->
                Text(
                    cell, style = MaterialTheme.typography.labelMedium, color = p.text,
                    modifier = Modifier.weight(1f).padding(horizontal = 8.dp, vertical = 6.dp),
                )
            }
        }
        table.rows.forEach { row ->
            Row {
                row.forEach { cell ->
                    Text(
                        annotate(MarkdownLite.inline(cell)),
                        style = MaterialTheme.typography.bodyMedium.copy(fontSize = 12.sp),
                        color = p.text2,
                        modifier = Modifier.weight(1f).padding(horizontal = 8.dp, vertical = 5.dp),
                    )
                }
            }
        }
    }
}
