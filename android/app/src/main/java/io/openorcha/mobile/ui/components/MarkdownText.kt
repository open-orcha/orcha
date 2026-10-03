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
import androidx.compose.ui.platform.LocalUriHandler
import io.openorcha.mobile.domain.PortalLinks
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.domain.MarkdownLite
import io.openorcha.mobile.domain.OrchaSelectors
import io.openorcha.mobile.domain.MdBlock
import io.openorcha.mobile.domain.MdSpan
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.MonoFontFamily
import io.openorcha.mobile.ui.theme.Orcha

/**
 * Linear-skinned markdown: Inter body at 15sp in the primary text colour, muted list
 * markers, mono code on surface2. When [tasks] + [onOpenTask] are given, bare task refs
 * (the portal's GH #140 contract, [OrchaSelectors.taskRefMatches]) become tappable links.
 */
@Composable
fun MarkdownText(
    body: String,
    modifier: Modifier = Modifier,
    tasks: List<TaskDto> = emptyList(),
    onOpenTask: ((String) -> Unit)? = null,
) {
    val blocks = remember(body) { MarkdownLite.parse(body) }
    val linker = if (onOpenTask != null && tasks.isNotEmpty()) TaskLinker(tasks, onOpenTask) else null
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        blocks.forEach { block -> MdBlockView(block, linker) }
    }
}

/** Turns bare task refs inside rendered inline text into tappable links. */
private class TaskLinker(val tasks: List<TaskDto>, val onOpenTask: (String) -> Unit)

@Composable
private fun MdBlockView(block: MdBlock, linker: TaskLinker? = null) {
    val p = Orcha.palette
    when (block) {
        is MdBlock.Code -> Text(
            block.text,
            style = ltype(LType.Mono).copy(lineHeight = 17.sp),
            color = p.text2,
            modifier = Modifier
                .fillMaxWidth()
                .background(p.surface2, RoundedCornerShape(8.dp))
                .border(BorderStroke(1.dp, p.border), RoundedCornerShape(8.dp))
                .horizontalScroll(rememberScrollState())
                .padding(10.dp),
        )
        is MdBlock.Heading -> Text(
            annotate(block.spans, linker),
            style = ltype(LType.Headline),
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
            InlineText(block.spans, color = if (block.checked) p.muted else p.text, linker = linker)
        }
        is MdBlock.Bullet -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("•", color = p.muted, style = ltype(LType.Body))
            InlineText(block.spans, color = p.text, linker = linker)
        }
        is MdBlock.Ordered -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "${block.num}.",
                style = ltype(LType.Body),
                color = p.muted,
            )
            InlineText(block.spans, color = p.text, linker = linker)
        }
        is MdBlock.Table -> MdTable(block)
        is MdBlock.Para -> InlineText(block.spans, color = p.text, linker = linker)
    }
}

@Composable
private fun InlineText(spans: List<MdSpan>, color: androidx.compose.ui.graphics.Color, linker: TaskLinker? = null) {
    Text(annotate(spans, linker), style = ltype(LType.Body), color = color)
}

@Composable
private fun annotate(spans: List<MdSpan>, linker: TaskLinker? = null): AnnotatedString {
    val p = Orcha.palette
    val handler = LocalPortalLinkHandler.current
    val uri = LocalUriHandler.current
    val onOpenTask = linker?.onOpenTask
    val tasks = linker?.tasks.orEmpty()
    val chipStyle = portalChipStyles(p.accent, p.surface2)
    return buildAnnotatedString {
        // Task refs are matched against the text as rendered (chips replace portal paths).
        spans.forEach { s ->
            val portalLink = s.link?.let { PortalLinks.find(it, handler?.baseUrl, tasks).singleOrNull()?.takeIf { m -> m.range.first == 0 && m.range.last == it.length - 1 } }
            when {
                portalLink != null -> withLink(
                    LinkAnnotation.Clickable("md-portal-$length", TextLinkStyles(SpanStyle(color = p.accent))) {
                        openPortalTarget(portalLink.target, portalLink.path, handler, onOpenTask, uri)
                    },
                ) { append(s.text) }
                s.link != null -> withLink(
                    LinkAnnotation.Url(
                        s.link,
                        TextLinkStyles(style = SpanStyle(color = p.accent)),
                    ),
                ) { append(s.text) }
                s.code -> withStyle(
                    SpanStyle(fontFamily = MonoFontFamily, fontSize = 13.sp, color = p.text, background = p.surface2),
                ) { append(s.text) }
                else -> withStyle(
                    SpanStyle(
                        fontWeight = if (s.bold) FontWeight.W700 else null,
                        fontStyle = if (s.italic) FontStyle.Italic else null,
                        color = if (s.bold) p.text else androidx.compose.ui.graphics.Color.Unspecified,
                    ),
                ) {
                    // Portal paths in prose become labelled link chips (web lib/format.ts).
                    var cursor = 0
                    PortalLinks.find(s.text, handler?.baseUrl, tasks).forEach { m ->
                        append(s.text.substring(cursor, m.range.first))
                        withLink(
                            LinkAnnotation.Clickable("md-portal-$length", chipStyle) {
                                openPortalTarget(m.target, m.path, handler, onOpenTask, uri)
                            },
                        ) { append(PORTAL_CHIP_PREFIX + m.label) }
                        cursor = m.range.last + 1
                    }
                    append(s.text.substring(cursor))
                }
            }
        }
        val plain = toAnnotatedString().text
        linker?.let { l ->
            OrchaSelectors.taskRefMatches(plain, l.tasks).forEach { m ->
                addLink(
                    LinkAnnotation.Clickable(
                        "task-${m.task.id}",
                        TextLinkStyles(SpanStyle(color = p.accent, fontWeight = FontWeight.Medium)),
                    ) { l.onOpenTask(m.task.id) },
                    m.range.first, m.range.last + 1,
                )
            }
        }
    }
}

@Composable
private fun MdTable(table: MdBlock.Table) {
    val p = Orcha.palette
    // Size each column to its own content (clamped), not equal shares of the widest cell —
    // equal weights made a 5-column table several screens wide with the extra columns
    // hidden off to the right. Long cells wrap inside their column; wide tables still scroll.
    val columns = maxOf(table.header.size, table.rows.maxOfOrNull { it.size } ?: 0)
    val widths = (0 until columns).map { c ->
        val longest = (listOf(table.header.getOrNull(c).orEmpty()) + table.rows.map { it.getOrNull(c).orEmpty() })
            .maxOf { cell -> MarkdownLite.inline(cell).sumOf { it.text.length } }
        (longest * 7 + 20).coerceIn(36, 220).dp
    }
    Column(
        Modifier
            .fillMaxWidth()
            .border(BorderStroke(1.dp, p.border), RoundedCornerShape(8.dp))
            .horizontalScroll(rememberScrollState())
            .padding(1.dp),
    ) {
        Row(Modifier.background(p.surface2)) {
            widths.forEachIndexed { c, w ->
                Text(
                    table.header.getOrNull(c).orEmpty(), style = ltype(LType.Meta).copy(fontWeight = FontWeight.Medium), color = p.text,
                    modifier = Modifier.width(w).padding(horizontal = 8.dp, vertical = 6.dp),
                )
            }
        }
        table.rows.forEach { row ->
            Row {
                widths.forEachIndexed { c, w ->
                    Text(
                        annotate(MarkdownLite.inline(row.getOrNull(c).orEmpty())),
                        style = ltype(LType.Meta),
                        color = p.text2,
                        modifier = Modifier.width(w).padding(horizontal = 8.dp, vertical = 5.dp),
                    )
                }
            }
        }
    }
}
