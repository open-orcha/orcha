package io.openorcha.mobile.ui.screens

/** Renders a compact worker-run summary row shared by task surfaces (Linear timeline row). */

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.RunDto
import io.openorcha.mobile.domain.ActivityCopy
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.providerFor
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.ModelProviderMark
import io.openorcha.mobile.ui.components.LStatusGlyph
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha

/** Maps a worker-run status onto the Linear task-status glyph vocabulary. */
internal fun runGlyphStatus(status: String): String = when (status) {
    "running" -> "in_progress"
    "completed", "succeeded", "ok", "done", "exited", "finished" -> "completed"
    "killed", "failed", "error" -> "failed"
    "stopped", "cancelled" -> "cancelled"
    // Anything else (orphaned, terminated, …) has its own web StatusIcon shape.
    else -> status
}

@Composable
fun RunRow(run: RunDto, onOpenRun: (RunDto) -> Unit) {
    val p = Orcha.palette
    val ago = MobileUx.agoLabel(run.startedAt)
    val subtitle = run.taskTitle ?: run.wakeEvent?.let(ActivityCopy::humanize) ?: "Worker run"
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { onOpenRun(run) }
            .heightIn(min = 52.dp)
            .padding(vertical = 10.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = listOfNotNull(
                    "Run ${run.runId.take(6)}", providerFor(run.runtime)?.label, MobileUx.statusCopy(run.status), subtitle, run.agentAlias, ago,
                ).joinToString(", ")
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        LStatusGlyph(runGlyphStatus(run.status), size = 14.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(run.runId.take(6), style = ltype(LType.Mono), color = p.text)
                ModelProviderMark(run.runtime, size = 12.dp)
                Text(
                    MobileUx.statusCopy(run.status), style = ltype(LType.Meta),
                    color = if (run.status == "running") p.warn else p.text2, maxLines = 1,
                )
            }
            Text(subtitle, style = ltype(LType.Meta), color = p.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        run.agentAlias?.let { LAvatar(it, isAI = true, size = 18.dp) }
        Text(ago ?: "", style = ltype(LType.Micro), color = p.faint)
    }
}
