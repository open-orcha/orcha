package io.openorcha.mobile.ui.screens

/** Owns agent conversation history, presence, composer, and end confirmation. */

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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
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
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill
import io.openorcha.mobile.ui.components.pulseAlpha
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 09 — Agent detail (header, Now, Controls, persona, runs) + pickers.
   Flow 10 — Converse (honest presence, bubbles, composer, end confirm).
   ============================================================================= */

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ConversationScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onSend: (String) -> Unit,
    onEnd: () -> Unit,
    onOpenRun: (RunDto) -> Unit,
    onOpenTask: (String) -> Unit,
    onRetry: () -> String? = { null },
) {
    val p = Orcha.palette
    val agent = state.selectedAgent
    var draft by remember { mutableStateOf("") }
    var menuOpen by remember { mutableStateOf(false) }
    var confirmEnd by remember { mutableStateOf(false) }
    val sendFlow = state.sendFlow
    val listState = rememberLazyListState()
    // issue 4: the web's client-side reveal (conversation.js REVEAL) — render the newest
    // 10 turns, "Load earlier" reveals +20 (the fetch already holds up to 80).
    var reveal by remember(agent?.id) { mutableStateOf(CONV_REVEAL_INITIAL) }
    val visibleTurns = if (state.turns.size > reveal) state.turns.takeLast(reveal) else state.turns
    val imeVisible = WindowInsets.isImeVisible
    // issue 2: keep the newest turns in view when the keyboard opens, a turn lands, or the
    // pending bubble appears/changes (chat send-UX: a new send scrolls the composer into view).
    LaunchedEffect(state.turns.size, imeVisible, sendFlow.showsPendingBubble) {
        val last = listState.layoutInfo.totalItemsCount - 1
        if (last >= 0 && (imeVisible || state.turns.isNotEmpty())) listState.animateScrollToItem(last)
    }
    val working = agent?.status == "working"

    Scaffold(
        containerColor = Color.Transparent,
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
                navigationIcon = { IconButton(onClick = onBack) { Icon(OrchaIcons.ArrowBack, "Back") } },
                actions = {
                    IconButton(onClick = onRefresh) { Icon(OrchaIcons.Refresh, "Refresh") }
                    IconButton(onClick = { menuOpen = true }) { Icon(OrchaIcons.MoreVert, "More") }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("End conversation") }, onClick = { menuOpen = false; confirmEnd = true })
                    }
                },
            )
        },
    ) { padding ->
        // issue 2: consumeWindowInsets stops imePadding re-adding the nav-bar inset the
        // Scaffold padding already applied (with adjustResize, that was the visible gap)
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
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
                    item {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf("What are you working on?", "Any blockers?", "Status update, please").forEach { hint ->
                                AssigneeChip(hint, false) { draft = hint }
                            }
                        }
                    }
                }
                if (state.turns.size > reveal) {
                    item(key = "conv-load-earlier") {
                        TextButton(
                            onClick = { reveal += CONV_REVEAL_STEP },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                "Load earlier · showing ${visibleTurns.size} of ${state.turns.size}",
                                color = p.accent, fontWeight = FontWeight.W700,
                            )
                        }
                    }
                }
                var lastDay: String? = null
                visibleTurns.forEach { turn ->
                    val day = MobileUx.dayKey(turn.createdAt)
                    if (day != null && day != lastDay) {
                        lastDay = day
                        item(key = "day-$day") {
                            Bubble(BubbleKind.System, MobileUx.dayLabel(turn.createdAt) ?: day)
                        }
                    }
                    item(key = turn.id ?: "${turn.seq}") {
                        TurnBubble(turn, state.selectedContainer?.humanAgentId, agent?.alias, onOpenRun, agent?.id, state.snapshot?.tasks.orEmpty(), onOpenTask)
                    }
                }
                // Chat send-UX (iOS `ChatSendFlow` parity): pending bubble, awaiting-reply
                // indicator, and the overdue note — see ConversationTurnBubble.kt.
                chatSendFlowItems(sendFlow, agentAlias = agent?.alias, onRetry = { onRetry()?.let { draft = it } })
                if (working && !sendFlow.showsAwaitingReply) {
                    item {
                        Text(
                            "${agent?.alias ?: "The agent"} is working…",
                            style = MaterialTheme.typography.bodyMedium,
                            color = p.muted,
                            modifier = Modifier.alpha(pulseAlpha()),
                        )
                    }
                }
                if (!sendFlow.isFailed) state.error?.let { item { Banner(BannerKind.Danger, it) } }
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
                    enabled = draft.isNotBlank() && sendFlow.canBegin,
                    colors = IconButtonDefaults.iconButtonColors(
                        containerColor = p.accent, contentColor = p.accentInk,
                        disabledContainerColor = p.accent.copy(alpha = 0.4f), disabledContentColor = p.accentInk,
                    ),
                ) { Icon(OrchaIcons.Send, "Send") }
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
