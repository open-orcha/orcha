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
import io.openorcha.mobile.domain.PortalLinkMatch
import io.openorcha.mobile.domain.PortalLinks
import io.openorcha.mobile.domain.PortalTarget
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.withLink
import io.openorcha.mobile.domain.OrchaSelectors
import io.openorcha.mobile.ui.theme.MonoFontFamily
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.Orcha


/**
 * In-app destinations for portal link chips (`/tasks?task=…`, `/requests?req=…`,
 * `/agents?agent=…`, or full URLs on the paired base URL). Provided once near the root;
 * a chip whose destination has no handler opens the portal page in the browser.
 */
data class PortalLinkHandler(
    val baseUrl: String?,
    val onTask: ((String) -> Unit)? = null,
    val onRequest: ((String) -> Unit)? = null,
    val onAgent: ((String) -> Unit)? = null,
)

val LocalPortalLinkHandler = staticCompositionLocalOf<PortalLinkHandler?> { null }

/** Routes a portal chip tap: native screen when one is wired, else the portal in the browser. */
internal fun openPortalTarget(
    target: PortalTarget,
    path: String,
    handler: PortalLinkHandler?,
    onOpenTask: ((String) -> Unit)?,
    uri: UriHandler,
) {
    val handled = when (target) {
        is PortalTarget.Task -> (handler?.onTask ?: onOpenTask)?.let { it(target.id); true } ?: false
        is PortalTarget.Request -> handler?.onRequest?.let { it(target.id); true } ?: false
        is PortalTarget.Agent -> handler?.onAgent?.let { it(target.alias); true } ?: false
        is PortalTarget.Page -> false
    }
    if (!handled) {
        val base = handler?.baseUrl?.trimEnd('/') ?: return
        runCatching { uri.openUri(base + path) }
    }
}

/** Chip styling for a portal link inside running text: "↗ Open task · Title". */
internal fun portalChipStyles(accent: Color, fill: Color): TextLinkStyles =
    TextLinkStyles(SpanStyle(color = accent, fontWeight = FontWeight.Medium, background = fill))

internal const val PORTAL_CHIP_PREFIX = "↗ "

/** GH #140: renders [body] as plain text, except any substring resolving to a known task
 *  (see [OrchaSelectors.taskRefMatches]) becomes a tappable span that invokes [onOpenTask],
 *  and any portal path (or URL on the paired server) becomes a labelled link chip that
 *  navigates in-app (web `lib/format.ts` portal chips). */
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
    val handler = LocalPortalLinkHandler.current
    val portal = remember(body, tasks, handler?.baseUrl) { PortalLinks.find(body, handler?.baseUrl, tasks) }
    val taskMatches = if (onOpenTask == null) emptyList() else remember(body, tasks, portal) {
        OrchaSelectors.taskRefMatches(body, tasks).filter { m ->
            portal.none { it.range.first <= m.range.last && m.range.first <= it.range.last }
        }
    }
    if (taskMatches.isEmpty() && portal.isEmpty()) {
        Text(body, modifier = modifier, style = effectiveStyle, maxLines = maxLines, overflow = overflow)
        return
    }
    val p = Orcha.palette
    val uri = LocalUriHandler.current
    val linkStyle = TextLinkStyles(SpanStyle(color = p.accent, fontWeight = FontWeight.Medium))
    val chipStyle = portalChipStyles(p.accent, p.surface2)
    val annotated = buildAnnotatedString {
        var cursor = 0
        val all = (taskMatches.map { it.range to it } + portal.map { it.range to it }).sortedBy { it.first.first }
        all.forEach { (range, m) ->
            if (range.first < cursor) return@forEach
            append(body.substring(cursor, range.first))
            when (m) {
                is PortalLinkMatch -> withLink(
                    LinkAnnotation.Clickable("portal-${range.first}", chipStyle) {
                        openPortalTarget(m.target, m.path, handler, onOpenTask, uri)
                    },
                ) { append(PORTAL_CHIP_PREFIX + m.label) }
                is io.openorcha.mobile.domain.TaskRefMatch -> withLink(
                    LinkAnnotation.Clickable("task-${m.task.id}-${range.first}", linkStyle) { onOpenTask?.invoke(m.task.id) },
                ) { append(body.substring(range.first, range.last + 1)) }
            }
            cursor = range.last + 1
        }
        if (cursor < body.length) append(body.substring(cursor))
    }
    Text(annotated, modifier = modifier, style = effectiveStyle, maxLines = maxLines, overflow = overflow)
}

/* =============================================================================
   The Orcha mobile component kit — one Compose composable per row of the
   component inventory (docs/design/mobile/12-component-inventory.md), pixel
   values from mockups/mobile.css. Screens NEVER restyle these.
   ============================================================================= */

/** `.card` — surface, 1dp border, radius 12, padding 14, 8dp internal rhythm. */
