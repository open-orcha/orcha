package io.openorcha.mobile.ui.screens

/* Objective editor on Home (web settings/ObjectiveRow.tsx): owners and manage_autonomy
   holders add or edit the project's objective; others don't see the control. Saves via
   PUT /api/containers/{cid}/objective; the saved text shows until the next snapshot. */

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.ProjectApi
import io.openorcha.mobile.data.ProjectMembersResponse
import io.openorcha.mobile.domain.ProjectAuthority
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.launch

@Composable
internal fun HomeObjectiveEditor(state: OrchaUiState) {
    val p = Orcha.palette
    val sel = state.selectedContainer ?: return
    val current = state.snapshot?.container?.description?.takeIf { it.isNotBlank() }
    var members by remember(sel.id) { mutableStateOf<ProjectMembersResponse?>(null) }
    var loaded by remember(sel.id) { mutableStateOf(false) }
    LaunchedEffect(sel.id) {
        members = runCatching { ProjectApi.members(sel.baseUrl, sel.id) }.getOrNull()
        loaded = true
    }
    if (!loaded || !ProjectAuthority.can(members, sel.humanAgentId)) return
    var saved by remember(current) { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf(false) }
    val shown = saved ?: current
    Text(
        if (shown == null) "Add an objective…" else "Edit objective",
        style = ltype(LType.Meta), color = p.accent,
        modifier = Modifier
            .heightIn(min = 48.dp)
            .padding(top = 4.dp)
            .clickable(role = Role.Button, onClickLabel = if (shown == null) "Add an objective" else "Edit objective") { editing = true }
            .padding(vertical = 14.dp),
    )
    if (shown != null && saved != null && saved != current) {
        Text("Objective: $shown", style = ltype(LType.Body), color = p.text2)
    }
    if (editing) {
        val scope = rememberCoroutineScope()
        var text by remember { mutableStateOf(shown.orEmpty()) }
        var busy by remember { mutableStateOf(false) }
        var error by remember { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { if (!busy) editing = false },
            title = { Text("Objective") },
            text = {
                Column {
                    Text("What this project is for. Shown on the Overview and above every task.", style = ltype(LType.Meta), color = p.muted)
                    OrchaField(text, { text = it.take(2000) }, placeholder = "What should this project achieve?", minLines = 3, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                    error?.let { Text(it, style = ltype(LType.Meta), color = p.danger, modifier = Modifier.padding(top = 6.dp)) }
                }
            },
            confirmButton = {
                TextButton(enabled = !busy, onClick = {
                    busy = true; error = null
                    scope.launch {
                        runCatching { ProjectApi.setObjective(sel.baseUrl, sel.id, sel.humanAgentId, text.trim().ifBlank { null }) }
                            .onSuccess { saved = it.objective.orEmpty(); editing = false }
                            .onFailure { error = "Couldn't save the objective — " + routineErrorText(it) + "." }
                        busy = false
                    }
                }) { Text(if (busy) "Saving…" else "Save", color = p.accent, fontWeight = FontWeight.SemiBold) }
            },
            dismissButton = { TextButton(onClick = { editing = false }, enabled = !busy) { Text("Cancel", color = p.muted) } },
            containerColor = p.raised,
        )
    }
}
