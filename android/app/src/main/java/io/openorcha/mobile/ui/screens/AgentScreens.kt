package io.openorcha.mobile.ui.screens

/** Owns agent detail navigation, menus, dialogs, and sheet coordination. */

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.ModelDto
import io.openorcha.mobile.data.RunDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TurnDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.OrchaSelectors
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.Bubble
import io.openorcha.mobile.ui.components.BubbleKind
import io.openorcha.mobile.ui.components.KVRow
import io.openorcha.mobile.ui.components.MetaTag
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.PrimaryButton
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.SegControl
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill
import io.openorcha.mobile.ui.components.pulseAlpha
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.MonoStyle
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 09 — Agent detail (header, Now, Controls, persona, runs) + pickers.
   Flow 10 — Converse (honest presence, bubbles, composer, end confirm).
   ============================================================================= */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentDetailScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onConversation: (String) -> Unit,
    onModel: (String) -> Unit,
    onAutoWake: (Int?) -> Unit,
    onRetire: () -> Unit,
    onRename: (String) -> Unit,
    onOpenTask: (String) -> Unit,
    onOpenRun: (RunDto) -> Unit,
    onOpenRequests: () -> Unit,
) {
    val p = Orcha.palette
    val agent = state.selectedAgent
    var menuOpen by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var newAlias by remember { mutableStateOf("") }
    var personaOpen by remember { mutableStateOf(false) }
    var confirmRetire by remember { mutableStateOf(false) }
    var modelSheet by remember { mutableStateOf(false) }
    var wakeSheet by remember { mutableStateOf(false) }
    val dead = agent?.status == "terminated" || agent?.terminatedAt != null

    Scaffold(
        containerColor = p.bg,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                title = { Text(agent?.alias ?: "Agent") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } },
                actions = {
                    IconButton(onClick = onRefresh) { Icon(Icons.Rounded.Refresh, "Refresh") }
                    if (agent?.kind == "ai" && !dead) {
                        IconButton(onClick = { menuOpen = true }) { Icon(Icons.Rounded.MoreVert, "More") }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text("Rename") },
                                onClick = { menuOpen = false; newAlias = agent.alias; renaming = true },
                            )
                            DropdownMenuItem(
                                text = { Text("Retire agent…", color = p.danger) },
                                onClick = { menuOpen = false; confirmRetire = true },
                            )
                        }
                    }
                },
            )
        },
    ) { padding ->
        if (agent == null) {
            OrchaCard(Modifier.padding(padding).padding(16.dp)) { Text("Agent not found — refresh the workspace.", color = p.muted) }
            return@Scaffold
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            AgentDetailContent(
                state = state,
                agent = agent,
                dead = dead,
                palette = p,
                personaOpen = personaOpen,
                onTogglePersona = { personaOpen = !personaOpen },
                onOpenModel = { modelSheet = true },
                onOpenWake = { wakeSheet = true },
                onOpenTask = onOpenTask,
                onOpenRun = onOpenRun,
                onOpenRequests = onOpenRequests,
                onConversation = onConversation,
            )
        }
    }

    if (renaming && agent != null) {
        AlertDialog(
            onDismissRequest = { renaming = false },
            title = { Text("Rename ${agent.alias}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OrchaField(newAlias, { newAlias = it }, label = "Alias")
                    Text(
                        "Renaming orphans the laptop's CLI binding for the old alias — the agent re-binds on its next registration.",
                        style = MaterialTheme.typography.bodyMedium, color = p.muted,
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = { renaming = false; onRename(newAlias.trim()) }, enabled = newAlias.isNotBlank()) {
                    Text("Rename", color = p.accent, fontWeight = FontWeight.W700)
                }
            },
            dismissButton = { TextButton(onClick = { renaming = false }) { Text("Cancel", color = p.muted) } },
            containerColor = p.raised,
        )
    }
    if (confirmRetire && agent != null) {
        AlertDialog(
            onDismissRequest = { confirmRetire = false },
            title = { Text("Retire ${agent.alias} — they stop waking.") },
            text = { Text("Their tasks stay assigned and history stays visible. This can't be undone from the app.") },
            confirmButton = {
                TextButton(onClick = { confirmRetire = false; onRetire() }) { Text("Retire", color = p.danger, fontWeight = FontWeight.W700) }
            },
            dismissButton = { TextButton(onClick = { confirmRetire = false }) { Text("Cancel", color = p.accent) } },
            containerColor = p.raised,
        )
    }
    if (modelSheet && agent != null) {
        ModelPickerSheet(
            models = state.models,
            current = agent.model,
            busy = state.actionInFlight,
            onDismiss = { modelSheet = false },
        ) { modelSheet = false; onModel(it) }
    }
    if (wakeSheet && agent != null) {
        AutoWakeSheet(
            current = agent.autoWakeIntervalSecs,
            busy = state.actionInFlight,
            onDismiss = { wakeSheet = false },
        ) { wakeSheet = false; onAutoWake(it) }
    }
}

internal fun formatCadence(secs: Int): String = when {
    secs < 3600 -> "Every ${secs / 60}m"
    else -> "Every ${secs / 3600}h"
}

/* Flow 09 A2 — model picker: grouped rows, radio, confirm-on-change. */
