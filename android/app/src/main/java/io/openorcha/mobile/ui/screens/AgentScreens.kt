package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
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
import io.openorcha.mobile.data.TurnDto
import io.openorcha.mobile.domain.MobileUx
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
    onOpenTask: (String) -> Unit,
    onOpenRun: (RunDto) -> Unit,
) {
    val p = Orcha.palette
    val agent = state.selectedAgent
    var menuOpen by remember { mutableStateOf(false) }
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
            if (dead) {
                item { Banner(BannerKind.Danger, "Retired${MobileUx.agoLabel(agent.terminatedAt)?.let { " $it" } ?: ""} — this agent no longer wakes.") }
            }
            // header
            item {
                OrchaCard(Modifier.alpha(if (dead) 0.55f else 1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Avatar(agent.alias, human = agent.kind == "human", size = AvatarSize.Lg)
                        Column(Modifier.weight(1f)) {
                            Text(agent.alias, style = MaterialTheme.typography.titleLarge)
                            Text(agent.role ?: if (agent.kind == "human") "Human authority" else "agent", color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        StatusPill(agent.status ?: agent.kind, StatusDomain.Agent)
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        agent.model?.let { MetaTag(it, mono = true) }
                        Spacer(Modifier.weight(1f))
                        Text(MobileUx.agoLabel(agent.lastActive) ?: "", style = MonoSmStyle, color = p.faint)
                    }
                }
            }
            if (agent.kind == "ai" && !dead) {
                item { PrimaryButton("Converse", { onConversation(agent.id) }, Modifier.fillMaxWidth()) }
            }
            // Now (flow 09 §4): current task + live run, or the idle line
            val liveRun = state.agentRuns.firstOrNull { it.status == "running" }
            if (agent.currentTask?.taskId != null || liveRun != null) {
                item { SectionH("Now") }
                agent.currentTask?.taskId?.let { tid ->
                    item {
                        OrchaCard(onClick = { onOpenTask(tid) }) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("▸", color = p.accent, fontWeight = FontWeight.W800)
                                Text(agent.currentTask.title ?: tid, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
                liveRun?.let { run ->
                    item {
                        OrchaCard(onClick = { onOpenRun(run) }, borderColor = p.accentLine) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(run.runId.take(6), style = MonoStyle)
                                StatusPill("running", StatusDomain.Run)
                                MetaTag(run.wakeKind ?: "headless")
                                Spacer(Modifier.weight(1f))
                                Text("streaming", style = MaterialTheme.typography.labelMedium, color = p.accent, modifier = Modifier.alpha(pulseAlpha()))
                            }
                        }
                    }
                }
            }
            // Controls (flow 09 §5) — human-only; disabled once retired
            if (agent.kind == "ai") {
                item { SectionH("Controls", "human authority") }
                item {
                    OrchaCard(Modifier.alpha(if (dead) 0.55f else 1f)) {
                        Row(
                            Modifier.fillMaxWidth().let { if (!dead) it.clickable { modelSheet = true } else it },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text("Model", style = MaterialTheme.typography.titleSmall)
                                Text("Applies at the next wake", style = MaterialTheme.typography.bodyMedium, color = p.muted)
                            }
                            MetaTag(agent.model ?: "default", mono = true)
                        }
                        Row(
                            Modifier.fillMaxWidth().let { if (!dead) it.clickable { wakeSheet = true } else it },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text("Auto-wake", style = MaterialTheme.typography.titleSmall)
                                Text("Clock-driven wakes while idle", style = MaterialTheme.typography.bodyMedium, color = p.muted)
                            }
                            MetaTag(agent.autoWakeIntervalSecs?.let { formatCadence(it) } ?: "Off")
                        }
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("Wake daemon", style = MaterialTheme.typography.titleSmall)
                                Text("Managed from the laptop", style = MaterialTheme.typography.bodyMedium, color = p.muted)
                            }
                            MetaTag(if (agent.wakeEnabled == false) "off" else "on")
                        }
                    }
                }
            }
            // persona preview (full prompt fetch is a follow-up; snapshot preview renders)
            agent.promptPreview?.takeIf { it.isNotBlank() }?.let {
                item { SectionH("Persona") }
                item { OrchaCard { Text(it, color = p.text2, style = MaterialTheme.typography.bodyMedium) } }
            }
            item { SectionH("Recent runs", "${state.agentRuns.size}") }
            if (state.agentRuns.isEmpty()) {
                item { OrchaCard { Text("No recent runs.", color = p.muted) } }
            }
            items(state.agentRuns.take(5), key = { it.runId }) { run ->
                RunRow(run.copy(agentId = run.agentId ?: agent.id, agentAlias = run.agentAlias ?: agent.alias), onOpenRun)
            }
            state.error?.let { item { Banner(BannerKind.Danger, it) } }
        }
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

