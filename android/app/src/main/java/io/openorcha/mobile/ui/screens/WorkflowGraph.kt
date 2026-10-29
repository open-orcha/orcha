package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.ui.theme.Orcha

/** Node placement for the read-only graph: column = prerequisite depth, row = order within it. */
internal object WorkflowGraphLayout {
    data class Node(val id: String, val column: Int, val row: Int)

    fun layout(tasks: List<Pair<String, List<String>>>): List<Node> {
        val deps = tasks.toMap()
        val depth = mutableMapOf<String, Int>()
        fun depthOf(id: String, seen: Set<String>): Int = depth[id] ?: run {
            val d = deps[id].orEmpty().filter { it in deps && it !in seen }
                .maxOfOrNull { depthOf(it, seen + id) + 1 } ?: 0
            depth[id] = d
            d
        }
        val rows = mutableMapOf<Int, Int>()
        return tasks.map { (id, _) ->
            val col = depthOf(id, emptySet())
            val row = rows.getOrDefault(col, 0)
            rows[col] = row + 1
            Node(id, col, row)
        }
    }
}

/**
 * W05 graph: the saved graph drawn read-only (pinch-zoom, pan), solid arrows for
 * prerequisites and dotted arrows for loop returns; tapping a node opens its task sheet.
 * Placing nodes and drawing arrows stays on the laptop in v1 (design §1 principle 5).
 */
@Composable
internal fun WorkflowGraph(d: WorkflowDetailDto, onOpen: (String) -> Unit) {
    val p = Orcha.palette
    val nodes = remember(d.tasks) { WorkflowGraphLayout.layout(d.tasks.map { it.id to it.dependsOn }) }
    val measurer = rememberTextMeasurer()
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var selected by remember { mutableStateOf<String?>(null) }
    val transform = rememberTransformableState { zoom, pan, _ ->
        scale = (scale * zoom).coerceIn(0.4f, 3f)
        offset += pan
    }
    val nodeW = 150f
    val nodeH = 52f
    val gapX = 60f
    val gapY = 24f
    /** Node rectangle in px ([k] = density), before the zoom/pan transform. */
    fun rectOf(n: WorkflowGraphLayout.Node, k: Float) =
        Rect(Offset((16f + n.column * (nodeW + gapX)) * k, (16f + n.row * (nodeH + gapY)) * k), Size(nodeW * k, nodeH * k))

    Box(
        Modifier
            .fillMaxWidth()
            .height(360.dp)
            .background(p.surface, RoundedCornerShape(p.radiusCard.dp))
            .clipToBounds()
            .semantics { contentDescription = "Read-only workflow graph with ${d.tasks.size} tasks" },
    ) {
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(360.dp)
                .transformable(transform)
                .pointerInput(nodes, scale, offset) {
                    detectTapGestures { tap ->
                        val local = (tap - offset) / scale
                        nodes.firstOrNull { rectOf(it, density).contains(local) }?.let { selected = it.id; onOpen(it.id) }
                    }
                },
        ) {
            withTransform({
                translate(offset.x, offset.y)
                scale(scale, scale, pivot = Offset.Zero)
            }) {
                val k = density
                val byId = nodes.associateBy { it.id }
                val neighbours = selected?.let { sel ->
                    val t = d.tasks.firstOrNull { it.id == sel }
                    (t?.dependsOn.orEmpty() + d.tasks.filter { sel in it.dependsOn }.map { it.id } + sel).toSet()
                }
                d.tasks.forEach { t ->
                    val to = byId[t.id]?.let { rectOf(it, k) } ?: return@forEach
                    t.dependsOn.forEach { dep ->
                        val from = byId[dep]?.let { rectOf(it, k) } ?: return@forEach
                        drawLine(p.text2, Offset(from.right, from.center.y), Offset(to.left, to.center.y), strokeWidth = 1.5f)
                    }
                    t.routes.filter { it.destination == "return" }.forEach { r ->
                        val back = byId[r.destinationTask]?.let { rectOf(it, k) } ?: return@forEach
                        drawLine(
                            p.accent, Offset(to.center.x, to.bottom), Offset(back.center.x, back.bottom),
                            strokeWidth = 1.5f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)),
                        )
                    }
                }
                nodes.forEach { n ->
                    val t = d.tasks.first { it.id == n.id }
                    val r = rectOf(n, k)
                    val dimmed = neighbours != null && n.id !in neighbours
                    val alpha = if (dimmed) 0.35f else 1f
                    drawRoundRect(p.surface2, r.topLeft, r.size, CornerRadius(8f), alpha = alpha)
                    drawRoundRect(
                        if (n.id == selected) p.accent else p.border, r.topLeft, r.size, CornerRadius(8f),
                        style = Stroke(if (n.id == selected) 2.5f else 1f), alpha = alpha,
                    )
                    val label = measurer.measure(
                        t.title, TextStyle(color = p.text, fontSize = 11.sp), maxLines = 2, overflow = TextOverflow.Ellipsis,
                        constraints = Constraints(maxWidth = ((nodeW - 12f) * k).toInt()),
                    )
                    drawText(label, topLeft = Offset(r.left + 6f * k, r.top + 6f * k), alpha = alpha)
                    val status = measurer.measure(t.displayState.label, TextStyle(color = p.text2, fontSize = 9.sp), maxLines = 1,
                        constraints = Constraints(maxWidth = ((nodeW - 12f) * k).toInt()))
                    drawText(status, topLeft = Offset(r.left + 6f * k, r.bottom - 16f * k), alpha = alpha)
                }
            }
        }
    }
}
