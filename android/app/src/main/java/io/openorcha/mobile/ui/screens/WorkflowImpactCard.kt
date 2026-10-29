package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.WorkflowImpactDto
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha

/** "What this action will do" (W07): one row per task with its resulting status and any refusal or blocker lines. */
@Composable
internal fun ImpactCard(impact: WorkflowImpactDto) {
    val p = Orcha.palette
    Column(
        Modifier.fillMaxWidth().background(p.surface, RoundedCornerShape(p.radiusCard.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("What this action will do", style = ltype(LType.BodyEmph), color = p.text)
        if (impact.countsByState.isNotEmpty()) {
            Text(impact.countsByState.entries.joinToString(" · ") { "${it.value} ${it.key.replace('_', ' ')}" }, style = ltype(LType.Meta), color = p.text2)
        }
        if (impact.acceptedRetained.isNotEmpty()) {
            Text("${impact.acceptedRetained.size} accepted results are kept.", style = ltype(LType.Meta), color = p.text2)
        }
        if (impact.workersToStop.isNotEmpty()) {
            Text("Workers to stop: " + impact.workersToStop.joinToString(", ") { it.name ?: "a worker" }, style = ltype(LType.Meta), color = p.warn)
        }
        impact.tasks.forEach { t ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(t.title, style = ltype(LType.Body), color = p.text, modifier = Modifier.weight(1f))
                    LTag(
                        t.resultingStatus.replace('_', ' '),
                        tint = when (t.resultingStatus) {
                            "refused", "blocked" -> p.danger
                            "ready", "takes_turn_alone" -> p.ok
                            else -> null
                        },
                    )
                }
                t.refusal?.let { Text(it.message, style = ltype(LType.Meta), color = p.danger) }
                t.blockers.forEach { Text(it.message, style = ltype(LType.Meta), color = p.text2) }
            }
        }
    }
}