private fun formatCadence(secs: Int): String = when {
    secs < 3600 -> "Every ${secs / 60}m"
    else -> "Every ${secs / 3600}h"
}

/* Flow 09 A2 — model picker: grouped rows, radio, confirm-on-change. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModelPickerSheet(
    models: List<ModelDto>,
    current: String?,
    busy: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    val p = Orcha.palette
    var picked by remember { mutableStateOf(current) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = p.raised) {
        Column(Modifier.padding(horizontal = 18.dp).padding(bottom = 30.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("MODEL", style = MaterialTheme.typography.labelMedium, color = p.accent)
            Text("Applies at the next wake.", style = MaterialTheme.typography.bodyMedium, color = p.muted)
            models.groupBy { it.runtime ?: it.provider ?: "models" }.forEach { (group, rows) ->
                SectionH(group)
                rows.forEach { m ->
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        RadioButton(
                            selected = picked == m.id,
                            onClick = { picked = m.id },
                            colors = RadioButtonDefaults.colors(selectedColor = p.accent, unselectedColor = p.border2),
                        )
                        Column(Modifier.weight(1f)) {
                            Text(m.name ?: m.id, style = MaterialTheme.typography.titleSmall)
                            Text(m.id, style = MonoSmStyle, color = p.muted)
                        }
                        if (m.id == current) MetaTag("current")
                    }
                }
            }
            val name = models.firstOrNull { it.id == picked }?.let { it.name ?: it.id }
            PrimaryButton(
                if (picked != null && picked != current) "Change to $name" else "Pick a different model",
                { picked?.let(onConfirm) },
                Modifier.fillMaxWidth(),
                enabled = picked != null && picked != current && !busy,
            )
        }
    }
}

/* Flow 09 — auto-wake cadence picker: Off / 5m / 15m / 1h presets. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AutoWakeSheet(
    current: Int?,
    busy: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (Int?) -> Unit,
) {
    val p = Orcha.palette
    val presets = listOf<Pair<String, Int?>>("Off" to null, "5m" to 300, "15m" to 900, "1h" to 3600)
    var picked by remember { mutableStateOf(current) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = p.raised) {
        Column(Modifier.padding(horizontal = 18.dp).padding(bottom = 30.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("AUTO-WAKE", style = MaterialTheme.typography.labelMedium, color = p.accent)
            Text("Wakes the agent on a clock while idle. Off relies on events only.", style = MaterialTheme.typography.bodyMedium, color = p.muted)
            SegControl(
                options = presets.map { it.first } + (
                    if (current != null && presets.none { it.second == current }) listOf(formatCadence(current)) else emptyList()
                    ),
                selected = presets.indexOfFirst { it.second == picked }.let { if (it >= 0) it else presets.size },
                onSelect = { i -> if (i < presets.size) picked = presets[i].second },
            )
            PrimaryButton("Apply", { onConfirm(picked) }, Modifier.fillMaxWidth(), enabled = picked != current && !busy)
        }
    }
}

/* =============================================================================
   Flow 10 — Converse: honest presence, bubbles, composer, end confirm.
   ============================================================================= */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onSend: (String) -> Unit,
    onEnd: () -> Unit,
    onOpenRun: (RunDto) -> Unit,
) {
    val p = Orcha.palette
    val agent = state.selectedAgent
    var draft by remember { mutableStateOf("") }
    var menuOpen by remember { mutableStateOf(false) }
    var confirmEnd by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    LaunchedEffect(state.turns.size) {
        if (state.turns.isNotEmpty()) listState.animateScrollToItem(state.turns.size - 1)
    }
    val working = agent?.status == "working"

    Scaffold(
        containerColor = p.bg,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Avatar(agent?.alias ?: "?", human = false, size = AvatarSize.Sm)
                        Column {
                            Text(agent?.alias ?: "Conversation", style = MaterialTheme.typography.titleMedium)
                            StatusPill(agent?.status ?: "idle", StatusDomain.Agent)
                        }
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } },
                actions = {
                    IconButton(onClick = onRefresh) { Icon(Icons.Rounded.Refresh, "Refresh") }
                    IconButton(onClick = { menuOpen = true }) { Icon(Icons.Rounded.MoreVert, "More") }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("End conversation") }, onClick = { menuOpen = false; confirmEnd = true })
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            if (working && agent?.currentTask != null) {
                Banner(
                    BannerKind.Info,
                    "${agent.alias} is working on a task — replies land when the current step wraps up. Your message queues.",
                    Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }
            LazyColumn(
                modifier = Modifier.weight(1f),
                state = listState,
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (state.turns.isEmpty()) {
                    item {
                        OrchaCard {
                            Text("No conversation yet. Send a message to wake ${agent?.alias ?: "the agent"}.", color = p.muted)
                        }
                    }
                }
                items(state.turns, key = { it.id ?: "${it.seq}" }) { turn ->
                    TurnBubble(turn, state.selectedContainer?.humanAgentId, agent?.alias, onOpenRun, agent?.id)
                }
                if (working) {
                    item {
                        Text(
                            "${agent?.alias ?: "The agent"} is working…",
                            style = MaterialTheme.typography.bodyMedium,
                            color = p.muted,
                            modifier = Modifier.alpha(pulseAlpha()),
                        )
                    }
                }
                state.error?.let { item { Banner(BannerKind.Danger, it) } }
            }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OrchaField(
                    draft, { draft = it },
                    modifier = Modifier.weight(1f),
                    placeholder = "Chat with ${agent?.alias ?: "the agent"}…",
                    maxLines = 4,
                )
                IconButton(
                    onClick = { onSend(draft.trim()); draft = "" },
                    enabled = draft.isNotBlank() && !state.actionInFlight,
                    colors = IconButtonDefaults.iconButtonColors(
                        containerColor = p.accent, contentColor = p.accentInk,
                        disabledContainerColor = p.accent.copy(alpha = 0.4f), disabledContentColor = p.accentInk,
                    ),
                ) { Icon(Icons.AutoMirrored.Rounded.Send, "Send") }
            }
        }
    }
    if (confirmEnd) {
        AlertDialog(
            onDismissRequest = { confirmEnd = false },
            title = { Text("End this conversation?") },
            text = { Text("${agent?.alias ?: "The agent"} goes back to their own work. The transcript stays here.") },
            confirmButton = {
                TextButton(onClick = { confirmEnd = false; onEnd() }) { Text("End conversation", color = p.danger, fontWeight = FontWeight.W700) }
            },
            dismissButton = { TextButton(onClick = { confirmEnd = false }) { Text("Cancel", color = p.accent) } },
            containerColor = p.raised,
        )
    }
}

@Composable
private fun TurnBubble(turn: TurnDto, humanId: String?, agentAlias: String?, onOpenRun: (RunDto) -> Unit, agentId: String?) {
    val p = Orcha.palette
    val mine = turn.authorAgentId == humanId || turn.role == "human"
    when {
        turn.role == "system" -> Bubble(BubbleKind.System, turn.content)
        mine -> Bubble(BubbleKind.Mine, turn.content, time = MobileUx.agoLabel(turn.createdAt))
        else -> Bubble(BubbleKind.Theirs, turn.content, author = agentAlias ?: "agent", time = MobileUx.agoLabel(turn.createdAt)) {
            turn.runId?.let { rid ->
                Text(
                    "Open work log →",
                    style = MaterialTheme.typography.labelMedium,
                    color = p.accent,
                    modifier = Modifier
                        .padding(top = 4.dp)
                        .clickable { onOpenRun(RunDto(runId = rid, agentId = agentId, status = "exited")) },
                )
            }
        }
    }
}
