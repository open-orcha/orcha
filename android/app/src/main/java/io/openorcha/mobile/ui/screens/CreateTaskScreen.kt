package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.PriorityBand
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.SegControl
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 11 — Create & assign a task. Field order fixed: Title → Description →
   DoD → Assign to → Priority → Advanced (Depends on + Park it). Create disabled
   until Title + DoD are non-blank; dirty form asks before discarding.
   ============================================================================= */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreateTaskScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onCreate: (String, String?, String, String?, Int, List<String>, Boolean) -> Unit,
) {
    val p = Orcha.palette
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var dod by remember { mutableStateOf("") }
    var assignee by remember { mutableStateOf<String?>(null) }
    var band by remember { mutableStateOf(PriorityBand.Normal) }
    var advanced by remember { mutableStateOf(false) }
    var dependsOn by remember { mutableStateOf(setOf<String>()) }
    var parked by remember { mutableStateOf(false) }
    var confirmDiscard by remember { mutableStateOf(false) }
    var triedSubmit by remember { mutableStateOf(false) }

    val dirty = title.isNotBlank() || description.isNotBlank() || dod.isNotBlank() || assignee != null || parked || dependsOn.isNotEmpty()
    val valid = title.isNotBlank() && dod.isNotBlank()
    val agents = state.snapshot?.agents.orEmpty().filter { it.kind == "ai" && it.terminatedAt == null }
    val openTasks = state.snapshot?.tasks.orEmpty().filterNot { it.status in setOf("completed", "cancelled") }
    fun requestClose() { if (dirty) confirmDiscard = true else onBack() }

    Scaffold(
        containerColor = p.bg,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                title = { Text("Create task") },
                navigationIcon = { IconButton(onClick = { requestClose() }) { Icon(Icons.Rounded.Close, "Close") } },
                actions = {
                    TextButton(
                        onClick = {
                            triedSubmit = true
                            if (valid) onCreate(
                                title.trim(),
                                description.trim().ifBlank { null },
                                dod.trim(),
                                assignee,
                                MobileUx.priorityFor(band),
                                dependsOn.toList(),
                                parked,
                            )
                        },
                        enabled = !state.actionInFlight,
                    ) {
                        Text(
                            "Create",
                            color = if (valid) p.accent else p.faint,
                            fontWeight = FontWeight.W800,
                        )
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                OrchaField(
                    title, { title = it }, label = "Title",
                    isError = triedSubmit && title.isBlank(),
                    supporting = if (triedSubmit && title.isBlank()) "A title is required." else null,
                    maxLines = 2,
                )
            }
            item {
                OrchaField(
                    description, { description = it }, label = "Description", minLines = 3,
                    supporting = "Context the agent will read.",
                )
            }
            item {
                OrchaField(
                    dod, { dod = it }, label = "Definition of done", minLines = 3,
                    isError = triedSubmit && dod.isBlank(),
                    supporting = if (triedSubmit && dod.isBlank()) "Required — the agent stops at needs-verification and you check against this."
                    else "How will you know it's done? The agent stops at needs-verification and you check against this.",
                )
            }
            item { SectionH("Assign to", assignee ?: "unassigned") }
            item {
                if (agents.isEmpty()) {
                    OrchaCard { Text("No agents registered yet — the task will start unassigned.", color = p.muted) }
                } else {
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        item { AssigneeChip("Unassigned", assignee == null) { assignee = null } }
                        items(agents, key = { it.id }) { a ->
                            Row(
                                Modifier
                                    .clickable { assignee = a.alias },
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                OrchaCard(
                                    Modifier.padding(0.dp),
                                    borderColor = if (assignee == a.alias) p.accentLine else p.border,
                                    container = if (assignee == a.alias) p.accentSoft else p.surface,
                                    onClick = { assignee = a.alias },
                                ) {
                                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        Avatar(a.alias, human = false, size = AvatarSize.Sm)
                                        Column {
                                            Text(a.alias, style = MaterialTheme.typography.titleSmall)
                                            StatusPill(a.status ?: "idle", StatusDomain.Agent)
                                        }
                                    }
                                    if (a.status == "working") {
                                        Text("working — will pick this up next", style = MaterialTheme.typography.labelSmall, color = p.muted)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            item { SectionH("Priority", "P${MobileUx.priorityFor(band)}") }
            item {
                SegControl(
                    options = listOf("Low", "Normal", "High"),
                    selected = when (band) { PriorityBand.Low -> 0; PriorityBand.High -> 2; else -> 1 },
                    onSelect = { band = when (it) { 0 -> PriorityBand.Low; 2 -> PriorityBand.High; else -> PriorityBand.Normal } },
                )
            }
            item {
                SectionH("Advanced", trailing = {
                    Text(
                        if (advanced) "hide" else "show",
                        style = MaterialTheme.typography.labelMedium, color = p.accent,
                        modifier = Modifier.clickable { advanced = !advanced },
                    )
                })
            }
            if (advanced) {
                item {
                    OrchaCard {
                        Text("Depends on", style = MaterialTheme.typography.titleSmall)
                        Text("This task won't become ready until these complete.", style = MaterialTheme.typography.bodyMedium, color = p.muted)
                        openTasks.take(12).forEach { t ->
                            Row(
                                Modifier.fillMaxWidth().clickable {
                                    dependsOn = if (t.id in dependsOn) dependsOn - t.id else dependsOn + t.id
                                }.padding(vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Text(if (t.id in dependsOn) "☑" else "☐", color = if (t.id in dependsOn) p.accent else p.faint)
                                Text(t.title, style = MaterialTheme.typography.bodyMedium, maxLines = 1, modifier = Modifier.weight(1f))
                                StatusPill(t.status, StatusDomain.Task)
                            }
                        }
                    }
                }
                item {
                    OrchaCard {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("Park it", style = MaterialTheme.typography.titleSmall)
                                Text("The agent won't start yet — task is created pending.", style = MaterialTheme.typography.bodyMedium, color = p.muted)
                            }
                            Switch(
                                checked = parked, onCheckedChange = { parked = it },
                                colors = SwitchDefaults.colors(checkedTrackColor = p.accent, checkedThumbColor = p.accentInk),
                            )
                        }
                    }
                }
            }
            state.error?.let { item { Banner(BannerKind.Danger, "Couldn't create the task — nothing was lost. $it") } }
            item { Spacer(Modifier.padding(bottom = 24.dp)) }
        }
    }

    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            title = { Text("Discard draft?") },
            text = { Text("Your task draft will be lost.") },
            confirmButton = {
                TextButton(onClick = { confirmDiscard = false; onBack() }) { Text("Discard draft", color = p.danger, fontWeight = FontWeight.W700) }
            },
            dismissButton = { TextButton(onClick = { confirmDiscard = false }) { Text("Keep editing", color = p.accent) } },
            containerColor = p.raised,
        )
    }
}
