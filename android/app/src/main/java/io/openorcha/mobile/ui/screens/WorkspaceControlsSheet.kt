package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.ui.theme.Orcha

/* GH #148 — the container controls sheet: two orthogonal controls sharing one
   sheet. Notifier (wakes_enabled) is the power switch; Autonomy (autonomy_level)
   is the gearbox. Pausing the notifier never re-shifts the gearbox and vice-versa. */

private val AUTONOMY_LEVELS = listOf(
    Triple("plan", "Plan-only", "Agents wake & propose — every plan stops for your approval before it executes."),
    Triple("pr", "Build to PR", "Agents execute approved plans up to an open PR; you still merge."),
    Triple("full", "Full", "Agents may carry approved work to completion without further gates."),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContainerControlsSheet(
    wakesEnabled: Boolean,
    autonomyLevel: String,
    containerActive: Boolean,
    canAct: Boolean,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSetWakes: (Boolean) -> Unit,
    onSetAutonomy: (String) -> Unit,
) {
    val p = Orcha.palette
    val interactive = containerActive && canAct && !busy
    var pendingWakes by remember { mutableStateOf<Boolean?>(null) }
    var pendingLevel by remember { mutableStateOf<String?>(null) }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = p.raised) {
        Column(Modifier.padding(horizontal = 18.dp).padding(bottom = 30.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Container controls", style = MaterialTheme.typography.titleMedium)
            Text("Power switch and gearbox — independent.", style = MaterialTheme.typography.bodyMedium, color = p.muted)

            Spacer(Modifier.padding(top = 10.dp))
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) {
                    Text("Notifier", style = MaterialTheme.typography.titleSmall)
                    Text(
                        if (wakesEnabled) "Running — agents wake normally" else "Paused — no agent wakes",
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (wakesEnabled) p.ok else p.danger,
                    )
                }
                Switch(
                    checked = wakesEnabled,
                    onCheckedChange = { pendingWakes = it },
                    enabled = containerActive && canAct && !busy,
                    colors = SwitchDefaults.colors(checkedTrackColor = p.ok, uncheckedThumbColor = p.danger, uncheckedTrackColor = p.dangerSoft),
                )
            }

            HorizontalDivider(Modifier.padding(vertical = 12.dp), color = p.border)

            Column(Modifier.alpha(if (wakesEnabled || !containerActive) 1f else 0.55f)) {
                Text("Autonomy", style = MaterialTheme.typography.titleSmall)
                Text(
                    if (wakesEnabled) "How far agents go when they act" else "How far agents go when they act — applies when running",
                    style = MaterialTheme.typography.bodyMedium,
                    color = p.muted,
                )
                Spacer(Modifier.padding(top = 8.dp))
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    AUTONOMY_LEVELS.forEachIndexed { i, (level, label, _) ->
                        val on = level == autonomyLevel
                        val tone = when (level) { "plan" -> p.warn; "pr" -> p.info; else -> p.accent }
                        val toneSoft = when (level) { "plan" -> p.warnSoft; "pr" -> p.infoSoft; else -> p.accentSoft }
                        SegmentedButton(
                            selected = on,
                            onClick = { if (level != autonomyLevel) pendingLevel = level },
                            shape = SegmentedButtonDefaults.itemShape(index = i, count = AUTONOMY_LEVELS.size),
                            enabled = interactive,
                            colors = SegmentedButtonDefaults.colors(
                                activeContainerColor = toneSoft, activeContentColor = tone,
                                inactiveContentColor = p.muted,
                            ),
                        ) { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    }
                }
            }

            if (!containerActive) {
                Text(
                    "This Orcha is paused/stopped on the laptop — controls are read-only until it's resumed there.",
                    style = MaterialTheme.typography.bodySmall, color = p.faint, modifier = Modifier.padding(top = 10.dp),
                )
            } else if (!canAct) {
                Text(
                    "Change autonomy from the laptop — this phone isn't paired to a human identity yet.",
                    style = MaterialTheme.typography.bodySmall, color = p.faint, modifier = Modifier.padding(top = 10.dp),
                )
            }
        }
    }

    pendingWakes?.let { next ->
        AlertDialog(
            onDismissRequest = { pendingWakes = null },
            title = { Text(if (next) "Resume agent wakes?" else "Pause all agent wakes?") },
            text = {
                Text(
                    if (next) {
                        "Agents resume waking at the current autonomy level."
                    } else {
                        "Agents stop waking immediately. In-flight work finishes; nothing new starts. Humans & live terminals still work."
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = { pendingWakes = null; onSetWakes(next) }) {
                    Text(if (next) "Resume" else "Pause all wakes", color = if (next) p.accent else p.danger, fontWeight = FontWeight.W700)
                }
            },
            dismissButton = { TextButton(onClick = { pendingWakes = null }) { Text("Cancel", color = p.accent) } },
            containerColor = p.raised,
        )
    }

    pendingLevel?.let { level ->
        val (_, label, meaning) = AUTONOMY_LEVELS.first { it.first == level }
        val destructive = level == "full"
        AlertDialog(
            onDismissRequest = { pendingLevel = null },
            title = { Text("Switch autonomy to $label?") },
            text = { Text(meaning) },
            confirmButton = {
                TextButton(onClick = { pendingLevel = null; onSetAutonomy(level) }) {
                    Text("Switch to $label", color = if (destructive) p.danger else p.accent, fontWeight = FontWeight.W700)
                }
            },
            dismissButton = { TextButton(onClick = { pendingLevel = null }) { Text("Cancel", color = p.accent) } },
            containerColor = p.raised,
        )
    }
}
