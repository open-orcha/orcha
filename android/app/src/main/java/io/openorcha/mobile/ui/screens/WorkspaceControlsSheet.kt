package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSegmented
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* GH #148 — the execution controls sheet: two orthogonal controls sharing one
   sheet. Notifier (wakes_enabled) is the power switch; Autonomy (autonomy_level)
   is the gearbox. Pausing the notifier never re-shifts the gearbox and vice-versa.
   Linear layout mirrors iOS ContainerControlsSheet.swift. The sheet and its
   confirmation dialogs read Orcha.palette at composition time inside OrchaTheme,
   so a theme switch recolours them instantly. */

private val AUTONOMY_LEVELS = listOf(
    Triple("plan", "Plan-only", "Agents wake and propose — every plan stops for your approval before it executes."),
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

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = p.bg,
        contentColor = p.text,
        scrimColor = Color.Black.copy(alpha = 0.4f),
        shape = RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp),
    ) {
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = LSpace.l)
                .padding(bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(LSpace.xl),
        ) {
            Text(
                "Execution",
                style = ltype(LType.Headline), color = p.text,
                modifier = Modifier.fillMaxWidth().semantics { heading() },
            )
            if (!containerActive) {
                Note("This project is paused or stopped on the server — controls are read-only until it resumes.")
            } else if (!canAct) {
                Note("Change autonomy from the laptop — this phone isn't paired to a person yet.")
            }

            LSection("Execution state") {
                LCard {
                    Column(
                        Modifier.alpha(if (interactive) 1f else 0.6f),
                        verticalArrangement = Arrangement.spacedBy(LSpace.m),
                    ) {
                        LSegmented(
                            listOf(true to "Running", false to "Paused"),
                            wakesEnabled,
                            { if (interactive && it != wakesEnabled) pendingWakes = it },
                        )
                        Consequence(
                            icon = if (wakesEnabled) OrchaIcons.PlayArrow else OrchaIcons.Schedule,
                            tint = if (wakesEnabled) p.ok else p.warn,
                            title = if (wakesEnabled) "Running — agents wake normally" else "Paused — nothing wakes",
                            detail = if (wakesEnabled) {
                                "Agents pick up work at the current autonomy level. Pausing stops new wakes; in-flight work finishes."
                            } else {
                                "No agent starts new work. People and live terminals still work. Resume to pick up where they left off."
                            },
                        )
                    }
                }
            }

            LSection("Autonomy") {
                LCard {
                    Column(
                        Modifier.alpha(if (interactive && wakesEnabled) 1f else 0.6f),
                        verticalArrangement = Arrangement.spacedBy(LSpace.m),
                    ) {
                        LSegmented(
                            AUTONOMY_LEVELS.map { it.first to it.second },
                            autonomyLevel,
                            { if (interactive && it != autonomyLevel) pendingLevel = it },
                        )
                        val current = AUTONOMY_LEVELS.firstOrNull { it.first == autonomyLevel } ?: AUTONOMY_LEVELS.first()
                        Text(current.third, style = ltype(LType.Meta), color = p.muted)
                        if (!wakesEnabled) {
                            Text("Applies when execution is running.", style = ltype(LType.Micro), color = p.faint)
                        }
                    }
                }
            }
        }
    }

    pendingWakes?.let { next ->
        AlertDialog(
            onDismissRequest = { pendingWakes = null },
            title = { Text(if (next) "Resume agent wakes?" else "Pause all agent wakes?", style = ltype(LType.Headline)) },
            text = {
                Text(
                    if (next) {
                        "Agents resume waking at the current autonomy level."
                    } else {
                        "Agents stop waking immediately. In-flight work finishes; nothing new starts. People and live terminals still work."
                    },
                    style = ltype(LType.Meta),
                )
            },
            confirmButton = {
                TextButton(onClick = { pendingWakes = null; onSetWakes(next) }) {
                    Text(if (next) "Resume" else "Pause all wakes", color = if (next) p.accent else p.danger, fontWeight = FontWeight.SemiBold)
                }
            },
            dismissButton = { TextButton(onClick = { pendingWakes = null }) { Text("Cancel", color = p.muted) } },
            containerColor = p.surface,
            titleContentColor = p.text,
            textContentColor = p.text2,
            shape = RoundedCornerShape(12.dp),
        )
    }

    pendingLevel?.let { level ->
        val (_, label, meaning) = AUTONOMY_LEVELS.first { it.first == level }
        val destructive = level == "full"
        AlertDialog(
            onDismissRequest = { pendingLevel = null },
            title = { Text("Switch autonomy to $label?", style = ltype(LType.Headline)) },
            text = { Text(meaning, style = ltype(LType.Meta)) },
            confirmButton = {
                TextButton(onClick = { pendingLevel = null; onSetAutonomy(level) }) {
                    Text("Switch to $label", color = if (destructive) p.danger else p.accent, fontWeight = FontWeight.SemiBold)
                }
            },
            dismissButton = { TextButton(onClick = { pendingLevel = null }) { Text("Cancel", color = p.muted) } },
            containerColor = p.surface,
            titleContentColor = p.text,
            textContentColor = p.text2,
            shape = RoundedCornerShape(12.dp),
        )
    }
}

@Composable
private fun Consequence(icon: ImageVector, tint: Color, title: String, detail: String) {
    val p = Orcha.palette
    Row(horizontalArrangement = Arrangement.spacedBy(LSpace.s), verticalAlignment = Alignment.Top) {
        Icon(icon, null, tint = tint, modifier = Modifier.padding(top = 2.dp).size(16.dp))
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = ltype(LType.BodyEmph), color = p.text)
            Text(detail, style = ltype(LType.Meta), color = p.muted)
        }
    }
}

@Composable
private fun Note(text: String) {
    val p = Orcha.palette
    LCard { Text(text, style = ltype(LType.Meta), color = p.muted) }
}
